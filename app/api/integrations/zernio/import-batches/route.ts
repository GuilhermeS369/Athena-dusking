import { after, NextResponse } from 'next/server';

import { parseZernioConnectionImport } from '@/lib/integrations/zernio-connection-import';
import { processZernioConnectionImportBatch } from '@/lib/integrations/zernio-connection-import-runner';
import { zernioApiKeyFingerprint } from '@/lib/integrations/zernio-connection-provisioning';
import { getOrganizationContext } from '@/lib/organizations/server';
import { decryptToken, encryptToken } from '@/lib/security/token-crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { fetchAllRowsByIds } from '@/lib/supabase/chunk';
import { fetchAllRows } from '@/lib/supabase/paginate';

export const dynamic = 'force-dynamic';

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });

  const admin = createSupabaseAdminClient();
  const { data: batches, error } = await admin
    .from('zernio_connection_import_batches')
    .select('id, status, total_count, created_at, started_at, completed_at, zernio_connection_import_items(status, last_error_message, line_number, label)')
    .eq('organization_id', context.activeOrganization.id)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) return NextResponse.json({ error: 'Não foi possível carregar os lotes Zernio.' }, { status: 500 });
  return NextResponse.json({ batches: batches ?? [] });
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (context.activeOrganization.role !== 'admin') return NextResponse.json({ error: 'Somente administradores podem importar contas Zernio.' }, { status: 403 });

  const body = await request.json().catch(() => ({})) as { namesText?: unknown; apiKeysText?: unknown; retryBatchId?: unknown };
  const admin = createSupabaseAdminClient();

  if (typeof body.retryBatchId === 'string') {
    const { data: retryBatch } = await admin
      .from('zernio_connection_import_batches')
      .select('id, organization_id')
      .eq('id', body.retryBatchId)
      .eq('organization_id', context.activeOrganization.id)
      .maybeSingle();
    if (!retryBatch) return NextResponse.json({ error: 'Lote não encontrado.' }, { status: 404 });
    await admin.from('zernio_connection_import_items').update({ status: 'queued', completed_at: null }).eq('batch_id', retryBatch.id).eq('status', 'failed');
    await admin.from('zernio_connection_import_batches').update({ status: 'queued', completed_at: null }).eq('id', retryBatch.id);
    const organizationName = context.activeOrganization.name;
    after(() => processZernioConnectionImportBatch(retryBatch.id, organizationName)
      .catch((error) => console.error('zernio_import_batch_retry_failed', { batchId: retryBatch.id, error })));
    return NextResponse.json({ ok: true, batchId: retryBatch.id, outcome: { status: 'queued' } });
  }

  const draft = parseZernioConnectionImport(
    typeof body.namesText === 'string' ? body.namesText : '',
    typeof body.apiKeysText === 'string' ? body.apiKeysText : '',
  );
  if (!draft.valid) return NextResponse.json({ error: 'Revise as duas colunas antes de salvar.', issues: draft.issues }, { status: 400 });

  const labels = draft.rows.map((row) => row.label);
  const { data: existing } = await fetchAllRowsByIds(
    labels,
    (chunk, from, to) => admin
    .from('zernio_connections')
    .select('label')
    .eq('organization_id', context.activeOrganization!.id)
    .is('deleted_at', null)
    .in('label', chunk)
    .order('label', { ascending: true })
    .range(from, to),
  );
  if (existing.length > 0) {
    return NextResponse.json({ error: 'Há nomes que já possuem uma conta Zernio ativa.', existingLabels: existing.map((connection) => connection.label) }, { status: 409 });
  }

  try {
    const rowsWithFingerprint = draft.rows.map((row) => ({
      ...row,
      apiKeyFingerprint: zernioApiKeyFingerprint(row.apiKey),
    }));
    // Varredura global (todas as organizações) para detectar API key duplicada.
    // Truncada em 1.000, a checagem passa a ter falso negativo: duas organizações
    // cadastram a mesma chave e sincronizam a mesma conta Zernio.
    const { data: activeConnections, error: credentialsError } = await fetchAllRows<{ id: string; organization_id: string; label: string; encrypted_api_key: string; api_key_fingerprint: string | null }>((from, to) => admin
      .from('zernio_connections')
      .select('id, organization_id, label, encrypted_api_key, api_key_fingerprint')
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, to));
    if (credentialsError) throw new Error('Não foi possível verificar se as API keys já estão cadastradas.');

    const activeFingerprintLabels = new Map<string, string>();
    for (const connection of activeConnections) {
      let fingerprint = connection.api_key_fingerprint;
      if (!fingerprint) {
        try {
          fingerprint = zernioApiKeyFingerprint(decryptToken(connection.encrypted_api_key));
        } catch {
          fingerprint = null;
        }
      }
      if (fingerprint) {
        activeFingerprintLabels.set(
          fingerprint,
          connection.organization_id === context.activeOrganization.id
            ? connection.label
            : 'outra organização',
        );
      }
    }
    const credentialIssues = rowsWithFingerprint.flatMap((row) => {
      const existingLabel = activeFingerprintLabels.get(row.apiKeyFingerprint);
      return existingLabel ? [{
        lineNumber: row.lineNumber,
        field: 'apiKey' as const,
        message: `Esta API key já está cadastrada na conta Zernio “${existingLabel}”. Use uma chave diferente.`,
      }] : [];
    });
    if (credentialIssues.length > 0) {
      return NextResponse.json({
        error: 'Importação bloqueada: uma ou mais API keys já estão cadastradas.',
        issues: credentialIssues,
      }, { status: 409 });
    }

    const payload = rowsWithFingerprint.map((row) => ({
      lineNumber: row.lineNumber,
      label: row.label,
      encryptedApiKey: encryptToken(row.apiKey),
      apiKeyFingerprint: row.apiKeyFingerprint,
    }));
    const { data: batchId, error } = await admin.rpc('create_zernio_connection_import_batch', {
      p_organization_id: context.activeOrganization.id,
      p_created_by: context.user.id,
      p_items: payload,
    });
    if (error?.code === '23505' || error?.message?.includes('API key')) {
      return NextResponse.json({
        error: 'Importação bloqueada: uma API key deste lote já está cadastrada ou sendo importada. Atualize a lista e use uma chave diferente.',
      }, { status: 409 });
    }
    if (error || !batchId) throw new Error('Não foi possível enfileirar o lote Zernio.');
    const organizationName = context.activeOrganization.name;
    after(() => processZernioConnectionImportBatch(batchId, organizationName)
      .catch((processError) => console.error('zernio_import_batch_failed', { batchId, error: processError })));
    return NextResponse.json({ ok: true, batchId, outcome: { status: 'queued' } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Não foi possível enfileirar o lote Zernio.' }, { status: 500 });
  }
}
