import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

import { dispatchMediaDeletionJobs } from '@/lib/media/deletion-worker';
import { dispatchMediaGroupAssignmentJobs } from '@/lib/media/group-assignment-worker';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'Falha desconhecida no worker de mídia.';
}

function isAuthorized(request: Request) {
  const configuredSecrets = [process.env.MEDIA_DELETION_WORKER_SECRET, process.env.PUBLICATION_WORKER_SECRET, process.env.CRON_SECRET]
    .filter((value): value is string => Boolean(value));
  const suppliedValues = [
    request.headers.get('x-media-deletion-worker-secret'),
    request.headers.get('x-publication-worker-secret'),
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, ''),
  ].filter((value): value is string => Boolean(value));

  return configuredSecrets.some((expectedSecret) => suppliedValues.some((suppliedSecret) => {
    const expected = Buffer.from(expectedSecret);
    const supplied = Buffer.from(suppliedSecret);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }));
}

// Enquanto a publicação está atrasada o dispatcher de mídia fica parado de
// propósito. Sem registrar o motivo na fila, a galeria mostrava só "0%" e a
// exclusão parecia quebrada — o operador precisa ler por que ainda não começou.
const PAUSED_MESSAGE = 'Exclusão pausada automaticamente enquanto a fila de publicação está atrasada. Ela recomeça sozinha assim que a publicação normalizar.';

async function markPendingJobsPaused(admin: ReturnType<typeof createSupabaseAdminClient>, paused: boolean) {
  const table = admin.from('media_deletion_jobs');
  const query = paused
    ? table.update({ last_error_message: PAUSED_MESSAGE }).eq('status', 'pending').is('last_error_message', null)
    : table.update({ last_error_message: null }).eq('status', 'pending').eq('last_error_message', PAUSED_MESSAGE);
  const { error } = await query;
  if (error) console.warn('Não foi possível registrar a pausa na fila de exclusão de mídia.', { message: error.message });
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });

  const admin = createSupabaseAdminClient();
  const { data: pressure, error: pressureError } = await admin.rpc(
    'get_publication_generation_pressure_signal',
    { p_critical_delay_seconds: 60 },
  );
  if (pressureError) {
    return NextResponse.json({ error: errorMessage(pressureError) }, { status: 503 });
  }
  if (pressure?.criticalDelay === true) {
    await markPendingJobsPaused(admin, true);
    return NextResponse.json({
      paused: true,
      reason: 'critical_publication_delay',
      pressure,
      deletion: { chunks: 0 },
      groupAssignment: { chunks: 0 },
    }, { status: 202 });
  }

  let body: { workerId?: unknown; limit?: unknown; chunkSize?: unknown; leaseSeconds?: unknown; groupAssignmentLimit?: unknown; groupAssignmentChunkSize?: unknown } = {};
  try {
    body = await request.json() as typeof body;
  } catch {
    // O dispatcher pode ser acionado sem corpo por um cron.
  }

  const workerId = typeof body.workerId === 'string' ? body.workerId : undefined;
  const limit = typeof body.limit === 'number' ? body.limit : undefined;
  const chunkSize = typeof body.chunkSize === 'number' ? body.chunkSize : undefined;
  const leaseSeconds = typeof body.leaseSeconds === 'number' ? body.leaseSeconds : undefined;
  const groupAssignmentLimit = typeof body.groupAssignmentLimit === 'number' ? body.groupAssignmentLimit : undefined;
  const groupAssignmentChunkSize = typeof body.groupAssignmentChunkSize === 'number' ? body.groupAssignmentChunkSize : undefined;

  try {
    await markPendingJobsPaused(admin, false);
    const [deletion, groupAssignment] = await Promise.all([
      dispatchMediaDeletionJobs({ workerId, limit, chunkSize, leaseSeconds }),
      dispatchMediaGroupAssignmentJobs({ workerId: workerId ? `${workerId}:groups` : undefined, limit: groupAssignmentLimit, chunkSize: groupAssignmentChunkSize, leaseSeconds }),
    ]);
    return NextResponse.json({ deletion, groupAssignment });
  } catch (error) {
    console.error('Dispatcher de mídia indisponível.', { error: errorMessage(error), details: error });
    return NextResponse.json({ error: errorMessage(error) }, { status: 503 });
  }
}

export async function GET(request: Request) {
  return POST(request);
}

