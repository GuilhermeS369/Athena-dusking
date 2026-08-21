import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }
  const attemptId = new URL(request.url).searchParams.get('attemptId')?.trim();
  if (!attemptId) return NextResponse.json({ error: 'Tentativa inválida.' }, { status: 400 });

  const { data, error } = await createSupabaseAdminClient()
    .from('zernio_connection_attempts')
    .select('id, correlation_id, status, worker_status, synced_count, zernio_connection_id, zernio_profile_id, requested_group_id, requested_group_name, group_assignment_status, group_assignment_error, last_error_message, worker_error_code, worker_error_stage, diagnostic, worker_completed_at, recovery_started_at, recovery_deadline_at, recovery_next_attempt_at, recovery_observation_count, recovery_paused_at, recovery_last_reason')
    .eq('id', attemptId)
    .eq('organization_id', context.activeOrganization.id)
    .eq('created_by', context.user.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Tentativa não encontrada.' }, { status: 404 });

  const groupComplete = !data.requested_group_id || data.group_assignment_status === 'assigned';
  const complete = data.worker_status === 'completed' && data.status === 'synced'
    && Number(data.synced_count ?? 0) > 0 && groupComplete;
  const recoveryPaused = data.worker_status === 'recovery_paused';
  const failed = !recoveryPaused && (['failed', 'conflict'].includes(data.worker_status)
    || data.status === 'failed'
    || data.group_assignment_status === 'failed');
  let queuePosition = 0;
  if (!complete && !failed && data.worker_status === 'pending') {
    const { data: position, error: positionError } = await createSupabaseAdminClient().rpc(
      'get_zernio_connection_addition_queue_position',
      {
        p_organization_id: context.activeOrganization.id,
        p_attempt_id: data.id,
        p_created_by: context.user.id,
      },
    );
    if (!positionError) queuePosition = Number(position ?? 0);
  }

  return NextResponse.json({
    attemptId: data.id,
    correlationId: data.correlation_id,
    connectionId: data.zernio_connection_id,
    zernioProfileId: data.zernio_profile_id,
    phase: complete ? 'completed' : failed ? 'failed' : recoveryPaused ? 'recovery_paused' : data.worker_status === 'processing' ? 'processing' : 'pending',
    syncedCount: data.synced_count ?? 0,
    groupName: data.requested_group_name,
    groupStatus: data.group_assignment_status,
    queuePosition,
    message: complete
      ? 'Conta adicionada ao Atena com sucesso.'
      : recoveryPaused
        ? 'A autorização foi recebida, mas a conta ainda não apareceu na Zernio. Você pode retomar a confirmação sem abrir outro OAuth.'
        : failed
        ? data.group_assignment_error ?? data.last_error_message ?? 'Não foi possível concluir esta adição.'
        : data.worker_status === 'processing'
          ? 'Confirmando a conta e o grupo no Atena…'
          : queuePosition > 1
            ? `Autorização recebida. Você está na posição ${queuePosition} da fila final desta empresa.`
            : 'Autorização recebida. Sua confirmação final é a próxima desta empresa.',
    errorCode: data.worker_error_code,
    errorStage: data.worker_error_stage,
    completedAt: data.worker_completed_at,
    recovery: {
      startedAt: data.recovery_started_at,
      deadlineAt: data.recovery_deadline_at,
      nextAttemptAt: data.recovery_next_attempt_at,
      observationCount: data.recovery_observation_count ?? 0,
      pausedAt: data.recovery_paused_at,
      reason: data.recovery_last_reason,
      canResume: recoveryPaused,
    },
  });
}
