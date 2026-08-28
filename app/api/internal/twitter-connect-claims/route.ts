import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterRolloutActive } from '@/lib/twitter/feature';
import { isTwitterWorkerAuthorized } from '@/lib/twitter/worker-auth';

export async function POST(request: Request) {
  if (!isTwitterWorkerAuthorized(request, 'connect')) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  if (!isTwitterRolloutActive() || process.env.TWITTER_CONNECT_WORKER_ENABLED !== 'true') return NextResponse.json({ items: [], disabled: true });
  const body = await request.json().catch(() => ({})) as { workerId?: unknown; limit?: unknown; leaseSeconds?: unknown };
  const { data, error } = await createSupabaseAdminClient().rpc('twitter_claim_connection_intents', {
    p_worker_id: typeof body.workerId === 'string' ? body.workerId.slice(0, 255) : 'twitter-connect-worker',
    p_limit: typeof body.limit === 'number' ? body.limit : 1,
    p_lease_seconds: typeof body.leaseSeconds === 'number' ? body.leaseSeconds : 300,
  });
  return error ? NextResponse.json({ error: 'Falha no claim da fila OAuth X.' }, { status: 500 }) : NextResponse.json({ items: data ?? [] });
}
