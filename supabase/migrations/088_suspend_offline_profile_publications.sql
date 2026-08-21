-- Suspensão central de publicações quando um perfil deixa de estar online.
-- A retomada permanece manual e será implementada separadamente: voltar o perfil
-- para online nunca limpa automaticamente a suspensão persistida nesta migration.

alter table public.publication_items
  add column if not exists suspended_at timestamptz,
  add column if not exists active_claim_consumed_attempt boolean not null default false,
  add column if not exists suspension_reason text
    check (suspension_reason is null or char_length(suspension_reason) <= 500);

create index if not exists publication_items_suspended_profile_idx
  on public.publication_items (organization_id, profile_id, suspended_at desc)
  where status = 'suspended' and archived_at is null;

create table if not exists public.profile_publication_suspensions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  profile_status public.instagram_profile_status not null,
  reason text not null check (char_length(trim(reason)) between 1 and 500),
  suspended_item_count bigint not null default 0 check (suspended_item_count >= 0),
  suspended_plan_profile_count bigint not null default 0 check (suspended_plan_profile_count >= 0),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists profile_publication_suspensions_profile_created_idx
  on public.profile_publication_suspensions (organization_id, profile_id, created_at desc);

alter table public.profile_publication_suspensions enable row level security;
drop policy if exists profile_publication_suspensions_select_member on public.profile_publication_suspensions;
create policy profile_publication_suspensions_select_member
on public.profile_publication_suspensions for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.profile_publication_suspensions from public, anon, authenticated;
grant select on table public.profile_publication_suspensions to authenticated;
grant all on table public.profile_publication_suspensions to service_role;

