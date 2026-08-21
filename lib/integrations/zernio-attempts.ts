import { randomUUID } from 'crypto';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import type { ZernioAccountIdentitySnapshot } from '@/lib/integrations/zernio-account-selection';

export type ZernioConnectionAttemptStatus = 'started' | 'redirected' | 'callback_received' | 'synced' | 'empty' | 'failed';

export type ZernioConnectionAttempt = {
  id: string;
  organization_id: string;
  zernio_connection_id: string;
  created_by: string;
  return_to: string;
  status: ZernioConnectionAttemptStatus;
  zernio_profile_id: string | null;
  zernio_slot_reservation_id: string | null;
  zernio_connection_intent_id: string | null;
  requested_group_id: string | null;
  requested_group_name: string | null;
  group_assignment_status: 'not_requested' | 'pending' | 'assigned' | 'failed';
  group_assigned_profile_ids: string[];
  group_assignment_error: string | null;
  diagnostic: Record<string, unknown>;
  synced_count: number;
  zernio_state: string | null;
};

type CreateAttemptInput = {
  organizationId: string;
  connectionId: string;
  userId: string;
  returnTo: string;
  zernioProfileId: string | null;
  request: Request;
  knownZernioAccountIds: string[];
  knownZernioAccounts?: ZernioAccountIdentitySnapshot[];
  zernioSlotReservationId?: string | null;
  zernioConnectionIntentId?: string | null;
  requestedGroupId?: string | null;
  requestedGroupName?: string | null;
};

const attemptProjection = 'id, organization_id, zernio_connection_id, created_by, return_to, status, zernio_profile_id, zernio_slot_reservation_id, zernio_connection_intent_id, requested_group_id, requested_group_name, group_assignment_status, group_assigned_profile_ids, group_assignment_error, synced_count, zernio_state, diagnostic';

async function updateIntentStatus(intentId: string | null | undefined, status: string, patch: Record<string, unknown> = {}) {
  if (!intentId) return;
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase.from('zernio_connection_intents').select('diagnostic').eq('id', intentId).maybeSingle();
  await supabase.from('zernio_connection_intents').update({
    status,
    diagnostic: mergeDiagnostic(data?.diagnostic, patch),
  }).eq('id', intentId);
}

function requestIp(request: Request) {
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwardedFor || request.headers.get('x-real-ip') || request.headers.get('cf-connecting-ip') || null;
}

function compactError(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 1000) : 'Erro desconhecido.';
}

function mergeDiagnostic(current: unknown, patch: Record<string, unknown>) {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
  return { ...base, ...patch };
}

export async function createZernioConnectionAttempt(input: CreateAttemptInput) {
  const supabase = createSupabaseAdminClient();
  const attemptId = randomUUID();
  const { data, error } = await supabase
    .from('zernio_connection_attempts')
    .insert({
      id: attemptId,
      organization_id: input.organizationId,
      zernio_connection_id: input.connectionId,
      created_by: input.userId,
      return_to: input.returnTo,
      zernio_profile_id: input.zernioProfileId,
      zernio_slot_reservation_id: input.zernioSlotReservationId ?? null,
      zernio_connection_intent_id: input.zernioConnectionIntentId ?? null,
      request_user_agent: input.request.headers.get('user-agent'),
      request_ip: requestIp(input.request),
      requested_group_id: input.requestedGroupId ?? null,
      requested_group_name: input.requestedGroupName ?? null,
      group_assignment_status: input.requestedGroupId ? 'pending' : 'not_requested',
      diagnostic: {
        knownZernioAccountIds: input.knownZernioAccountIds,
        knownZernioAccountCount: input.knownZernioAccountIds.length,
        knownZernioAccounts: input.knownZernioAccounts ?? [],
        baselineIdentityVersion: 1,
      },
    })
    .select(attemptProjection)
    .single();

  if (error) throw error;
  return data as ZernioConnectionAttempt;
}

export async function loadZernioConnectionAttempt(organizationId: string, attemptId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from('zernio_connection_attempts')
    .select(attemptProjection)
    .eq('id', attemptId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) throw error;
  return data as ZernioConnectionAttempt | null;
}

export async function markZernioConnectionAttemptRedirected(attemptId: string, result: { authUrl?: string | null; state?: string | null }) {
  const supabase = createSupabaseAdminClient();
  let authUrlHost: string | null = null;
  try {
    authUrlHost = result.authUrl ? new URL(result.authUrl).host : null;
  } catch {
    authUrlHost = null;
  }
  const { data: attempt } = await supabase
    .from('zernio_connection_attempts')
    .update({
      status: 'redirected',
      redirected_at: new Date().toISOString(),
      auth_url_host: authUrlHost,
      zernio_state: result.state ?? null,
    })
    .eq('id', attemptId)
    .in('status', ['started', 'redirected'])
    .select('zernio_connection_intent_id')
    .maybeSingle();
  await updateIntentStatus(attempt?.zernio_connection_intent_id, 'redirected', { authUrlHost });
}

