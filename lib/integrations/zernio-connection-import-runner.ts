import { decryptToken } from '@/lib/security/token-crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { provisionZernioConnection } from './zernio-connection-provisioning';

type ImportBatchRow = {
  id: string;
  organization_id: string;
  created_by: string;
  status: 'queued' | 'processing' | 'completed' | 'completed_with_errors';
};

type ImportItemRow = {
  id: string;
  line_number: number;
  label: string;
  encrypted_api_key: string;
  api_key_fingerprint: string | null;
  status: 'queued' | 'processing' | 'succeeded' | 'failed';
  attempts: number;
  zernio_connection_id: string | null;
  instagram_slot_limit_snapshot: number;
};

export async function processZernioConnectionImportBatch(batchId: string, organizationName: string) {
  const admin = createSupabaseAdminClient();
  const { data: batch, error: batchError } = await admin
    .from('zernio_connection_import_batches')
    .select('id, organization_id, created_by, status')
    .eq('id', batchId)
    .maybeSingle();
  if (batchError || !batch) throw new Error('Lote Zernio não encontrado.');

  const typedBatch = batch as ImportBatchRow;
  const { data: locked, error: lockError } = await admin.rpc('acquire_zernio_connection_import_lock', {
    p_organization_id: typedBatch.organization_id,
    p_batch_id: typedBatch.id,
    p_locked_by: typedBatch.created_by,
    p_lease_seconds: 300,
  });
  if (lockError) throw new Error('Não foi possível adquirir a trava de importação Zernio.');
  if (!locked) return { status: 'waiting' as const };

  let outcome: { status: 'completed' | 'completed_with_errors' } | null = null;
  try {
    await admin
      .from('zernio_connection_import_batches')
      .update({ status: 'processing', started_at: new Date().toISOString(), completed_at: null })
      .eq('id', typedBatch.id);

    const { data: items, error: itemsError } = await admin
      .from('zernio_connection_import_items')
      .select('id, line_number, label, encrypted_api_key, api_key_fingerprint, status, attempts, zernio_connection_id, instagram_slot_limit_snapshot')
      .eq('batch_id', typedBatch.id)
      .in('status', ['queued', 'failed'])
      .order('line_number');
    if (itemsError) throw new Error('Não foi possível carregar os itens do lote Zernio.');

    for (const item of (items ?? []) as ImportItemRow[]) {
      // Reivindicação condicional impede que uma segunda execução processe a mesma linha.
      const { data: claimed } = await admin
        .from('zernio_connection_import_items')
        .update({ status: 'processing', attempts: item.attempts + 1, processing_started_at: new Date().toISOString(), last_error_message: null })
        .eq('id', item.id)
        .in('status', ['queued', 'failed'])
        .select('id')
        .maybeSingle();
      if (!claimed) continue;

      try {
        const result = await provisionZernioConnection({
          organizationId: typedBatch.organization_id,
          organizationName,
          createdBy: typedBatch.created_by,
          label: item.label,
          apiKey: decryptToken(item.encrypted_api_key),
          apiKeyFingerprint: item.api_key_fingerprint ?? undefined,
          credentialClaimOwner: item.id,
          instagramSlotLimit: item.instagram_slot_limit_snapshot,
        });
        await admin
          .from('zernio_connection_import_items')
          .update({ status: 'succeeded', zernio_connection_id: result.id, completed_at: new Date().toISOString(), last_error_message: result.warning })
          .eq('id', item.id);
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 1000) : 'Não foi possível cadastrar esta conta Zernio.';
        await admin
          .from('zernio_connection_import_items')
          .update({ status: 'failed', last_error_message: message, completed_at: new Date().toISOString() })
          .eq('id', item.id);
      }
    }

    const { data: remaining } = await admin
      .from('zernio_connection_import_items')
      .select('status')
      .eq('batch_id', typedBatch.id);
    const hasFailures = (remaining ?? []).some((item) => item.status === 'failed');
    await admin
      .from('zernio_connection_import_batches')
      .update({ status: hasFailures ? 'completed_with_errors' : 'completed', completed_at: new Date().toISOString() })
      .eq('id', typedBatch.id);
    outcome = { status: hasFailures ? 'completed_with_errors' : 'completed' };
  } finally {
    await admin.rpc('release_zernio_connection_import_lock', {
      p_organization_id: typedBatch.organization_id,
      p_batch_id: typedBatch.id,
      p_locked_by: typedBatch.created_by,
    });
  }

  // Drena a fila persistente de forma sequencial: quem chegou depois não precisa reenviar o lote.
  const { data: nextBatch } = await admin
    .from('zernio_connection_import_batches')
    .select('id')
    .eq('organization_id', typedBatch.organization_id)
    .eq('status', 'queued')
    .neq('id', typedBatch.id)
    .order('created_at')
    .limit(1)
    .maybeSingle();
  if (nextBatch?.id) void processZernioConnectionImportBatch(nextBatch.id, organizationName).catch(() => undefined);
  return outcome ?? { status: 'completed_with_errors' as const };
}
