import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

import { dispatchPublicationQueue } from '@/lib/publications/dispatcher';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type PublicationWorkerHeartbeat = {
  worker_id: string;
  status: string;
  dry_run: boolean;
  last_seen_at: string;
  metadata: Record<string, unknown> | null;
};

const activePrimaryStatuses = new Set(['starting', 'idle', 'dispatching', 'processing']);
const directPrimaryModes = new Set(['direct', 'direct-dispatch']);

function integerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'Falha desconhecida no worker de publicação.';
}

function isAuthorized(request: Request) {
  const configuredSecrets = [process.env.PUBLICATION_WORKER_SECRET, process.env.CRON_SECRET]
    .filter((value): value is string => Boolean(value));
  const suppliedValues = [
    request.headers.get('x-publication-worker-secret'),
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, ''),
  ].filter((value): value is string => Boolean(value));

  return configuredSecrets.some((expectedSecret) => suppliedValues.some((suppliedSecret) => {
    const expected = Buffer.from(expectedSecret);
    const supplied = Buffer.from(suppliedSecret);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }));
}

function heartbeatMode(heartbeat: PublicationWorkerHeartbeat) {
  const metadata = heartbeat.metadata;
  const mode = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata.mode
    : null;
  return typeof mode === 'string' ? mode : null;
}

function isActivePrimaryWorker(heartbeat: PublicationWorkerHeartbeat, now: number, staleAfterSeconds: number, primaryWorkerIdPrefix: string) {
  const lastSeenAt = new Date(heartbeat.last_seen_at).getTime();
  if (Number.isNaN(lastSeenAt)) return false;
  if ((now - lastSeenAt) / 1000 > staleAfterSeconds) return false;
  if (primaryWorkerIdPrefix && !heartbeat.worker_id.startsWith(primaryWorkerIdPrefix)) return false;
  if (!activePrimaryStatuses.has(heartbeat.status)) return false;
  if (heartbeat.dry_run) return false;
  return directPrimaryModes.has(heartbeatMode(heartbeat) ?? '');
}

async function loadActivePrimaryWorker() {
  const staleAfterSeconds = integerEnv('PUBLICATION_DISPATCH_FALLBACK_STALE_SECONDS', 120, 30, 900);
  const primaryWorkerIdPrefix = process.env.PUBLICATION_PRIMARY_WORKER_ID_PREFIX ?? 'athena-vps-';
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from('publication_worker_heartbeats')
    .select('worker_id, status, dry_run, last_seen_at, metadata')
    .eq('worker_kind', 'publication')
    .order('last_seen_at', { ascending: false })
    .limit(20);

  if (error) throw error;

  const now = Date.now();
  const activeWorker = ((data ?? []) as PublicationWorkerHeartbeat[])
    .find((heartbeat) => isActivePrimaryWorker(heartbeat, now, staleAfterSeconds, primaryWorkerIdPrefix));

  return { activeWorker, staleAfterSeconds, primaryWorkerIdPrefix };
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });

  let body: { workerId?: unknown; limit?: unknown; leaseSeconds?: unknown } = {};
  try {
    body = await request.json() as typeof body;
  } catch {
    // O dispatcher pode ser acionado sem corpo por um cron.
  }

  const workerId = typeof body.workerId === 'string' ? body.workerId : undefined;
  const limit = typeof body.limit === 'number' ? body.limit : undefined;
  const leaseSeconds = typeof body.leaseSeconds === 'number' ? body.leaseSeconds : undefined;

  try {
    const { activeWorker, staleAfterSeconds, primaryWorkerIdPrefix } = await loadActivePrimaryWorker();
    if (activeWorker) {
      return NextResponse.json({
        skipped: true,
        claimed: 0,
        reason: 'vps_publication_worker_active',
        fallback: false,
        staleAfterSeconds,
        primaryWorkerIdPrefix,
        primaryWorker: {
          workerId: activeWorker.worker_id,
          status: activeWorker.status,
          mode: heartbeatMode(activeWorker),
          lastSeenAt: activeWorker.last_seen_at,
        },
      });
    }

    return NextResponse.json(await dispatchPublicationQueue({ workerId, limit, leaseSeconds }));
  } catch (error) {
    console.error('Dispatcher de publicação indisponível.', {
      error: errorMessage(error),
      details: error,
    });
    return NextResponse.json({ error: errorMessage(error) }, { status: 503 });
  }
}

// Vercel Cron chama endpoints usando GET. O POST continua disponível para
// execução manual por um worker externo com o mesmo segredo.
export async function GET(request: Request) {
  return POST(request);
}
