import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterRolloutActive } from '@/lib/twitter/feature';
import { isTwitterWorkerAuthorized } from '@/lib/twitter/worker-auth';

export async function POST(request: Request) {
  if (!isTwitterWorkerAuthorized(request, 'sync')) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }
  if (
    !isTwitterRolloutActive() ||
    process.env.TWITTER_SYNC_WORKER_ENABLED !== 'true'
  ) {
    return NextResponse.json({ items: [], disabled: true });
  }

  const body = (await request.json().catch(() => ({}))) as {
    workerId?: unknown;
    limit?: unknown;
    leaseSeconds?: unknown;
  };
  const workerId =
    typeof body.workerId === 'string'
      ? body.workerId.slice(0, 255)
      : 'twitter-sync-worker';
  const limit = typeof body.limit === 'number' ? body.limit : 1;
  const leaseSeconds =
    typeof body.leaseSeconds === 'number' ? body.leaseSeconds : 300;
  const { data, error } = await createSupabaseAdminClient().rpc(
    'twitter_claim_sync_jobs',
    {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    },
  );

  return error
    ? NextResponse.json({ error: 'Falha no claim de sync X.' }, { status: 500 })
    : NextResponse.json({ items: data ?? [] });
}
