import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

import { dispatchMediaDeletionJobs } from '@/lib/media/deletion-worker';
import { dispatchMediaGroupAssignmentJobs } from '@/lib/media/group-assignment-worker';

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

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });

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

