import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

import { resolveAnalyticsPressure } from '@/lib/integrations/analytics-pressure';
import { dispatchProfileAnalyticsRefreshJobs } from '@/lib/integrations/profile-analytics-refresh-worker';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

function integerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

async function activeDirectVpsOrganizations() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('active_profile_analytics_direct_worker_organization_ids', {
    p_stale_seconds: integerEnv('PROFILE_ANALYTICS_VPS_FALLBACK_STALE_SECONDS', 120, 30, 3600),
    p_worker_prefix: process.env.PROFILE_ANALYTICS_VPS_WORKER_PREFIX?.trim() || 'athena-vps-',
  });
  if (error) throw error;
  return Array.isArray(data) ? data.filter((value): value is string => typeof value === 'string') : [];
}

function authorized(request: Request) {
  const configuredSecrets = [
    process.env.PROFILE_ANALYTICS_REFRESH_WORKER_SECRET,
    process.env.PUBLICATION_WORKER_SECRET,
    process.env.MEDIA_DELETION_WORKER_SECRET,
    process.env.CRON_SECRET,
  ]
    .filter((value): value is string => Boolean(value));
  const suppliedValues = [
    request.headers.get('x-profile-analytics-worker-secret'),
    request.headers.get('x-publication-worker-secret'),
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, ''),
  ].filter((value): value is string => Boolean(value));

  return configuredSecrets.some((expectedSecret) => suppliedValues.some((suppliedSecret) => {
    const expected = Buffer.from(expectedSecret);
    const supplied = Buffer.from(suppliedSecret);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }));
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  const body = await request.json().catch(() => ({})) as {
    workerId?: string;
    limit?: number;
    concurrency?: number;
    leaseSeconds?: number;
    shadowEnabled?: boolean;
    shadowLimit?: number;
    shadowConcurrency?: number;
    shadowMaxConnectionLeases?: number;
  };

  try {
    const admin = createSupabaseAdminClient();
    // O analytics não cede mais a fila inteira por atraso de publicação: com o
    // limiar antigo de 60s ele passava ~99,5% do tempo pausado. Ver
    // lib/integrations/analytics-pressure.ts.
    const pressureDecision = await resolveAnalyticsPressure(admin, {
      concurrency: Number.isInteger(body.concurrency) ? body.concurrency! : 10,
      limit: Number.isInteger(body.limit) ? body.limit! : 20,
    });
    if (pressureDecision.mode === 'paused') {
      return NextResponse.json({
        paused: true,
        reason: pressureDecision.reason,
        pressure: pressureDecision.pressure,
      }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
    }
    const excludedOrganizationIds = await activeDirectVpsOrganizations();
    const result = await dispatchProfileAnalyticsRefreshJobs({
      workerId: body.workerId,
      limit: pressureDecision.limit,
      concurrency: pressureDecision.concurrency,
      leaseSeconds: body.leaseSeconds,
      shadowEnabled: body.shadowEnabled,
      shadowLimit: body.shadowLimit,
      shadowConcurrency: body.shadowConcurrency,
      shadowMaxConnectionLeases: body.shadowMaxConnectionLeases,
      excludedOrganizationIds,
    });
    return NextResponse.json({
      ...result,
      publicationPressure: {
        mode: pressureDecision.mode,
        reason: pressureDecision.reason,
        concurrency: pressureDecision.concurrency,
        limit: pressureDecision.limit,
        criticalDelaySeconds: pressureDecision.criticalDelaySeconds,
        oldestDueAt: pressureDecision.pressure?.oldestDueAt ?? null,
      },
      vpsFirst: {
        excludedOrganizationIds,
        fallbackActive: excludedOrganizationIds.length === 0,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Falha no dispatcher de analytics.' }, { status: 500 });
  }
}
