import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterRolloutActive } from '@/lib/twitter/feature';
import { resolveTwitterHeartbeatWrite } from '@/lib/twitter/heartbeat-cadence';
import { isTwitterNamedWorkerAuthorized } from '@/lib/twitter/worker-auth';
import { recordTwitterSystemEventForOrganizations } from '@/lib/twitter/observability-server';

const workerFlags: Record<string, () => boolean> = {
  'athena-twitter-publication-worker': () => process.env.TWITTER_PUBLICATION_WORKER_ENABLED === 'true',
  'athena-twitter-preparation-worker': () => process.env.TWITTER_PREPARATION_WORKER_ENABLED === 'true',
  'athena-twitter-zernio-sync-worker': () => process.env.TWITTER_SYNC_WORKER_ENABLED === 'true',
  'athena-twitter-analytics-worker': () => process.env.TWITTER_ANALYTICS_ENABLED === 'true' && process.env.TWITTER_ANALYTICS_WORKER_ENABLED === 'true',
  'athena-twitter-webhook-reconcile-worker': () => process.env.TWITTER_RECONCILE_WORKER_ENABLED === 'true',
  'athena-twitter-connect-worker': () => process.env.TWITTER_CONNECT_WORKER_ENABLED === 'true',
  'athena-twitter-observability-worker': () => process.env.TWITTER_OBSERVABILITY_WORKER_ENABLED === 'true',
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
  const { data: previous } = await admin.from('twitter_worker_heartbeats').select('worker_id,mode,last_seen_at').eq('worker_name', body.workerName).maybeSingle();
  const { modeChanged, heartbeatDue } = resolveTwitterHeartbeatWrite({
    previous,
    mode,
    nowMs: Date.now(),
    minWriteIntervalMs: Math.max(0, Number.parseInt(process.env.TWITTER_HEARTBEAT_MIN_WRITE_INTERVAL_MS ?? '25000', 10) || 0),
  });
  const [{ error }, { data: breaker, error: breakerError }] = await Promise.all([
    heartbeatDue
      ? admin.rpc('twitter_record_worker_heartbeat', { p_worker_name: body.workerName, p_worker_id: body.workerId, p_mode: mode, p_metadata: body.metadata ?? {} })
      : Promise.resolve({ error: null }),
    admin.rpc('twitter_worker_circuit_breaker', { p_scope_key: `worker:${body.workerName}`, p_operation: 'check', p_reason: null, p_threshold: 5, p_cooldown_seconds: 300 }),
  ]);
  if (error || breakerError) return NextResponse.json({ error: 'Falha no heartbeat X.' }, { status: 500 });
  // A troca de `worker_id` entre PIDs do mesmo cluster não é mudança de estado: o
  // estado observável é o `mode`. Comparar worker_id disparava um fan-out de evento
  // por organização em praticamente todo ciclo.
  if (modeChanged) {
    await recordTwitterSystemEventForOrganizations(admin, {
      domain: 'worker', severity: 'info', stage: 'heartbeat', eventType: 'worker_state_changed', stableCode: `worker_${mode}`,
      message: `${body.workerName} entrou no modo ${mode}.`, sourceType: 'worker_heartbeat_transition', sourceId: `${body.workerName}:${body.workerId}:${mode}`,
      workerName: body.workerName, workerId: body.workerId, evidence: { previousMode: previous?.mode ?? null, mode },
    }).catch((observabilityError) => console.error('[twitter-heartbeat-observability]', observabilityError));
  }
  return NextResponse.json({ ok: true, mode, allowed: breaker?.allowed !== false, circuitBreaker: breaker });
}
