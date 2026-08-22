-- Dashboard escalável — Fase E/F.
-- Enqueue live explícito e restrito à classe current, mantendo shadow e legado.

create or replace function public.enqueue_profile_analytics_refresh_v2_live_current_canary(
  p_organization_id uuid,
  p_profile_ids uuid[],
  p_canary_key text
)
returns table (
  inserted_count integer,
  total_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_profile_ids uuid[];
  safe_canary_key text := trim(coalesce(p_canary_key, ''));
  inserted_rows integer := 0;
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_organization_id is null then
    raise exception using errcode = '22023', message = 'Organização do canário live é obrigatória.';
  end if;
  if char_length(safe_canary_key) not between 8 and 120 then
    raise exception using errcode = '22023', message = 'Chave do canário live inválida.';
  end if;

  select coalesce(array_agg(distinct profile.id order by profile.id), '{}'::uuid[])
  into normalized_profile_ids
  from public.instagram_profiles profile
  join unnest(coalesce(p_profile_ids, '{}'::uuid[])) requested(profile_id)
    on requested.profile_id = profile.id
  where profile.organization_id = p_organization_id
    and profile.deleted_at is null
    and profile.provider = 'zernio'
    and profile.zernio_account_id is not null;

  if cardinality(normalized_profile_ids) = 0 then
    raise exception using errcode = '22023', message = 'O canário live precisa de pelo menos um perfil Zernio ativo.';
  end if;
  if cardinality(normalized_profile_ids) > 10 then
    raise exception using errcode = '22023', message = 'O canário live aceita no máximo 10 perfis por lote.';
  end if;
  if cardinality(normalized_profile_ids) <> cardinality(array(select distinct unnest(coalesce(p_profile_ids, '{}'::uuid[])))) then
    raise exception using errcode = '22023', message = 'Há perfil inválido, removido ou fora da organização no canário live.';
  end if;

  insert into public.profile_analytics_refresh_v2_connection_lanes (
    organization_id,
    connection_key,
    zernio_connection_id
  )
  select distinct
    profile.organization_id,
    coalesce(profile.zernio_connection_id::text, profile.organization_id::text || ':default'),
    profile.zernio_connection_id
  from public.instagram_profiles profile
  where profile.id = any(normalized_profile_ids)
  on conflict (organization_id, connection_key) do update
  set zernio_connection_id = coalesce(
    public.profile_analytics_refresh_v2_connection_lanes.zernio_connection_id,
    excluded.zernio_connection_id
  );

  with inserted as (
    insert into public.profile_analytics_refresh_v2_items (
      organization_id,
      profile_id,
      zernio_connection_id,
      connection_key,
      source_class,
      execution_mode,
      priority,
      estimated_requests,
      idempotency_key,
      max_attempts,
      metadata
    )
    select
      profile.organization_id,
      profile.id,
      profile.zernio_connection_id,
      coalesce(profile.zernio_connection_id::text, profile.organization_id::text || ':default'),
      'current',
      'live',
      1900,
      class.default_estimated_requests,
      'live-current-canary:' || safe_canary_key || ':' || profile.id::text,
      3,
      jsonb_build_object(
        'canary', true,
        'canaryKey', safe_canary_key,
        'sourceClasses', jsonb_build_array('current')
      )
    from public.instagram_profiles profile
    join public.profile_analytics_source_classes class
      on class.source_class = 'current'
     and class.enabled
    where profile.id = any(normalized_profile_ids)
    on conflict (organization_id, idempotency_key) do nothing
    returning *
  ), events as (
    insert into public.profile_analytics_refresh_v2_item_events (
      item_id, legacy_job_id, organization_id, profile_id, source_class,
      execution_mode, event_type, attempt_number, metadata
    )
    select
      inserted.id, null, inserted.organization_id, inserted.profile_id,
      inserted.source_class, inserted.execution_mode, 'enqueued', 0,
      jsonb_build_object('canary', true, 'canaryKey', safe_canary_key)
    from inserted
    returning id
  )
  select count(*)::integer into inserted_rows from events;

  inserted_count := inserted_rows;
  select count(*)::integer into total_count
  from public.profile_analytics_refresh_v2_items item
  where item.organization_id = p_organization_id
    and item.execution_mode = 'live'
    and item.source_class = 'current'
    and item.idempotency_key like 'live-current-canary:' || safe_canary_key || ':%';
  return next;
end;
$$;

create or replace function public.claim_profile_analytics_refresh_v2_live_current_canary(
  p_worker_id text,
  p_organization_ids uuid[],
  p_lease_seconds integer default 300,
  p_max_connection_leases integer default 1
)
returns table (
  item_id uuid,
  legacy_job_id uuid,
  organization_id uuid,
  profile_id uuid,
  zernio_connection_id uuid,
  connection_key text,
  source_class text,
  execution_mode text,
  priority smallint,
  estimated_requests smallint,
  attempts integer,
  max_attempts integer,
  lease_token uuid,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_item public.profile_analytics_refresh_v2_items%rowtype;
  was_recovered boolean := false;
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if cardinality(coalesce(p_organization_ids, '{}'::uuid[])) = 0 then
    raise exception using errcode = '22023', message = 'Escopo de organizações do canário live é obrigatório.';
  end if;
  if p_lease_seconds not between 30 and 1800 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 1800 segundos.';
  end if;
  if p_max_connection_leases not between 1 and 5 then
    raise exception using errcode = '22023', message = 'Concorrência por conexão do canário deve estar entre 1 e 5.';
  end if;

  with exhausted as (
    update public.profile_analytics_refresh_v2_items item
    set status = 'dead_letter',
        claimed_by = null,
        lease_until = null,
        completed_at = timezone('utc', now()),
        last_error_class = coalesce(item.last_error_class, 'lease_exhausted'),
        last_error_code = coalesce(item.last_error_code, 'analytics_v2_live_current_lease_exhausted'),
        last_error_message = coalesce(item.last_error_message, 'Lease expirou após a última tentativa permitida.')
    where item.execution_mode = 'live'
      and item.source_class = 'current'
      and item.organization_id = any(p_organization_ids)
      and item.status = 'processing'
      and item.lease_until <= timezone('utc', now())
      and item.attempts >= item.max_attempts
    returning item.*
  )
  insert into public.profile_analytics_refresh_v2_item_events (
    item_id, legacy_job_id, organization_id, profile_id, source_class,
    execution_mode, event_type, attempt_number, worker_id, lease_token,
    error_class, error_code
  )
  select exhausted.id, exhausted.legacy_job_id, exhausted.organization_id,
    exhausted.profile_id, exhausted.source_class, exhausted.execution_mode,
    'dead_lettered', exhausted.attempts, exhausted.claimed_by,
    exhausted.lease_token, exhausted.last_error_class, exhausted.last_error_code
  from exhausted;

  select item.*
  into selected_item
  from public.profile_analytics_refresh_v2_items item
  join public.profile_analytics_refresh_v2_connection_lanes lane
    on lane.organization_id = item.organization_id
   and lane.connection_key = item.connection_key
  where item.execution_mode = 'live'
    and item.source_class = 'current'
    and item.organization_id = any(p_organization_ids)
    and item.attempts < item.max_attempts
    and item.available_at <= timezone('utc', now())
    and (lane.cooldown_until is null or lane.cooldown_until <= timezone('utc', now()))
    and (
      item.status in ('pending', 'retry_pending')
      or (item.status = 'processing' and item.lease_until <= timezone('utc', now()))
    )
    and (
      select count(*)
      from public.profile_analytics_refresh_v2_items active
      where active.organization_id = item.organization_id
        and active.connection_key = item.connection_key
        and active.status = 'processing'
        and active.lease_until > timezone('utc', now())
    ) < p_max_connection_leases
  order by lane.last_claimed_at asc nulls first, item.priority desc,
    item.available_at, item.created_at, item.id
  for update of item, lane skip locked
  limit 1;

  if not found then
    return;
  end if;

  was_recovered := selected_item.status = 'processing';

  update public.profile_analytics_refresh_v2_items item
  set status = 'processing',
      attempts = item.attempts + 1,
      claimed_by = trim(p_worker_id),
      lease_token = gen_random_uuid(),
      lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
      last_attempt_at = timezone('utc', now()),
      completed_at = null,
      last_error_class = null,
      last_error_code = null,
      last_error_message = null
  where item.id = selected_item.id
  returning item.* into selected_item;

  update public.profile_analytics_refresh_v2_connection_lanes lane
  set last_claimed_at = timezone('utc', now()),
      claims_count = lane.claims_count + 1
  where lane.organization_id = selected_item.organization_id
    and lane.connection_key = selected_item.connection_key;

  insert into public.profile_analytics_refresh_v2_item_events (
    item_id, legacy_job_id, organization_id, profile_id, source_class,
    execution_mode, event_type, attempt_number, worker_id, lease_token
  ) values (
    selected_item.id, selected_item.legacy_job_id, selected_item.organization_id,
    selected_item.profile_id, selected_item.source_class, selected_item.execution_mode,
    case when was_recovered then 'lease_recovered' else 'claimed' end,
    selected_item.attempts, trim(p_worker_id), selected_item.lease_token
  );

  item_id := selected_item.id;
  legacy_job_id := selected_item.legacy_job_id;
  organization_id := selected_item.organization_id;
  profile_id := selected_item.profile_id;
  zernio_connection_id := selected_item.zernio_connection_id;
  connection_key := selected_item.connection_key;
  source_class := selected_item.source_class;
  execution_mode := selected_item.execution_mode;
  priority := selected_item.priority;
  estimated_requests := selected_item.estimated_requests;
  attempts := selected_item.attempts;
  max_attempts := selected_item.max_attempts;
  lease_token := selected_item.lease_token;
  lease_until := selected_item.lease_until;
  return next;
end;
$$;

revoke all on function public.enqueue_profile_analytics_refresh_v2_live_current_canary(uuid, uuid[], text)
from public, anon, authenticated;
grant execute on function public.enqueue_profile_analytics_refresh_v2_live_current_canary(uuid, uuid[], text)
to service_role;
revoke all on function public.claim_profile_analytics_refresh_v2_live_current_canary(text, uuid[], integer, integer)
from public, anon, authenticated;
grant execute on function public.claim_profile_analytics_refresh_v2_live_current_canary(text, uuid[], integer, integer)
to service_role;

notify pgrst, 'reload schema';
