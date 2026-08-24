import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';

import { encryptToken, tokenFingerprint } from '@/lib/security/token-crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';
import { parseTwitterZernioImport } from '@/lib/twitter/zernio-import';
import { processTwitterZernioImportBatch } from '@/lib/twitter/zernio-import-runner';
import { TWITTER_ZERNIO_KEY_FINGERPRINT_DOMAIN } from '@/lib/twitter/zernio-connections';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await getTwitterRequestContext('operator');
  if ('response' in auth) return auth.response;
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from('twitter_connection_import_batches')
    .select('id,status,total_count,created_at,started_at,completed_at,twitter_connection_import_items(status,last_error_message,line_number,label,initial_grant_micros_snapshot,twitter_slot_limit_snapshot)')
    .eq('organization_id', auth.context.activeOrganization.id)
    .order('created_at', { ascending: false }).limit(5);
  if (error) return NextResponse.json({ error: 'Não foi possível carregar os lotes Zernio do X.' }, { status: 500 });
  return NextResponse.json({ batches: data ?? [] });
}

export async function POST(request: Request) {
  const auth = await getTwitterRequestContext('admin');
  if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const admin = createSupabaseAdminClient();

  if (typeof body.retryBatchId === 'string') {
    const { data: batch } = await admin.from('twitter_connection_import_batches').select('id')
      .eq('id', body.retryBatchId).eq('organization_id', auth.context.activeOrganization.id).maybeSingle();
    if (!batch) return NextResponse.json({ error: 'Lote não encontrado.' }, { status: 404 });
    await admin.from('twitter_connection_import_items').update({ status: 'queued', completed_at: null })
      .eq('batch_id', batch.id).eq('status', 'failed');
    await admin.from('twitter_connection_import_batches').update({ status: 'queued', completed_at: null }).eq('id', batch.id);
    const outcome = await processTwitterZernioImportBatch(batch.id, auth.context.activeOrganization.name);
    return NextResponse.json({ ok: true, batchId: batch.id, outcome });
  }

  const draft = parseTwitterZernioImport(
    typeof body.namesText === 'string' ? body.namesText : '',
    typeof body.apiKeysText === 'string' ? body.apiKeysText : '',
    typeof body.initialGrantUsd === 'string' ? body.initialGrantUsd : '',
    Number(body.twitterSlotLimit),
  );
  if (!draft.valid || draft.initialGrantMicros === null) {
    return NextResponse.json({ error: 'Revise o lote antes de salvar.', issues: draft.issues }, { status: 400 });
  }

  try {
    const payload = draft.rows.map((row) => ({
      id: randomUUID(), lineNumber: row.lineNumber, label: row.label,
      encryptedApiKey: encryptToken(row.apiKey),
      apiKeyFingerprint: tokenFingerprint(row.apiKey, TWITTER_ZERNIO_KEY_FINGERPRINT_DOMAIN),
      initialGrantMicros: draft.initialGrantMicros,
      twitterSlotLimit: draft.twitterSlotLimit,
    }));
    const { data: batchId, error } = await admin.rpc('twitter_create_connection_import_batch', {
      p_organization_id: auth.context.activeOrganization.id,
      p_created_by: auth.context.user.id,
      p_items: payload,
    });
    if (error?.code === '23505') return NextResponse.json({ error: error.message }, { status: 409 });
    if (error || !batchId) throw new Error('Não foi possível enfileirar o lote Zernio do X.');
    const outcome = await processTwitterZernioImportBatch(batchId, auth.context.activeOrganization.name);
    return NextResponse.json({ ok: true, batchId, outcome }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Não foi possível criar o lote.' }, { status: 500 });
  }
}
