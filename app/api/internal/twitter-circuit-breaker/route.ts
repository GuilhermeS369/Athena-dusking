import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterNamedWorkerAuthorized } from '@/lib/twitter/worker-auth';
import { recordTwitterSystemEventForOrganizations } from '@/lib/twitter/observability-server';

const workers = new Set([
  'athena-twitter-publication-worker',
  'athena-twitter-preparation-worker',
  'athena-twitter-zernio-sync-worker',
  'athena-twitter-analytics-worker',
  'athena-twitter-webhook-reconcile-worker',
  'athena-twitter-connect-worker',
  'athena-twitter-observability-worker',
]);

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.workerName !== 'string' || !workers.has(body.workerName) || !['success', 'failure'].includes(String(body.operation))) {
    return NextResponse.json({ error: 'Evento de circuit breaker inválido.' }, { status: 400 });
  }
  if (!isTwitterNamedWorkerAuthorized(request, body.workerName)) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });

  const admin = createSupabaseAdminClient();
  const { data: previous } = await admin.from('twitter_circuit_breakers').select('state,failure_count').eq('scope_key', `worker:${body.workerName}`).maybeSingle();
  const { data, error } = await admin.rpc('twitter_worker_circuit_breaker', {
    p_scope_key: `worker:${body.workerName}`,
    p_operation: body.operation,
    p_reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null,
    p_threshold: 5,
    p_cooldown_seconds: 300,
  });
  if (error) return NextResponse.json({ error: 'Falha ao atualizar circuit breaker X.' }, { status: 500 });
  if (body.operation === 'failure' || previous?.state !== 'closed' && (data as { state?: string })?.state === 'closed') {
    const state = (data as { state?: string })?.state ?? (body.operation === 'failure' ? 'degraded' : 'closed');
    await recordTwitterSystemEventForOrganizations(admin, {
      domain: 'worker', severity: state === 'open' ? 'critical' : body.operation === 'failure' ? 'error' : 'info', stage: 'circuit_breaker',
      eventType: body.operation === 'failure' ? 'worker_cycle_failed' : 'circuit_breaker_recovered', stableCode: state === 'open' ? 'circuit_breaker_open' : body.operation === 'failure' ? 'worker_cycle_failed' : 'circuit_breaker_closed',
      message: typeof body.reason === 'string' ? body.reason : `${body.workerName}: circuit breaker ${state}.`, sourceType: 'worker_circuit_breaker', sourceId: `${body.workerName}:${Date.now()}:${body.operation}`,
      workerName: body.workerName, evidence: { previousState: previous?.state ?? null, state, failureCount: (data as { failure_count?: number })?.failure_count ?? null },
    }).catch((observabilityError) => console.error('[twitter-breaker-observability]', observabilityError));
  }
  return NextResponse.json(data);
}