create or replace function public.suspend_offline_profile_publications(
  p_profile_id uuid,
  p_reason text default null,
  p_actor_label text default 'system: profile-offline-suspension'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_row public.instagram_profiles%rowtype;
  resolved_now timestamptz := timezone('utc', now());
  resolved_reason text;
  suspended_items bigint := 0;
  suspended_events bigint := 0;
  suspended_profiles bigint := 0;
  affected_plan_ids uuid[] := '{}'::uuid[];
  affected_batch_ids uuid[] := '{}'::uuid[];
  affected_plan_id uuid;
  affected_batch_id uuid;
begin
  select profile.* into profile_row
  from public.instagram_profiles profile
  where profile.id = p_profile_id
  for update;

  if profile_row.id is null then
    raise exception using errcode = 'P0002', message = 'Perfil não encontrado para suspensão.';
  end if;
  if profile_row.deleted_at is null and profile_row.status = 'online' then
    raise exception using errcode = '22023', message = 'Perfil online não pode ser suspenso automaticamente.';
  end if;

  resolved_reason := left(coalesce(
    nullif(trim(p_reason), ''),
    case when profile_row.deleted_at is not null
      then 'Perfil removido; publicações futuras suspensas.'
      else format('Perfil %s; publicações futuras suspensas.', profile_row.status::text)
    end
  ), 500);

  perform pg_advisory_xact_lock(hashtextextended('profile-publication-suspension:' || profile_row.id::text, 0));

  with candidates as (
    select item.id, item.batch_id, item.status
    from public.publication_items item
    where item.organization_id = profile_row.organization_id
      and item.profile_id = profile_row.id
      and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
      and item.meta_media_id is null
      and item.published_at is null
    for update
  ), suspended as (
    update public.publication_items item
    set status = 'suspended', suspended_at = coalesce(item.suspended_at, resolved_now),
        suspension_reason = resolved_reason,
        claimed_by = null, lease_until = null, next_attempt_at = null,
        attempt_count = case
          when item.active_claim_consumed_attempt and candidates.status in ('preparing', 'publishing')
            then greatest(item.attempt_count - 1, 0)
          else item.attempt_count
        end,
        active_claim_consumed_attempt = false,
        last_error_code = 'profile_offline_suspended',
        last_error_message = resolved_reason
    from candidates
    where item.id = candidates.id
    returning item.id, item.organization_id, item.batch_id, candidates.status as previous_status
  ), events as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status, status,
      actor_label, error_code, error_message, metadata
    )
    select suspended.organization_id, suspended.id, 'suspended', suspended.previous_status, 'suspended',
      left(nullif(trim(coalesce(p_actor_label, '')), ''), 160),
      'profile_offline_suspended', resolved_reason,
      jsonb_build_object('profile_id', profile_row.id, 'profile_status', profile_row.status::text)
    from suspended
    returning publication_item_id
  )
  select
    (select count(*)::bigint from suspended),
    (select coalesce(array_agg(distinct suspended.batch_id), '{}'::uuid[]) from suspended),
    (select count(*)::bigint from events)
  into suspended_items, affected_batch_ids, suspended_events;

  if suspended_events <> suspended_items then
    raise exception using
      errcode = 'P0001',
      message = format(
        'Falha ao auditar suspensão: %s itens suspensos e %s eventos registrados.',
        suspended_items,
        suspended_events
      );
  end if;

  delete from public.publication_profile_daily_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.organization_id = profile_row.organization_id
    and item.profile_id = profile_row.id
    and item.status = 'suspended';

  delete from public.publication_dispatch_rate_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.organization_id = profile_row.organization_id
    and item.profile_id = profile_row.id
    and item.status = 'suspended';

  with paused_chunks as (
    update public.bulk_publication_generation_chunks chunk
    set status = 'paused', claimed_by = null, lease_until = null,
        last_error_message = resolved_reason
    where chunk.organization_id = profile_row.organization_id
      and chunk.profile_id = profile_row.id
      and chunk.status in ('queued', 'processing', 'failed')
      and chunk.retry_exhausted_at is null
    returning chunk.plan_profile_id, chunk.plan_id
  ), suspended_plan_profiles as (
    update public.bulk_publication_plan_profiles profile_plan
    set status = 'suspended', suspended_at = coalesce(profile_plan.suspended_at, resolved_now),
        suspension_reason = resolved_reason
    where profile_plan.id in (select paused.plan_profile_id from paused_chunks paused)
      and profile_plan.status in ('queued', 'generating')
    returning profile_plan.id, profile_plan.plan_id
  )
  select count(*)::bigint, coalesce(array_agg(distinct plan_id), '{}'::uuid[])
  into suspended_profiles, affected_plan_ids
  from suspended_plan_profiles;

  foreach affected_plan_id in array affected_plan_ids loop
    perform public.refresh_bulk_rotation_plan_state(affected_plan_id);
  end loop;
  foreach affected_batch_id in array affected_batch_ids loop
    perform public.sync_publication_batch_status(affected_batch_id);
  end loop;

  if suspended_items > 0 or suspended_profiles > 0 then
    insert into public.profile_publication_suspensions (
      organization_id, profile_id, profile_status, reason,
      suspended_item_count, suspended_plan_profile_count, metadata
    ) values (
      profile_row.organization_id, profile_row.id, profile_row.status, resolved_reason,
      suspended_items, suspended_profiles,
      jsonb_build_object('deleted', profile_row.deleted_at is not null, 'manual_resume_required', true)
    );
  end if;

  return jsonb_build_object(
    'profileId', profile_row.id,
    'profileStatus', profile_row.status::text,
    'suspendedItems', suspended_items::text,
    'suspendedPlanProfiles', suspended_profiles::text,
    'manualResumeRequired', true
  );
end;
$$;

