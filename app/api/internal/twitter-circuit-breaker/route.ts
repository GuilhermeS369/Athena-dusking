import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterNamedWorkerAuthorized } from '@/lib/twitter/worker-auth';

const workers = new Set([
  'athena-twitter-publication-worker',
  'athena-twitter-zernio-sync-worker',
  'athena-twitter-analytics-worker',
  'athena-twitter-webhook-reconcile-worker',
]);

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.workerName !== 'string' || !workers.has(body.workerName) || !['success', 'failure'].includes(String(body.operation))) {
    return NextResponse.json({ error: 'Evento de circuit breaker inválido.' }, { status: 400 });
  }
  if (!isTwitterNamedWorkerAuthorized(request, body.workerName)) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });

  const { data, error } = await createSupabaseAdminClient().rpc('twitter_worker_circuit_breaker', {
    p_scope_key: `worker:${body.workerName}`,
    p_operation: body.operation,
    p_reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null,
    p_threshold: 5,
    p_cooldown_seconds: 300,
  });
  return error
    ? NextResponse.json({ error: 'Falha ao atualizar circuit breaker X.' }, { status: 500 })
    : NextResponse.json(data);
}
