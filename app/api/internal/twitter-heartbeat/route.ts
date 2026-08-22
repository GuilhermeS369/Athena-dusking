import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterNamedWorkerAuthorized } from '@/lib/twitter/worker-auth';

const allowed = new Set([
  'athena-twitter-publication-worker',
  'athena-twitter-generation-worker',
  'athena-twitter-zernio-sync-worker',
  'athena-twitter-analytics-worker',
  'athena-twitter-webhook-reconcile-worker',
]);

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { workerName?: unknown; workerId?: unknown; metadata?: unknown };
  if (typeof body.workerName !== 'string' || !allowed.has(body.workerName) || typeof body.workerId !== 'string') {
    return NextResponse.json({ error: 'Worker X inválido.' }, { status: 400 });
  }
  if (!isTwitterNamedWorkerAuthorized(request, body.workerName)) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });

  const admin = createSupabaseAdminClient();
  const mode = body.workerName.includes('publication') && process.env.TWITTER_PUBLICATION_WORKER_ENABLED === 'true'
    ? process.env.TWITTER_PUBLICATION_MODE === 'live' ? 'live' : 'shadow'
    : 'stopped';
  const [{ error }, { data: breaker, error: breakerError }] = await Promise.all([
    admin.rpc('twitter_record_worker_heartbeat', { p_worker_name: body.workerName, p_worker_id: body.workerId, p_mode: mode, p_metadata: body.metadata ?? {} }),
    admin.rpc('twitter_worker_circuit_breaker', { p_scope_key: `worker:${body.workerName}`, p_operation: 'check', p_reason: null, p_threshold: 5, p_cooldown_seconds: 300 }),
  ]);
  if (error || breakerError) return NextResponse.json({ error: 'Falha no heartbeat X.' }, { status: 500 });
  return NextResponse.json({ ok: true, mode, allowed: breaker?.allowed !== false, circuitBreaker: breaker });
}
