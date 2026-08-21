-- Reabre somente attempts cujo conflito foi causado por um tombstone da mesma
-- organização e cuja identidade imutável coincide com a conta já reivindicada.
-- A função não cria novo claim, não troca accountId e não aceita username como
-- prova. Ela existe para recuperar autorizações remotas já concluídas.

create or replace function public.requeue_zernio_immutable_reconnection(
  p_attempt_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  selected public.zernio_connection_attempts%rowtype;
  account_claim public.zernio_addition_account_claims%rowtype;
  remote_profile public.zernio_connection_remote_profiles%rowtype;
  claimed_identity text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  select attempt.* into selected
  from public.zernio_connection_attempts attempt
  where attempt.id = p_attempt_id
  for update;

  if not found
     or selected.status <> 'failed'
     or selected.worker_status <> 'conflict'
     or nullif(trim(coalesce(selected.zernio_profile_id, '')), '') is null then
    return false;
  end if;

  select claim.* into account_claim
  from public.zernio_addition_account_claims claim
  where claim.attempt_id = selected.id
    and claim.organization_id = selected.organization_id
    and claim.zernio_connection_id = selected.zernio_connection_id
    and claim.zernio_profile_id = selected.zernio_profile_id
  for update;
  if not found then return false; end if;

  select profile.* into remote_profile
  from public.zernio_connection_remote_profiles profile
  where profile.organization_id = selected.organization_id
    and profile.zernio_connection_id = selected.zernio_connection_id
    and profile.zernio_profile_id = selected.zernio_profile_id
    and profile.status = 'cleanup_pending'
    and profile.claimed_by_attempt_id is null
    and profile.release_reason = 'worker_conflict'
  for update;
  if not found then return false; end if;

  select public.zernio_instagram_immutable_identity(
    coalesce(profile.zernio_account_metadata, '{}'::jsonb)
  ) into claimed_identity
  from public.instagram_profiles profile
  where profile.organization_id = selected.organization_id
    and profile.provider = 'zernio'
    and profile.deleted_at is not null
    and public.zernio_instagram_immutable_identity(
      coalesce(profile.zernio_account_metadata, '{}'::jsonb)
    ) = nullif(trim(selected.diagnostic #>> '{accountSelection,instagramIdentityId}'), '')
  order by profile.created_at, profile.id
  limit 1
  for update;

  if claimed_identity is null then return false; end if;

  if exists (
    select 1 from public.instagram_profiles profile
    where profile.provider = 'zernio'
      and profile.deleted_at is null
      and public.zernio_instagram_immutable_identity(
        coalesce(profile.zernio_account_metadata, '{}'::jsonb)
      ) = claimed_identity
  ) then
    return false;
  end if;

  update public.zernio_connection_remote_profiles profile
  set status = 'claimed',
      claimed_by_attempt_id = selected.id,
      claimed_at = timezone('utc', now()),
      released_at = null,
      release_reason = null,
      updated_at = timezone('utc', now())
  where profile.id = remote_profile.id;

  update public.zernio_connection_attempts attempt
  set status = 'callback_received',
      worker_status = 'pending',
      worker_id = null,
      worker_lease_expires_at = null,
      worker_completed_at = null,
      failed_at = null,
      synced_at = null,
      synced_count = 0,
      worker_error_code = null,
      worker_error_stage = null,
      last_error_message = null,
      diagnostic = coalesce(attempt.diagnostic, '{}'::jsonb) || jsonb_build_object(
        'immutableReconnectRequeuedAt', timezone('utc', now()),
        'immutableReconnectAccountId', account_claim.zernio_account_id,
        'immutableReconnectIdentityId', claimed_identity
      )
  where attempt.id = selected.id;

  update public.zernio_connection_intents intent
  set status = 'callback_received',
      diagnostic = coalesce(intent.diagnostic, '{}'::jsonb) || jsonb_build_object(
        'immutableReconnectRequeuedAt', timezone('utc', now())
      )
  where intent.id = selected.zernio_connection_intent_id;

  return true;
end;
$$;

revoke all on function public.requeue_zernio_immutable_reconnection(uuid)
  from public, anon, authenticated;
grant execute on function public.requeue_zernio_immutable_reconnection(uuid)
  to service_role;

notify pgrst, 'reload schema';
