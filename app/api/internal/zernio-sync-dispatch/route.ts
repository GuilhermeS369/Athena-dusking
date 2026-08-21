import { NextResponse } from 'next/server';

import { syncZernioInstagramAccounts } from '@/lib/integrations/zernio-accounts';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

function authorized(request: Request) {
  const expected = process.env.ZERNIO_SYNC_WORKER_SECRET || process.env.PUBLICATION_WORKER_SECRET || process.env.CRON_SECRET;
  return Boolean(expected) && request.headers.get('x-zernio-sync-worker-secret') === expected;
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  const input = await request.json().catch(() => ({})) as { workerId?: string; limit?: number; leaseSeconds?: number };
  const workerId = typeof input.workerId === 'string' ? input.workerId.trim() : '';
  if (workerId.length < 3) return NextResponse.json({ error: 'workerId inválido.' }, { status: 400 });
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc('claim_zernio_sync_batch_items', {
    p_worker_id: workerId,
    p_limit: input.limit ?? 3,
    p_lease_seconds: input.leaseSeconds ?? 180,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results = [] as Array<{ itemId: string; status: 'completed' | 'retrying' | 'failed'; synced?: number; conflicts?: number }>;
  for (const item of (data ?? []) as Array<{ item_id: string; batch_id: string; organization_id: string; requested_by: string; zernio_connection_id: string }>) {
    try {
      const result = await syncZernioInstagramAccounts(item.organization_id, item.requested_by, item.zernio_connection_id);
      const { data: completed, error: completeError } = await admin.rpc('complete_zernio_sync_batch_item', {
        p_item_id: item.item_id,
        p_worker_id: workerId,
        p_synced_count: result.synced,
        p_conflict_count: result.conflicts ?? 0,
        p_error_message: null,
      });
      if (completeError) throw completeError;
      await admin.from('zernio_sync_log_items').insert({
        organization_id: item.organization_id,
        batch_id: item.batch_id,
        zernio_connection_id: item.zernio_connection_id,
        status: 'succeeded',
        synced_count: result.synced,
      });
      results.push({ itemId: item.item_id, status: 'completed', synced: result.synced, conflicts: result.conflicts ?? 0 });
      void completed;
    } catch (caught) {
      const message = (caught instanceof Error ? caught.message : 'Falha desconhecida.').slice(0, 1200);
      const { data: completion, error: completionError } = await admin.rpc('complete_zernio_sync_batch_item', {
        p_item_id: item.item_id,
        p_worker_id: workerId,
        p_synced_count: 0,
        p_conflict_count: 0,
        p_error_message: message,
      });
      if (completionError) return NextResponse.json({ error: completionError.message }, { status: 500 });
      await admin.from('zernio_sync_log_items').insert({
        organization_id: item.organization_id,
        batch_id: item.batch_id,
        zernio_connection_id: item.zernio_connection_id,
        status: 'failed',
        error_code: 'connection_sync_failed',
        error_message: message,
      });
      const retrying = Boolean((completion as { completed?: boolean } | null)?.completed === false);
      results.push({ itemId: item.item_id, status: retrying ? 'retrying' : 'failed' });
    }
  }
  return NextResponse.json({ claimed: (data ?? []).length, results });
}
