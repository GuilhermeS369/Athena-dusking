import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export type ZernioOauthTurnStatus = 'waiting' | 'active' | 'completed' | 'failed' | 'expired';

export type ZernioOauthTurnState = {
  turnId: string;
  status: ZernioOauthTurnStatus;
  position: number;
  leaseExpiresAt: string | null;
};

type QueueRow = {
  turn_id?: string;
  turn_status?: ZernioOauthTurnStatus;
  queue_position?: number;
  lease_expires_at?: string | null;
};

function queueState(row: QueueRow | undefined): ZernioOauthTurnState {
  if (!row?.turn_id || !row.turn_status) throw new Error('A fila OAuth Zernio não retornou um turno válido.');
  return {
    turnId: row.turn_id,
    status: row.turn_status,
    position: row.queue_position ?? 0,
    leaseExpiresAt: row.lease_expires_at ?? null,
  };
}

export async function enqueueZernioOauthTurn(input: {
  organizationId: string;
  connectionId: string;
  zernioProfileId: string;
  intentId: string;
  reservationId: string | null;
  createdBy: string;
}) {
  const { data, error } = await createSupabaseAdminClient().rpc('enqueue_zernio_oauth_turn', {
    p_organization_id: input.organizationId,
    p_zernio_connection_id: input.connectionId,
    p_zernio_profile_id: input.zernioProfileId,
    p_intent_id: input.intentId,
    p_reservation_id: input.reservationId,
    p_created_by: input.createdBy,
    p_lease_seconds: 900,
  });
  if (error) throw error;
  return queueState((data ?? [])[0] as QueueRow | undefined);
}

export async function getZernioOauthTurnStatus(input: {
  organizationId: string;
  turnId: string;
  createdBy: string;
}) {
  const { data, error } = await createSupabaseAdminClient().rpc('get_zernio_oauth_turn_status', {
    p_organization_id: input.organizationId,
    p_turn_id: input.turnId,
    p_created_by: input.createdBy,
    p_lease_seconds: 900,
  });
  if (error) throw error;
  const row = (data ?? [])[0] as Omit<QueueRow, 'turn_id'> | undefined;
  return queueState({ ...row, turn_id: input.turnId });
}

export async function claimZernioOauthTurnPreparation(input: {
  organizationId: string;
  turnId: string;
  createdBy: string;
}) {
  const { data, error } = await createSupabaseAdminClient().rpc('claim_zernio_oauth_turn_preparation', {
    p_organization_id: input.organizationId,
    p_turn_id: input.turnId,
    p_created_by: input.createdBy,
    p_lease_seconds: 900,
  });
  if (error) throw error;
  const row = (data ?? [])[0] as {
    claimed?: boolean;
    turn_status?: ZernioOauthTurnStatus;
    intent_id?: string;
    reservation_id?: string | null;
    connection_id?: string;
  } | undefined;
  if (!row?.turn_status || !row.intent_id || !row.connection_id) {
    throw new Error('O turno OAuth Zernio não retornou seu contexto durável.');
  }
  return {
    claimed: Boolean(row.claimed),
    status: row.turn_status,
    intentId: row.intent_id,
    reservationId: row.reservation_id,
    connectionId: row.connection_id,
  };
}

export async function attachZernioOauthTurnAttempt(input: {
  organizationId: string;
  turnId: string;
  attemptId: string;
}) {
  const { data, error } = await createSupabaseAdminClient().rpc('attach_zernio_oauth_turn_attempt', {
    p_organization_id: input.organizationId,
    p_turn_id: input.turnId,
    p_attempt_id: input.attemptId,
  });
  if (error) throw error;
  if (!data) throw new Error('O attempt não pôde ser associado ao turno OAuth ativo.');
}

export async function validateZernioOauthTurn(input: {
  organizationId: string;
  turnId: string;
  attemptId: string;
  createdBy: string;
}) {
  const { data, error } = await createSupabaseAdminClient().rpc('validate_zernio_oauth_turn', {
    p_organization_id: input.organizationId,
    p_turn_id: input.turnId,
    p_attempt_id: input.attemptId,
    p_created_by: input.createdBy,
    p_lease_seconds: 900,
  });
  if (error) throw error;
  return Boolean(data);
}

export async function finishZernioOauthTurn(input: {
  organizationId: string;
  turnId: string;
  attemptId: string | null;
  createdBy: string;
  status: 'completed' | 'failed';
  reason: string;
}) {
  const { error } = await createSupabaseAdminClient().rpc('finish_zernio_oauth_turn', {
    p_organization_id: input.organizationId,
    p_turn_id: input.turnId,
    p_attempt_id: input.attemptId,
    p_created_by: input.createdBy,
    p_terminal_status: input.status,
    p_reason: input.reason,
  });
  if (error) throw error;
}