create or replace function public.handle_profile_publication_suspension()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.deleted_at is not null and old.deleted_at is null)
    or (new.status <> 'online' and old.status is distinct from new.status)
  then
    perform public.suspend_offline_profile_publications(
      new.id,
      coalesce(new.last_error_message, format('Perfil %s; retomada manual necessária.', new.status::text)),
      'system: instagram-profile-status-trigger'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists instagram_profiles_suspend_publications on public.instagram_profiles;
create trigger instagram_profiles_suspend_publications
after update of status, deleted_at on public.instagram_profiles
for each row execute function public.handle_profile_publication_suspension();

create or replace function public.suspend_claimed_publication_item(
  p_item_id uuid,
  p_worker_id text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  profile_status public.instagram_profile_status;
  resolved_reason text := left(coalesce(nullif(trim(p_reason), ''),
    'Perfil offline; retomada manual necessária.'), 500);
begin
  select item.* into item_row
  from public.publication_items item
  where item.id = p_item_id
  for update;
  if item_row.id is null then
    raise exception using errcode = 'P0002', message = 'Item não encontrado para suspensão.';
  end if;
  if item_row.status = 'suspended' then
    return jsonb_build_object('itemId', item_row.id, 'status', 'suspended',
      'attemptCount', item_row.attempt_count, 'manualResumeRequired', true, 'idempotent', true);
  end if;
  if item_row.claimed_by is distinct from trim(p_worker_id)
    or item_row.status not in ('preparing', 'publishing') then
    raise exception using errcode = 'P0002', message = 'Item não está sob claim deste worker.';
  end if;

  select profile.status into profile_status
  from public.instagram_profiles profile
  where profile.id = item_row.profile_id
    and profile.organization_id = item_row.organization_id
    and profile.deleted_at is null;
  if profile_status = 'online' then
    raise exception using errcode = '22023', message = 'Perfil online não pode ter item suspenso pelo worker.';
  end if;

  update public.publication_items item
  set status = 'suspended', suspended_at = coalesce(item.suspended_at, timezone('utc', now())),
      suspension_reason = resolved_reason, claimed_by = null, lease_until = null,
      next_attempt_at = null,
      attempt_count = case when item.active_claim_consumed_attempt
        then greatest(item.attempt_count - 1, 0) else item.attempt_count end,
      active_claim_consumed_attempt = false,
      last_error_code = 'profile_offline_suspended', last_error_message = resolved_reason
  where item.id = item_row.id;

  delete from public.publication_profile_daily_reservations where publication_item_id = item_row.id;
  delete from public.publication_dispatch_rate_reservations where publication_item_id = item_row.id;
  perform public.log_publication_item_event(item_row.id, 'suspended', item_row.status, 'suspended', null,
    trim(p_worker_id), 'profile_offline_suspended', resolved_reason,
    jsonb_build_object('profile_id', item_row.profile_id, 'profile_status', coalesce(profile_status::text, 'deleted'),
      'claim_attempt_reverted', true));
  perform public.sync_publication_batch_status(item_row.batch_id);

  return jsonb_build_object('itemId', item_row.id, 'status', 'suspended',
    'attemptCount', case when item_row.active_claim_consumed_attempt
      then greatest(item_row.attempt_count - 1, 0) else item_row.attempt_count end,
    'manualResumeRequired', true, 'idempotent', false);
end;
$$;

-- Barreira barata usada pelo dispatcher imediatamente antes de qualquer chamada
-- externa. O lock do item serializa esta leitura com a suspensão disparada pelo
-- perfil; a chamada externa continua fora da transação, portanto a reconciliação
-- abaixo permanece necessária para uma confirmação concorrente do provedor.
create or replace function public.assert_claimed_publication_profile_online(
  p_item_id uuid,
  p_worker_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  profile_online boolean := false;
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;

  select item.* into item_row
  from public.publication_items item
  where item.id = p_item_id
  for update;

  if item_row.id is null then
    raise exception using errcode = 'P0002', message = 'Item de publicação não encontrado.';
  end if;
  if item_row.status = 'suspended' then
    return false;
  end if;
  if item_row.claimed_by is distinct from trim(p_worker_id)
    or item_row.lease_until is null
    or item_row.lease_until <= timezone('utc', now())
    or item_row.status not in ('preparing', 'publishing')
  then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker.';
  end if;

  select profile.deleted_at is null and profile.status = 'online'
  into profile_online
  from public.instagram_profiles profile
  where profile.id = item_row.profile_id
    and profile.organization_id = item_row.organization_id;

  return coalesce(profile_online, false);
end;
$$;

-- Se o provedor confirmou a publicação enquanto o trigger limpava o claim, a
-- verdade externa prevalece: convertemos o item suspenso em publicado e mantemos
-- os eventos de suspensão/publicação para auditoria, sem disparar novo envio.
create or replace function public.reconcile_confirmed_publication_item(
  p_item_id uuid,
  p_worker_id text,
  p_meta_media_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  resolved_now timestamptz := timezone('utc', now());
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;

  select item.* into item_row
  from public.publication_items item
  where item.id = p_item_id
  for update;

  if item_row.id is null then
    raise exception using errcode = 'P0002', message = 'Item de publicação não encontrado.';
  end if;
  if item_row.status = 'published' then
    return jsonb_build_object(
      'itemId', item_row.id,
      'status', 'published',
      'idempotent', true
    );
  end if;
  if item_row.status <> 'suspended'
    and (
      item_row.claimed_by is distinct from trim(p_worker_id)
      or item_row.lease_until is null
      or item_row.lease_until <= resolved_now
      or item_row.status not in ('preparing', 'publishing')
    )
  then
    raise exception using errcode = 'P0002', message = 'Item não pode ser reconciliado por este worker.';
  end if;

  update public.publication_items item
  set status = 'published',
      meta_media_id = coalesce(nullif(trim(p_meta_media_id), ''), item.meta_media_id),
      published_at = coalesce(item.published_at, resolved_now),
      claimed_by = null,
      lease_until = null,
      next_attempt_at = null,
      active_claim_consumed_attempt = false,
      suspended_at = null,
      suspension_reason = null,
      last_error_code = null,
      last_error_message = null
  where item.id = item_row.id;

  delete from public.publication_profile_daily_reservations
  where publication_item_id = item_row.id;
  delete from public.publication_dispatch_rate_reservations
  where publication_item_id = item_row.id;

  perform public.log_publication_item_event(
    item_row.id,
    'published',
    item_row.status,
    'published',
    null,
    trim(p_worker_id),
    null,
    null,
    jsonb_build_object(
      'provider_confirmation_reconciled', true,
      'was_suspended', item_row.status = 'suspended'
    )
  );
  perform public.mark_publication_item_media_as_published(item_row.id, item_row.organization_id);
  perform public.sync_publication_batch_status(item_row.batch_id);

  return jsonb_build_object(
    'itemId', item_row.id,
    'status', 'published',
    'idempotent', false,
    'reconciledFromSuspension', item_row.status = 'suspended'
  );
end;
$$;

-- Preserva o identificador aceito pelo provedor quando a suspensão vence a
-- corrida contra o defer do worker. O item continua suspenso; uma retomada futura
-- deverá consultar esse mesmo container/post em vez de criar uma duplicata.
create or replace function public.reconcile_suspended_publication_creation(
  p_item_id uuid,
  p_worker_id text,
  p_creation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  resolved_creation_id text := nullif(trim(coalesce(p_creation_id, '')), '');
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if resolved_creation_id is null or char_length(resolved_creation_id) > 500 then
    raise exception using errcode = '22023', message = 'Identificador externo inválido.';
  end if;

  select item.* into item_row
  from public.publication_items item
  where item.id = p_item_id
  for update;

  if item_row.id is null then
    raise exception using errcode = 'P0002', message = 'Item de publicação não encontrado.';
  end if;
  if item_row.creation_id is not null then
    if item_row.creation_id is distinct from resolved_creation_id then
      raise exception using errcode = '23505', message = 'Item já possui outro identificador externo.';
    end if;
    return jsonb_build_object(
      'itemId', item_row.id,
      'status', item_row.status::text,
      'creationId', item_row.creation_id,
      'idempotent', true
    );
  end if;
  if item_row.status <> 'suspended' then
    raise exception using errcode = 'P0002', message = 'Item não está suspenso para preservar a criação externa.';
  end if;

  update public.publication_items item
  set creation_id = resolved_creation_id
  where item.id = item_row.id;

  perform public.log_publication_item_event(
    item_row.id,
    'processing_deferred',
    item_row.status,
    item_row.status,
    null,
    trim(p_worker_id),
    'provider_creation_preserved_after_suspension',
    'O provedor aceitou a criação durante a suspensão; o identificador foi preservado para evitar duplicação.',
    jsonb_build_object(
      'creation_id', resolved_creation_id,
      'was_suspended', true
    )
  );

  return jsonb_build_object(
    'itemId', item_row.id,
    'status', item_row.status::text,
    'creationId', resolved_creation_id,
    'idempotent', false,
    'preservedWhileSuspended', true
  );
end;
$$;

create or replace function public.claim_publication_items(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  id uuid, organization_id uuid, batch_id uuid, profile_id uuid,
  format public.publication_format, status public.publication_item_status,
  execute_at timestamptz, caption text, idempotency_key text,
  attempt_count integer, creation_id text, lease_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Limite de claim deve estar entre 1 e 100';
  end if;
  if p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 900 segundos';
  end if;

  perform 1 from public.recover_missed_publication_slots(500, 120);

  return query
  with candidates as (
    select item.id
    from public.publication_items item
    join public.instagram_profiles profile on profile.id = item.profile_id
      and profile.organization_id = item.organization_id
    where profile.deleted_at is null and profile.status = 'online'
      and item.status in ('ready', 'waiting', 'preparing', 'failed')
      and (item.status <> 'failed' or item.attempt_count < 5)
      and (item.execute_at is null or item.execute_at <= timezone('utc', now()))
      and (item.next_attempt_at is null or item.next_attempt_at <= timezone('utc', now()))
      and (item.lease_until is null or item.lease_until <= timezone('utc', now()))
    order by coalesce(item.execute_at, item.created_at), item.created_at, item.id
    for update of item skip locked
    limit p_limit
  ), claimed as (
    update public.publication_items item
    set status = 'preparing', claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        next_attempt_at = null,
        active_claim_consumed_attempt = item.creation_id is null or item.status = 'failed',
        attempt_count = item.attempt_count + case
          when item.creation_id is null or item.status = 'failed' then 1 else 0 end
    from candidates
    where item.id = candidates.id
    returning item.id, item.organization_id, item.batch_id, item.profile_id,
      item.format, item.status, item.execute_at, item.caption, item.idempotency_key,
      item.attempt_count, item.creation_id, item.lease_until
  ), updated_batches as (
    update public.publication_batches batch
    set status = 'processing'
    where batch.id in (select claimed.batch_id from claimed)
      and batch.status in ('queued', 'validating')
  )
  select * from claimed;
end;
$$;

create or replace function public.recover_missed_publication_slots(
  p_max_items integer default 100,
  p_grace_seconds integer default 120
)
returns table (
  id uuid, organization_id uuid, profile_id uuid,
  previous_execute_at timestamptz, execute_at timestamptz, outcome text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  candidate_window_start timestamptz;
  candidate_minute timestamptz;
  recovered_at timestamptz := timezone('utc', now());
begin
  if p_max_items not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Limite de recuperação deve estar entre 1 e 500';
  end if;
  if p_grace_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Margem de atraso deve estar entre 30 e 3600 segundos';
  end if;

  for item_row in
    select item.*
    from public.publication_items item
    join public.instagram_profiles profile on profile.id = item.profile_id
      and profile.organization_id = item.organization_id
    where profile.deleted_at is null and profile.status = 'online'
      and item.status in ('waiting', 'ready')
      and item.execute_at is not null
      and item.execute_at <= recovered_at - make_interval(secs => p_grace_seconds)
      and (item.next_attempt_at is null or item.next_attempt_at <= recovered_at)
      and (item.lease_until is null or item.lease_until <= recovered_at)
      and item.creation_id is null
    order by item.execute_at, item.created_at, item.id
    for update of item skip locked
    limit p_max_items
  loop
    id := item_row.id; organization_id := item_row.organization_id;
    profile_id := item_row.profile_id; previous_execute_at := item_row.execute_at;

    if item_row.missed_schedule_recovery_count >= 1 then
      update public.publication_items item set status = 'failed', claimed_by = null,
        lease_until = null, next_attempt_at = null,
        last_error_code = 'missed_schedule_requires_attention',
        last_error_message = 'A publicação voltou a perder o horário após um reagendamento automático e precisa de intervenção manual.'
      where item.id = item_row.id;
      perform public.log_publication_item_event(item_row.id, 'failed', item_row.status, 'failed', null,
        'system: missed-schedule-recovery', 'missed_schedule_requires_attention',
        'A publicação voltou a perder o horário após um reagendamento automático e precisa de intervenção manual.',
        jsonb_build_object('previous_execute_at', item_row.execute_at, 'recovery_count', item_row.missed_schedule_recovery_count));
      perform public.sync_publication_batch_status(item_row.batch_id);
      execute_at := item_row.execute_at; outcome := 'requires_attention'; return next; continue;
    end if;

    candidate_window_start := (((item_row.execute_at at time zone 'America/Sao_Paulo')::date + 1)
      + date_trunc('hour', item_row.execute_at at time zone 'America/Sao_Paulo')::time
      + make_interval(mins => (extract(minute from item_row.execute_at at time zone 'America/Sao_Paulo')::integer / 10) * 10))
      at time zone 'America/Sao_Paulo';
    loop
      exit when candidate_window_start > recovered_at and not exists (
        select 1 from public.publication_items occupied
        where occupied.organization_id = item_row.organization_id
          and occupied.profile_id = item_row.profile_id
          and occupied.execute_at >= candidate_window_start
          and occupied.execute_at < candidate_window_start + interval '10 minutes'
          and occupied.status in ('waiting', 'ready', 'preparing', 'publishing'));
      candidate_window_start := candidate_window_start + interval '1 day';
    end loop;
    perform pg_advisory_xact_lock(hashtextextended(item_row.profile_id::text, 0));
    loop
      candidate_minute := null;
      select candidate.minute_start into candidate_minute
      from (select candidate_window_start + make_interval(mins => minute_offset) as minute_start
        from generate_series(1, 9) minute_offset) candidate
      where not exists (select 1 from public.publication_items occupied
        where occupied.organization_id = item_row.organization_id
          and occupied.profile_id = item_row.profile_id
          and date_trunc('minute', occupied.execute_at) = candidate.minute_start
          and occupied.status in ('waiting', 'ready', 'preparing', 'publishing'))
      order by random() limit 1;
      exit when candidate_minute is not null;
      candidate_window_start := candidate_window_start + interval '1 day';
    end loop;
    update public.publication_items item
    set execute_at = candidate_minute + make_interval(secs => floor(random() * 60)::integer),
      status = 'waiting', claimed_by = null, lease_until = null, next_attempt_at = null,
      missed_schedule_recovery_count = 1, last_error_code = 'missed_schedule_recovered',
      last_error_message = 'O worker não iniciou a publicação no horário previsto; ela foi reagendada automaticamente uma única vez.'
    where item.id = item_row.id returning item.execute_at into execute_at;
    perform public.log_publication_item_event(item_row.id, 'processing_deferred', item_row.status, 'waiting', null,
      'system: missed-schedule-recovery', 'missed_schedule_recovered',
      'O worker não iniciou a publicação no horário previsto; ela foi reagendada automaticamente uma única vez.',
      jsonb_build_object('previous_execute_at', item_row.execute_at, 'rescheduled_execute_at', execute_at, 'recovery_count', 1));
    perform public.sync_publication_batch_status(item_row.batch_id);
    outcome := 'rescheduled_once'; return next;
  end loop;
end;
$$;

create or replace function public.get_publication_queue_operational_summary(
  p_organization_id uuid default null
)
returns table (
  organization_id uuid, status public.publication_item_status, total integer,
  expired_leases integer, due_retries integer, overdue integer,
  oldest_execute_at timestamptz, max_lag_seconds integer
)
language sql stable security definer set search_path = public
as $$
  select item.organization_id, item.status, count(*)::integer,
    count(*) filter (where item.lease_until is not null and item.lease_until <= timezone('utc', now()))::integer,
    count(*) filter (where item.status = 'failed' and item.next_attempt_at is not null and item.next_attempt_at <= timezone('utc', now()))::integer,
    count(*) filter (where item.status in ('waiting', 'ready') and item.execute_at is not null
      and item.execute_at < timezone('utc', now()) - interval '120 seconds')::integer,
    min(item.execute_at) filter (where item.execute_at is not null),
    coalesce(max(greatest(0, extract(epoch from (timezone('utc', now()) - item.execute_at))::integer)) filter (
      where item.execute_at is not null and item.execute_at < timezone('utc', now())
        and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')), 0)::integer
  from public.publication_items item
  where item.archived_at is null
    and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')
    and (p_organization_id is null or item.organization_id = p_organization_id)
    and (auth.role() = 'service_role' or public.is_organization_member(item.organization_id))
  group by item.organization_id, item.status
  order by item.organization_id, item.status;
$$;

create or replace function public.get_publication_queue_reference_summary(
  p_organization_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with authorized as (
    select p_organization_id as organization_id
    where auth.role() = 'service_role' or public.is_organization_member(p_organization_id)
  ), operational_items as (
    select item.*
    from public.publication_items item
    join authorized auth_org on auth_org.organization_id = item.organization_id
    where item.archived_at is null
  ), totals as (
    select
      count(*)::integer as total,
      count(*) filter (where status = 'published')::integer as ok,
      count(*) filter (where status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where status in ('preparing', 'publishing'))::integer as processing,
      count(*) filter (where status = 'failed')::integer as errors,
      count(*) filter (where status = 'suspended')::integer as suspended,
      count(*) filter (where status in ('cancelled', 'removed', 'ignored'))::integer as closed,
      count(*) filter (
        where status in ('preparing', 'publishing')
          and lease_until is not null
          and lease_until <= timezone('utc', now())
      )::integer as expired_leases,
      count(distinct profile_id) filter (
        where status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
      )::integer as active_accounts,
      count(distinct profile_id) filter (where status = 'suspended')::integer as suspended_accounts,
      count(distinct profile_id)::integer as total_accounts
    from operational_items
  ), account_rows as (
    select
      item.profile_id as id,
      profile.username,
      profile.display_name,
      profile.profile_picture_url,
      count(*)::integer as total,
      count(*) filter (where item.status = 'published')::integer as completed,
      count(*) filter (where item.status = 'failed')::integer as errors,
      count(*) filter (where item.status = 'suspended')::integer as suspended,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer as processing,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')) as next_at,
      case
        when bool_or(item.status in ('preparing', 'publishing')) then 'posting'
        when bool_or(item.status = 'failed') then 'error'
        when bool_or(item.status in ('waiting', 'ready')) then 'idle'
        when bool_or(item.status = 'suspended') then 'suspended'
        else 'done'
      end as tone
    from operational_items item
    join public.instagram_profiles profile on profile.id = item.profile_id
    group by item.profile_id, profile.username, profile.display_name, profile.profile_picture_url
  ), batch_rows as (
    select
      item.batch_id as id,
      coalesce(batch.name, 'Sem campanha') as title,
      batch.created_at,
      count(*)::integer as total,
      count(*) filter (where item.status = 'published')::integer as completed,
      count(*) filter (where item.status = 'failed')::integer as errors,
      count(*) filter (where item.status = 'suspended')::integer as suspended,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer as processing,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')) as next_at,
      case
        when bool_or(item.status in ('preparing', 'publishing')) then 'posting'
        when bool_or(item.status = 'failed') then 'error'
        when bool_or(item.status in ('waiting', 'ready')) then 'idle'
        when bool_or(item.status = 'suspended') then 'suspended'
        else 'done'
      end as tone
    from operational_items item
    join public.publication_batches batch on batch.id = item.batch_id
    group by item.batch_id, batch.name, batch.created_at
  ), profile_membership as (
    select member.profile_id, member.group_id
    from public.profile_group_members member
    join authorized auth_org on auth_org.organization_id = member.organization_id
  ), group_rows as (
    select
      coalesce(membership.group_id::text, 'none') as id,
      coalesce(profile_group.name, 'Sem grupo') as title,
      count(*)::integer as total,
      count(*) filter (where item.status = 'published')::integer as completed,
      count(*) filter (where item.status = 'failed')::integer as errors,
      count(*) filter (where item.status = 'suspended')::integer as suspended,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer as processing,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')) as next_at,
      count(distinct item.profile_id)::integer as profile_count,
      case
        when bool_or(item.status in ('preparing', 'publishing')) then 'posting'
        when bool_or(item.status = 'failed') then 'error'
        when bool_or(item.status in ('waiting', 'ready')) then 'idle'
        when bool_or(item.status = 'suspended') then 'suspended'
        else 'done'
      end as tone
    from operational_items item
    left join profile_membership membership on membership.profile_id = item.profile_id
    left join public.profile_groups profile_group on profile_group.id = membership.group_id
    group by membership.group_id, profile_group.name
  ), archived as (
    select count(*)::integer as total
    from public.publication_items item
    join authorized auth_org on auth_org.organization_id = item.organization_id
    where item.archived_at is not null
  )
  select jsonb_build_object(
    'snapshotAt', timezone('utc', now()),
    'totals', jsonb_build_object(
      'total', totals.total,
      'ok', totals.ok,
      'pending', totals.pending,
      'processing', totals.processing,
      'errors', totals.errors,
      'suspended', totals.suspended,
      'closed', totals.closed,
      'archived', archived.total,
      'expiredLeases', totals.expired_leases,
      'activeAccounts', totals.active_accounts,
      'suspendedAccounts', totals.suspended_accounts,
      'totalAccounts', totals.total_accounts,
      'progress', case when totals.total = 0 then 0 else round((totals.ok::numeric / totals.total::numeric) * 100)::integer end
    ),
    'accounts', coalesce((select jsonb_agg(to_jsonb(account_rows) order by processing desc, errors desc, suspended desc, next_at nulls last, username) from account_rows), '[]'::jsonb),
    'batches', coalesce((select jsonb_agg(to_jsonb(batch_rows) order by processing desc, errors desc, suspended desc, created_at desc) from batch_rows), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(to_jsonb(group_rows) order by processing desc, errors desc, suspended desc, title) from group_rows), '[]'::jsonb)
  )
  from totals cross join archived;
$$;

revoke all on function public.suspend_offline_profile_publications(uuid, text, text) from public, anon, authenticated;
revoke all on function public.suspend_claimed_publication_item(uuid, text, text) from public, anon, authenticated;
revoke all on function public.assert_claimed_publication_profile_online(uuid, text) from public, anon, authenticated;
revoke all on function public.reconcile_confirmed_publication_item(uuid, text, text) from public, anon, authenticated;
revoke all on function public.reconcile_suspended_publication_creation(uuid, text, text) from public, anon, authenticated;
revoke all on function public.claim_publication_items(text, integer, integer) from public, anon, authenticated;
revoke all on function public.recover_missed_publication_slots(integer, integer) from public, anon, authenticated;
grant execute on function public.suspend_offline_profile_publications(uuid, text, text) to service_role;
grant execute on function public.suspend_claimed_publication_item(uuid, text, text) to service_role;
grant execute on function public.assert_claimed_publication_profile_online(uuid, text) to service_role;
grant execute on function public.reconcile_confirmed_publication_item(uuid, text, text) to service_role;
grant execute on function public.reconcile_suspended_publication_creation(uuid, text, text) to service_role;
grant execute on function public.claim_publication_items(text, integer, integer) to service_role;
grant execute on function public.recover_missed_publication_slots(integer, integer) to service_role;
