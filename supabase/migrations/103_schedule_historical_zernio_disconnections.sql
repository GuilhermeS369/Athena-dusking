-- Backfill administrativo, idempotente e limitado aos dois sinais terminais aprovados.
-- Não remove o perfil local: apenas cria o incidente/job e encerra o item-fonte como ignored.
-- A função usa SQL puro para manter a migration portável no executor remoto do Supabase.
create or replace function public.schedule_historical_zernio_profile_disconnections(
  p_usernames text[]
)
returns table (
  username text,
  profile_id uuid,
  incident_id uuid,
  source_item_id uuid,
  signal text,
  outcome text
)
language sql security definer set search_path = public as $historical_zernio_disconnections$
  with targets as (
    select distinct lower(ltrim(trim(coalesce(value, '')), '@')) as username
    from unnest(coalesce(p_usernames, array[]::text[])) as input(value)
    where lower(ltrim(trim(coalesce(value, '')), '@')) <> ''
  ), matched_profiles as (
    select distinct on (target.username)
      target.username as requested_username,
      profile.*
    from targets target
    join public.instagram_profiles profile
      on lower(profile.username) = target.username
     and profile.provider = 'zernio'
     and profile.deleted_at is null
     and nullif(trim(coalesce(profile.zernio_account_id, '')), '') is not null
    order by target.username, profile.updated_at desc, profile.id
  ), matched_items as (
    select
      profile.requested_username,
      profile.id as matched_profile_id,
      item.id as source_item_id,
      item.batch_id as source_batch_id,
      item.status as source_status,
      item.last_error_code,
      item.last_error_message,
      case
        when lower(coalesce(item.last_error_code, '')) = 'auth_expired'
          or lower(coalesce(item.last_error_message, '')) ~ 'auth_expired'
          then 'auth_expired'
        else 'account_disconnected'
      end as normalized_signal
    from matched_profiles profile
    join lateral (
      select publication_item.*
      from public.publication_items publication_item
      where publication_item.organization_id = profile.organization_id
        and publication_item.profile_id = profile.id
        and publication_item.status in ('failed', 'waiting', 'ready', 'preparing', 'publishing', 'suspended')
        and (
          lower(coalesce(publication_item.last_error_code, '')) in ('account_disconnected', 'auth_expired')
          or lower(coalesce(publication_item.last_error_message, '')) ~ '(account_disconnected|auth_expired)'
      )
      order by publication_item.updated_at desc, publication_item.id desc
      limit 1
    ) item on true
  ), scheduled_incidents as (
    insert into public.zernio_profile_disconnection_incidents (
      organization_id, profile_id, zernio_connection_id, zernio_account_id, username_snapshot,
      connection_label_snapshot, signal, source_item_id, source_batch_id, source, error_code, error_message
    )
    select
      profile.organization_id,
      profile.id,
      profile.zernio_connection_id,
      profile.zernio_account_id,
      profile.username,
      connection.label,
      item.normalized_signal,
      item.source_item_id,
      item.source_batch_id,
      'historical_backfill',
      left(coalesce(nullif(trim(item.last_error_code), ''), item.normalized_signal), 120),
      left(coalesce(nullif(trim(item.last_error_message), ''), 'Falha histórica Zernio classificada como desconexão terminal.'), 1200)
    from matched_items item
    join matched_profiles profile on profile.id = item.matched_profile_id
    left join public.zernio_connections connection
      on connection.id = profile.zernio_connection_id
     and connection.organization_id = profile.organization_id
    on conflict (organization_id, profile_id) do update
      set updated_at = timezone('utc', now())
    returning id, profile_id, organization_id
  ), scheduled_jobs as (
    insert into public.zernio_profile_recycling_jobs (organization_id, incident_id)
    select organization_id, id
    from scheduled_incidents
    on conflict (incident_id) do nothing
  ), ignored_items as (
    update public.publication_items publication_item
    set status = 'ignored',
        claimed_by = null,
        lease_until = null,
        next_attempt_at = null,
        attempt_count = 0,
        last_error_code = 'zernio_account_disconnected',
        last_error_message = 'Conta Zernio desconectada; encaminhada para remoção automática.'
    from matched_items item
    where publication_item.id = item.source_item_id
    returning publication_item.id
  ), released_daily_reservations as (
    delete from public.publication_profile_daily_reservations reservation
    using ignored_items item
    where reservation.publication_item_id = item.id
  ), released_dispatch_reservations as (
    delete from public.publication_dispatch_rate_reservations reservation
    using ignored_items item
    where reservation.publication_item_id = item.id
  ), logged_items as (
    select public.log_publication_item_event(
      item.source_item_id,
      'ignored',
      item.source_status,
      'ignored',
      null,
      'system: zernio-historical-backfill',
      'zernio_account_disconnected',
      'Falha histórica classificada como queda de conta Zernio; item ignorado.',
      jsonb_build_object('incident_id', incident.id, 'source', 'historical_backfill')
    )
    from matched_items item
    join scheduled_incidents incident on incident.profile_id = item.matched_profile_id
  ), synchronized_batches as (
    select public.sync_publication_batch_status(item.source_batch_id)
    from (select distinct source_batch_id from matched_items) item
  )
  select
    target.username,
    profile.id,
    incident.id,
    item.source_item_id,
    item.normalized_signal,
    case
      when profile.id is null then 'profile_not_found'
      when item.source_item_id is null then 'terminal_signal_not_found'
      else 'scheduled'
    end
  from targets target
  left join matched_profiles profile on profile.requested_username = target.username
  left join matched_items item on item.requested_username = target.username
  left join scheduled_incidents incident on incident.profile_id = profile.id
  order by target.username;
$historical_zernio_disconnections$;

revoke all on function public.schedule_historical_zernio_profile_disconnections(text[]) from public, anon, authenticated;
grant execute on function public.schedule_historical_zernio_profile_disconnections(text[]) to service_role;