export async function markZernioConnectionAttemptProfilePrepared(attemptId: string, zernioProfileId: string, patch: Record<string, unknown> = {}) {
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('zernio_connection_attempts')
    .select('diagnostic')
    .eq('id', attemptId)
    .maybeSingle();

  await supabase
    .from('zernio_connection_attempts')
    .update({
      zernio_profile_id: zernioProfileId,
      diagnostic: mergeDiagnostic(data?.diagnostic, patch),
    })
    .eq('id', attemptId);
}

export async function markZernioConnectionAttemptCallback(attemptId: string, query: Record<string, string>) {
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('zernio_connection_attempts')
    .select('status, diagnostic, zernio_connection_intent_id')
    .eq('id', attemptId)
    .maybeSingle();

  if (!data || ['synced', 'empty', 'failed'].includes(data.status)) {
    return { accepted: false, status: data?.status ?? null };
  }

  const { data: updated } = await supabase
    .from('zernio_connection_attempts')
    .update({
      status: 'callback_received',
      worker_status: 'pending',
      worker_id: null,
      worker_lease_expires_at: null,
      callback_received_at: new Date().toISOString(),
      diagnostic: mergeDiagnostic(data?.diagnostic, {
        callbackQuery: query,
        callbackReceivedAt: new Date().toISOString(),
        explicitCallbackAccountId: query.accountId ?? query.account_id ?? query.zernioAccountId ?? query.zernio_account_id ?? null,
        explicitCallbackProfileId: query.profileId ?? query.profile_id ?? query.zernioProfileId ?? query.zernio_profile_id ?? null,
      }),
    })
    .eq('id', attemptId)
    .in('status', ['started', 'redirected'])
    .select('zernio_connection_intent_id')
    .maybeSingle();
  await updateIntentStatus(updated?.zernio_connection_intent_id, 'callback_received');
  return { accepted: Boolean(updated), status: updated ? 'callback_received' : data.status };
}

export async function markZernioConnectionAttemptFailed(attemptId: string | null | undefined, error: unknown, patch: Record<string, unknown> = {}) {
  if (!attemptId) return;
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('zernio_connection_attempts')
    .select('status, diagnostic, zernio_connection_intent_id')
    .eq('id', attemptId)
    .maybeSingle();

  if (!data || ['synced', 'empty', 'failed'].includes(data.status)) return;
  const { data: updated } = await supabase
    .from('zernio_connection_attempts')
    .update({
      status: 'failed',
      worker_status: 'failed',
      worker_lease_expires_at: null,
      worker_completed_at: new Date().toISOString(),
      failed_at: new Date().toISOString(),
      last_error_message: compactError(error),
      diagnostic: mergeDiagnostic(data?.diagnostic, patch),
    })
    .eq('id', attemptId)
    .in('status', ['started', 'redirected', 'callback_received'])
    .select('zernio_connection_intent_id')
    .maybeSingle();
  await updateIntentStatus(updated?.zernio_connection_intent_id, 'failed', { error: compactError(error) });
}

export async function markZernioConnectionAttemptSynced(input: {
  attemptId: string;
  status: 'synced' | 'empty';
  syncAttempts: number;
  syncedCount: number;
  zernioAccountIds: string[];
  newZernioAccountIds: string[];
  diagnostic: Record<string, unknown>;
}) {
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('zernio_connection_attempts')
    .select('status, diagnostic, zernio_connection_intent_id')
    .eq('id', input.attemptId)
    .maybeSingle();

  if (!data || ['synced', 'empty', 'failed'].includes(data.status)) return;
  const { data: updated } = await supabase
    .from('zernio_connection_attempts')
    .update({
      status: input.status,
      worker_status: 'completed',
      worker_lease_expires_at: null,
      worker_completed_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
      sync_attempts: input.syncAttempts,
      synced_count: input.syncedCount,
      zernio_account_ids: input.zernioAccountIds,
      new_zernio_account_ids: input.newZernioAccountIds,
      diagnostic: mergeDiagnostic(data?.diagnostic, input.diagnostic),
    })
    .eq('id', input.attemptId)
    .in('status', ['started', 'redirected', 'callback_received'])
    .select('zernio_connection_intent_id')
    .maybeSingle();
  await updateIntentStatus(updated?.zernio_connection_intent_id, input.status, { syncedCount: input.syncedCount });
}

export function knownZernioAccountIdsFromAttempt(attempt: ZernioConnectionAttempt | null | undefined) {
  const value = attempt?.diagnostic?.knownZernioAccountIds;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
