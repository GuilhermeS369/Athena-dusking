import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterRolloutActive } from '@/lib/twitter/feature';
import { isTwitterNamedWorkerAuthorized } from '@/lib/twitter/worker-auth';

const workerFlags: Record<string, () => boolean> = {
  'athena-twitter-publication-worker': () => process.env.TWITTER_PUBLICATION_WORKER_ENABLED === 'true',
  'athena-twitter-generation-worker': () => process.env.TWITTER_GENERATION_WORKER_ENABLED === 'true',
  'athena-twitter-zernio-sync-worker': () => process.env.TWITTER_SYNC_WORKER_ENABLED === 'true',
  'athena-twitter-analytics-worker': () => process.env.TWITTER_ANALYTICS_ENABLED === 'true' && process.env.TWITTER_ANALYTICS_WORKER_ENABLED === 'true',
  'athena-twitter-webhook-reconcile-worker': () => process.env.TWITTER_RECONCILE_WORKER_ENABLED === 'true',
};

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { workerName?: unknown; workerId?: unknown; metadata?: unknown };
  if (typeof body.workerName !== 'string' || !workerFlags[body.workerName] || typeof body.workerId !== 'string') {
    return NextResponse.json({ error: 'Worker X inválido.' }, { status: 400 });
  }
  if (!isTwitterNamedWorkerAuthorized(request, body.workerName)) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });

  const enabled = isTwitterRolloutActive() && workerFlags[body.workerName]();
  const mode = !enabled ? 'stopped' : body.workerName === 'athena-twitter-publication-worker' && process.env.TWITTER_PUBLICATION_MODE !== 'live' ? 'shadow' : 'live';
  const admin = createSupabaseAdminClient();
  const [{ error }, { data: breaker, error: breakerError }] = await Promise.all([
    admin.rpc('twitter_record_worker_heartbeat', { p_worker_name: body.workerName, p_worker_id: body.workerId, p_mode: mode, p_metadata: body.metadata ?? {} }),
    admin.rpc('twitter_worker_circuit_breaker', { p_scope_key: `worker:${body.workerName}`, p_operation: 'check', p_reason: null, p_threshold: 5, p_cooldown_seconds: 300 }),
  ]);
  if (error || breakerError) return NextResponse.json({ error: 'Falha no heartbeat X.' }, { status: 500 });
  return NextResponse.json({ ok: true, mode, allowed: breaker?.allowed !== false, circuitBreaker: breaker });
}
