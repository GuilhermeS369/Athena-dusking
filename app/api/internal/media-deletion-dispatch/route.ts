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
  // O portao olha so o que NAO comecou a sair. Um item ja aceito pelo provedor
  // esta esperando a Meta processar o video -- o p50 de `execute_at` ate
  // `published_at` e de 4,4 minutos, contra 24 segundos para COMECAR a enviar.
  // Com o limiar de 60s, `criticalDelay` fica praticamente sempre ligado
  // durante uma onda, e a exclusao de midia nunca roda: foi o que o operador
  // encontrou em 06/09, com a galeria recusando apagar por "fila atrasada"
  // enquanto a fila publicava 828 por hora sem uma falha.
  //
  // `overdueUnstarted` e o sinal certo: trabalho que deveria ter saido e que
  // ninguem encostou. Esse sim indica fila travada, e ai faz sentido nao gastar
  // capacidade apagando midia.
  const publicationDelayed = pressure?.criticalDelay === true && pressure?.overdueUnstarted === true;
  if (publicationDelayed) {
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
    // Fechamento das exclusões de grupo, DEPOIS do dispatch: é a metade de mídia
    // que acabou de rodar acima, e o finalize precisa vê-la terminada para
    // fechar o job. Fica aqui, e não num worker novo, porque este processo já
    // roda a cada 5s e já é o dono dessa metade.
    //
    // Ele não roda quando a rota sai antes por pressão de geração — e está certo
    // que não rode, porque a purga de histórico é mutação em massa. Quem está
    // com /grupos aberto fecha o job pelo GET de andamento; quem fechou a aba
    // espera a pressão passar.
    let groupDeletionsClosed = 0;
    const { data: closed, error: finalizeError } = await admin.rpc('finalize_profile_group_deletion_jobs', {
      p_organization_id: null,
    });
    if (finalizeError) {
      console.error('Falha ao finalizar exclusões de grupo.', {
        code: finalizeError.code, message: finalizeError.message,
      });
    } else {
      groupDeletionsClosed = Number(closed ?? 0);
    }

    return NextResponse.json({ deletion, groupAssignment, groupDeletionsClosed });
  } catch (error) {
    console.error('Dispatcher de mídia indisponível.', { error: errorMessage(error), details: error });
    return NextResponse.json({ error: errorMessage(error) }, { status: 503 });
  }
}

export async function GET(request: Request) {
  return POST(request);
}

