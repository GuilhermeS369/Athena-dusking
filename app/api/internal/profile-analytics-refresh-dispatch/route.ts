import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

import { dispatchProfileAnalyticsRefreshJobs } from '@/lib/integrations/profile-analytics-refresh-worker';

export const dynamic = 'force-dynamic';

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
  const body = await request.json().catch(() => ({})) as { workerId?: string; limit?: number; concurrency?: number; leaseSeconds?: number };

  try {
    const result = await dispatchProfileAnalyticsRefreshJobs({
      workerId: body.workerId,
      limit: body.limit,
      concurrency: body.concurrency,
      leaseSeconds: body.leaseSeconds,
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Falha no dispatcher de analytics.' }, { status: 500 });
  }
}
