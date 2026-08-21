import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

type OperationalHealthRow = {
  health_status: 'ok' | 'degraded' | 'unhealthy' | string;
  organization_count: number;
  active_publication_items: number;
  expired_leases: number;
  due_retries: number;
  overdue_publications: number;
  max_lag_seconds: number;
  registered_workers: number;
  active_workers: number;
  stale_workers: number;
  worker_errors: number;
  open_async_jobs: number;
  async_pending_units: number;
  async_failed_units: number;
  old_async_jobs: number;
  published_last_hour: number;
  published_last_24h: number;
  failed_last_hour: number;
  critical_signals: number;
  warning_signals: number;
};

function authorized(request: Request) {
  const configuredSecrets = [process.env.PUBLICATION_WORKER_SECRET, process.env.MEDIA_DELETION_WORKER_SECRET, process.env.CRON_SECRET]
    .filter((value): value is string => Boolean(value));
  const suppliedValues = [
    request.headers.get('x-publication-worker-secret'),
    request.headers.get('x-media-deletion-worker-secret'),
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, ''),
  ].filter((value): value is string => Boolean(value));

  return configuredSecrets.some((expectedSecret) => suppliedValues.some((suppliedSecret) => {
    const expected = Buffer.from(expectedSecret);
    const supplied = Buffer.from(suppliedSecret);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }));
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });

  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.rpc('get_global_operational_health', {
      p_stale_after_seconds: 120,
      p_queue_lag_warning_seconds: 300,
      p_async_job_age_warning_seconds: 1800,
    });

    if (error) return NextResponse.json({ error: 'Não foi possível consultar a saúde operacional.' }, { status: 500 });

    const health = ((data ?? []) as OperationalHealthRow[])[0];
    if (!health) return NextResponse.json({ error: 'Resumo operacional indisponível.' }, { status: 503 });

    const httpStatus = health.health_status === 'unhealthy' ? 503 : 200;
    return NextResponse.json({
      ok: health.health_status !== 'unhealthy',
      status: health.health_status,
      organizations: health.organization_count,
      queue: {
        activeItems: health.active_publication_items,
        expiredLeases: health.expired_leases,
        dueRetries: health.due_retries,
        overdue: health.overdue_publications,
        maxLagSeconds: health.max_lag_seconds,
      },
      workers: {
        registered: health.registered_workers,
        active: health.active_workers,
        stale: health.stale_workers,
        errors: health.worker_errors,
      },
      asyncJobs: {
        open: health.open_async_jobs,
        pendingUnits: health.async_pending_units,
        failedUnits: health.async_failed_units,
        oldJobs: health.old_async_jobs,
      },
      throughput: {
        publishedLastHour: health.published_last_hour,
        publishedLast24h: health.published_last_24h,
        failedLastHour: health.failed_last_hour,
      },
      signals: {
        critical: health.critical_signals,
        warning: health.warning_signals,
      },
      checkedAt: new Date().toISOString(),
    }, { status: httpStatus, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Falha no health check operacional consolidado.', error);
    return NextResponse.json({ error: 'Health check operacional não configurado.' }, { status: 503 });
  }
}
