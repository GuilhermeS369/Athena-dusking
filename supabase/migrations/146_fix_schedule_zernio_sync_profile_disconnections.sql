-- Fix schedule_zernio_sync_profile_disconnections state check constraint
create or replace function public.schedule_zernio_sync_profile_disconnection(
  p_organization_id uuid,
  p_profile_id uuid,
  p_signal text default 'auth_expired',
  p_error_code text default 'zernio_account_disconnected',
  p_error_message text default 'A Zernio informou que a conta foi desconectada.',
  p_actor_label text default 'system: zernio-sync-worker'
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  profile_row public.instagram_profiles%rowtype;
  connection_label text;
  incident_row public.zernio_profile_disconnection_incidents%rowtype;
  normalized_sig text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao service_role.';
  end if;

  normalized_sig := case
    when p_signal in ('account_disconnected', 'auth_expired') then p_signal
    else 'auth_expired'
  end;

  select profile.* into profile_row
  from public.instagram_profiles profile
  where profile.id = p_profile_id
    and profile.organization_id = p_organization_id
    and profile.provider = 'zernio'
    and profile.deleted_at is null
  for update;

  if not found or coalesce(nullif(trim(profile_row.zernio_account_id), ''), '') = '' then
    return jsonb_build_object('scheduled', false, 'reason', 'profile_not_found_or_already_deleted');
  end if;

  select label into connection_label
  from public.zernio_connections connection
  where connection.id = profile_row.zernio_connection_id
    and connection.organization_id = profile_row.organization_id;

  insert into public.zernio_profile_disconnection_incidents (
    organization_id, profile_id, zernio_connection_id, zernio_account_id, username_snapshot, connection_label_snapshot,
    signal, source, error_code, error_message, detected_at, state
  ) values (
    profile_row.organization_id, profile_row.id, profile_row.zernio_connection_id, profile_row.zernio_account_id,
    profile_row.username, connection_label, normalized_sig, 'zernio_sync_worker',
    left(coalesce(nullif(trim(p_error_code), ''), 'zernio_account_disconnected'), 120),
    left(coalesce(nullif(trim(p_error_message), ''), 'A Zernio informou que a conta foi desconectada.'), 1200),
    timezone('utc', now()), 'remote_removal_pending'
  ) on conflict (organization_id, profile_id) do update set
    updated_at = timezone('utc', now()),
    error_message = excluded.error_message,
    state = case
      when public.zernio_profile_disconnection_incidents.state in ('completed', 'dead_letter') then 'remote_removal_pending'
      else public.zernio_profile_disconnection_incidents.state
    end
  returning * into incident_row;

  insert into public.zernio_profile_recycling_jobs (organization_id, incident_id, status)
  values (profile_row.organization_id, incident_row.id, 'pending')
  on conflict (incident_id) do update set
    status = 'pending',
    claimed_by = null,
    lease_until = null,
    next_attempt_at = timezone('utc', now()),
    attempt_count = 0;

  -- Imediatamente converte itens pendentes/suspensos para ignored
  update public.publication_items item
  set status = 'ignored',
      claimed_by = null,
      lease_until = null,
      next_attempt_at = null,
      attempt_count = 0,
      last_error_code = 'zernio_account_disconnected',
      last_error_message = 'Conta Zernio desconectada; perfil encaminhado para remoção automática.'
  where item.organization_id = profile_row.organization_id
    and item.profile_id = profile_row.id
    and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended');

  delete from public.publication_profile_daily_reservations
  where organization_id = profile_row.organization_id and profile_id = profile_row.id;

  delete from public.publication_dispatch_rate_reservations
  where organization_id = profile_row.organization_id and profile_id = profile_row.id;

  return jsonb_build_object(
    'scheduled', true,
    'incidentId', incident_row.id,
    'profileId', profile_row.id,
    'username', profile_row.username
  );
end;
$$;

revoke all on function public.schedule_zernio_sync_profile_disconnection(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.schedule_zernio_sync_profile_disconnection(uuid, uuid, text, text, text, text) to service_role;
