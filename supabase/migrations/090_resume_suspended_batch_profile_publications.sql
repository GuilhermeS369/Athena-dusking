-- Retomada manual e isolada por lote/perfil. A migration 089 precisa ter sido
-- commitada antes, pois este código usa o novo valor de enum `resumed`.

create table public.profile_publication_resumptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  batch_id uuid not null references public.publication_batches (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  plan_id uuid references public.bulk_publication_plans (id) on delete set null,
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_label text check (actor_label is null or char_length(trim(actor_label)) <= 160),
  resumed_item_count bigint not null default 0 check (resumed_item_count >= 0),
  ignored_item_count bigint not null default 0 check (ignored_item_count >= 0),
  resumed_compact_slot_count bigint not null default 0 check (resumed_compact_slot_count >= 0),
  ignored_compact_slot_count bigint not null default 0 check (ignored_compact_slot_count >= 0),
  safe_base_at timestamptz,
  first_execute_at timestamptz,
  last_execute_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now())
);

create index profile_publication_resumptions_pair_created_idx
  on public.profile_publication_resumptions (
    organization_id, batch_id, profile_id, created_at desc
  );

alter table public.profile_publication_resumptions enable row level security;
create policy profile_publication_resumptions_select_member
on public.profile_publication_resumptions for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.profile_publication_resumptions from public, anon, authenticated;
grant select on table public.profile_publication_resumptions to authenticated;
grant all on table public.profile_publication_resumptions to service_role;

create or replace function public.resume_suspended_batch_profile_publications(
  p_organization_id uuid,
  p_batch_id uuid,
  p_profile_id uuid,
  p_now timestamptz default null,
  p_actor_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_now timestamptz := coalesce(p_now, timezone('utc', now()));
  resolved_user_id uuid := auth.uid();
  resolved_actor_label text := nullif(left(trim(coalesce(p_actor_label, auth.jwt() ->> 'email', '')), 160), '');
  batch_row public.publication_batches%rowtype;
  profile_row public.instagram_profiles%rowtype;
  plan_row public.bulk_publication_plans%rowtype;
  profile_plan public.bulk_publication_plan_profiles%rowtype;
  chunk_row public.bulk_publication_generation_chunks%rowtype;
  horizon_row public.bulk_publication_profile_horizons%rowtype;
  active_last timestamptz;
  reserved_last timestamptz;
  safe_base timestamptz;
  first_execute timestamptz;
  last_execute timestamptz;
  traditional_interval_minutes integer;
  traditional_resumed bigint := 0;
  traditional_ignored bigint := 0;
  traditional_event_count bigint := 0;
  compact_resumed bigint := 0;
  compact_ignored bigint := 0;
  compact_next_slot bigint;
  compact_remaining bigint;
  elapsed_intervals bigint;
  resumed_plan_id uuid;
  audit_id uuid;
begin
  if auth.role() <> 'service_role' and (
    resolved_user_id is null
    or not public.has_organization_role(
      p_organization_id,
      array['admin', 'operator']::public.organization_role[]
    )
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if p_organization_id is null or p_batch_id is null or p_profile_id is null then
    raise exception using errcode = '22023', message = 'Organização, lote e perfil são obrigatórios.';
  end if;

  select batch.* into batch_row
  from public.publication_batches batch
  where batch.id = p_batch_id and batch.organization_id = p_organization_id
  for update;
  if batch_row.id is null then
    raise exception using errcode = 'P0002', message = 'Lote não encontrado para retomada.';
  end if;

  select profile.* into profile_row
  from public.instagram_profiles profile
  where profile.id = p_profile_id and profile.organization_id = p_organization_id
  for update;
  if profile_row.id is null then
    raise exception using errcode = 'P0002', message = 'Perfil não encontrado para retomada.';
  end if;
  if profile_row.deleted_at is not null or profile_row.status <> 'online' then
    raise exception using errcode = '22023', message = 'O perfil precisa estar online para retomar publicações.';
  end if;

  -- Serializa suspensão, criação de novos planos e retomadas para este perfil.
  perform pg_advisory_xact_lock(hashtextextended('profile-publication-suspension:' || profile_row.id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(profile_row.id::text, 0));

  select plan.* into plan_row
  from public.bulk_publication_plans plan
  where plan.organization_id = p_organization_id and plan.batch_id = p_batch_id
  for update;

  if plan_row.id is not null then
    resumed_plan_id := plan_row.id;
    select profile_plan_row.* into profile_plan
    from public.bulk_publication_plan_profiles profile_plan_row
    where profile_plan_row.plan_id = plan_row.id
      and profile_plan_row.profile_id = profile_row.id
    for update;

    if profile_plan.id is null then
      raise exception using errcode = 'P0002', message = 'O perfil não pertence a este plano compacto.';
    end if;
    select chunk.* into chunk_row
    from public.bulk_publication_generation_chunks chunk
    where chunk.plan_profile_id = profile_plan.id
    for update;
    if chunk_row.id is null then
      raise exception using errcode = 'P0002', message = 'Chunk compacto não encontrado.';
    end if;
    if profile_plan.status = 'suspended' and chunk_row.status <> 'paused' then
      raise exception using errcode = '22023', message = 'O chunk compacto não está pausado para retomada.';
    end if;
    if profile_plan.status <> 'suspended' and not exists (
      select 1 from public.publication_items item
      where item.organization_id = p_organization_id
        and item.batch_id = p_batch_id
        and item.profile_id = p_profile_id
        and item.status = 'suspended'
    ) then
      raise exception using errcode = '22023', message = 'Não existem publicações suspensas para este lote e perfil.';
    end if;

    select horizon.* into horizon_row
    from public.bulk_publication_profile_horizons horizon
    where horizon.plan_profile_id = profile_plan.id
    for update;
    if horizon_row.id is null then
      raise exception using errcode = 'P0002', message = 'Horizonte compacto não encontrado.';
    end if;

    compact_next_slot := greatest(profile_plan.next_slot_index, chunk_row.next_slot_index);
    elapsed_intervals := case
      when resolved_now <= profile_plan.schedule_base_at then 0
      else floor(extract(epoch from (resolved_now - profile_plan.schedule_base_at))
        / (plan_row.interval_minutes::numeric * 60::numeric))::bigint
    end;
    compact_next_slot := greatest(
      compact_next_slot,
      least(elapsed_intervals, profile_plan.total_slot_count)
    );
    compact_ignored := compact_next_slot
      - greatest(profile_plan.next_slot_index, chunk_row.next_slot_index);
    compact_remaining := profile_plan.total_slot_count - compact_next_slot;

    select max(item.execute_at) into active_last
    from public.publication_items item
    where item.organization_id = p_organization_id
      and item.profile_id = profile_row.id
      and item.batch_id <> p_batch_id
      and item.status in ('waiting', 'ready', 'preparing', 'publishing')
      and item.execute_at is not null;
    select max(horizon.reserved_through) into reserved_last
    from public.bulk_publication_profile_horizons horizon
    where horizon.organization_id = p_organization_id
      and horizon.profile_id = profile_row.id
      and horizon.plan_profile_id <> profile_plan.id
      and horizon.status = 'active';
    safe_base := greatest(resolved_now, coalesce(active_last, resolved_now), coalesce(reserved_last, resolved_now));

    -- Itens já materializados deste par são tratados isoladamente. Os vencidos
    -- são encerrados; os futuros são redistribuídos junto do restante do plano.
    with candidates as (
      select item.id, item.execute_at,
        substring(item.idempotency_key from ':([0-9]+)$')::bigint as original_slot_index
      from public.publication_items item
      where item.organization_id = p_organization_id
        and item.batch_id = p_batch_id
        and item.profile_id = profile_row.id
        and item.status = 'suspended'
      for update
    ), classified as (
      select candidates.*,
        candidates.execute_at is null or candidates.execute_at <= resolved_now as expired,
        sum(case when candidates.execute_at is not null and candidates.execute_at > resolved_now
          then 1 else 0 end) over (
            order by candidates.original_slot_index, candidates.id
            rows between unbounded preceding and current row
          ) as future_ordinal
      from candidates
    ), updated as (
      update public.publication_items item
      set status = case when classified.expired
            then 'ignored'::public.publication_item_status
            else 'waiting'::public.publication_item_status end,
          execute_at = case when classified.expired then item.execute_at
            else safe_base + (((classified.future_ordinal * plan_row.interval_minutes)::text || ' minutes')::interval)
          end,
          suspended_at = null,
          suspension_reason = null,
          next_attempt_at = null,
          lease_until = null,
          claimed_by = null,
          active_claim_consumed_attempt = false,
          last_error_code = null,
          last_error_message = null
      from classified
      where item.id = classified.id
      returning item.id, classified.expired, classified.original_slot_index,
        classified.execute_at as previous_execute_at, item.execute_at
    ), events as (
      insert into public.publication_item_events (
        organization_id, publication_item_id, event_type, previous_status, status,
        actor_user_id, actor_label, metadata
      )
      select p_organization_id, updated.id, 'resumed', 'suspended',
        case when updated.expired
          then 'ignored'::public.publication_item_status
          else 'waiting'::public.publication_item_status end,
        resolved_user_id, resolved_actor_label,
        jsonb_build_object(
          'action', 'manual_batch_profile_resume',
          'batch_id', p_batch_id,
          'profile_id', p_profile_id,
          'bulk_plan_id', plan_row.id,
          'expired', updated.expired,
          'original_slot_index', updated.original_slot_index::text,
          'previous_execute_at', updated.previous_execute_at,
          'rescheduled_execute_at', updated.execute_at
        )
      from updated
      returning publication_item_id
    )
    select
      count(*) filter (where not updated.expired)::bigint,
      count(*) filter (where updated.expired)::bigint,
      (select count(*)::bigint from events)
    into traditional_resumed, traditional_ignored, traditional_event_count
    from updated;

    if traditional_event_count <> traditional_resumed + traditional_ignored then
      raise exception using errcode = 'P0001', message = 'Falha ao auditar itens retomados do plano compacto.';
    end if;

    compact_resumed := case when profile_plan.status = 'suspended' then compact_remaining else 0 end;
    if traditional_resumed > 0 then
      first_execute := safe_base + make_interval(mins => plan_row.interval_minutes);
      last_execute := safe_base + (((traditional_resumed * plan_row.interval_minutes::bigint)::text || ' minutes')::interval);
      safe_base := last_execute;
    end if;

    update public.bulk_publication_plan_profiles
    set status = case when compact_remaining > 0 then 'queued' else 'completed' end,
        schedule_base_at = safe_base
          - (((compact_next_slot * plan_row.interval_minutes::bigint)::text || ' minutes')::interval),
        first_execute_at = case when compact_remaining > 0
          then safe_base + make_interval(mins => plan_row.interval_minutes)
          else first_execute_at end,
        last_execute_at = case when compact_remaining > 0
          then safe_base + (((compact_remaining * plan_row.interval_minutes::bigint)::text || ' minutes')::interval)
          else last_execute_at end,
        next_slot_index = compact_next_slot,
        generated_slot_count = greatest(generated_slot_count - traditional_ignored, 0),
        ignored_slot_count = ignored_slot_count + compact_ignored + traditional_ignored,
        suspended_at = null,
        suspension_reason = null,
        last_resumed_at = resolved_now,
        resume_count = resume_count + 1
    where id = profile_plan.id
      and profile_plan.status = 'suspended';

    update public.bulk_publication_generation_chunks
    set status = case when compact_remaining > 0 then 'queued' else 'completed' end,
        slot_start = case when compact_remaining > 0 then compact_next_slot else slot_start end,
        slot_count = case when compact_remaining > 0 then compact_remaining else slot_count end,
        next_slot_index = compact_next_slot,
        generated_items = case when compact_remaining > 0 then 0 else generated_items end,
        ignored_items = case when compact_remaining > 0 then 0 else ignored_items end,
        failed_items = case when compact_remaining > 0 then 0 else failed_items end,
        claimed_by = null,
        lease_until = null,
        last_error_message = null,
        completed_at = case when compact_remaining > 0 then null else resolved_now end
    where id = chunk_row.id
      and profile_plan.status = 'suspended';

    if profile_plan.status = 'suspended' and compact_remaining > 0 then
      first_execute := safe_base + make_interval(mins => plan_row.interval_minutes);
      last_execute := safe_base + (((compact_remaining * plan_row.interval_minutes::bigint)::text || ' minutes')::interval);
      update public.bulk_publication_profile_horizons
      set status = 'active', reserved_from = safe_base,
          first_execute_at = first_execute, reserved_through = last_execute,
          slot_count = compact_remaining, released_at = null
      where id = horizon_row.id;
    elsif profile_plan.status = 'suspended' then
      update public.bulk_publication_profile_horizons
      set status = 'completed', released_at = coalesce(released_at, resolved_now)
      where id = horizon_row.id;
    end if;

    perform public.refresh_bulk_rotation_plan_state(plan_row.id);
  else
    -- Fluxos tradicionais não possuem intervalo persistido. Usa-se a menor
    -- diferença positiva original do par; com um único item, mantém 60 minutos.
    select coalesce(
      min(greatest(1, floor(extract(epoch from (ordered.execute_at - ordered.previous_execute_at)) / 60)::integer)),
      60
    ) into traditional_interval_minutes
    from (
      select item.execute_at,
        lag(item.execute_at) over (order by item.execute_at, item.id) as previous_execute_at
      from public.publication_items item
      where item.organization_id = p_organization_id
        and item.batch_id = p_batch_id
        and item.profile_id = profile_row.id
        and item.status = 'suspended'
        and item.execute_at is not null
    ) ordered
    where ordered.previous_execute_at is not null;

    select max(item.execute_at) into active_last
    from public.publication_items item
    where item.organization_id = p_organization_id
      and item.profile_id = profile_row.id
      and item.batch_id <> p_batch_id
      and item.status in ('waiting', 'ready', 'preparing', 'publishing')
      and item.execute_at is not null;
    select max(horizon.reserved_through) into reserved_last
    from public.bulk_publication_profile_horizons horizon
    where horizon.organization_id = p_organization_id
      and horizon.profile_id = profile_row.id
      and horizon.status = 'active';
    safe_base := greatest(resolved_now, coalesce(active_last, resolved_now), coalesce(reserved_last, resolved_now));

    with locked as (
      select item.id, item.execute_at
      from public.publication_items item
      where item.organization_id = p_organization_id
        and item.batch_id = p_batch_id
        and item.profile_id = profile_row.id
        and item.status = 'suspended'
      for update
    ), candidates as (
      select locked.id, locked.execute_at,
        locked.execute_at is not null and locked.execute_at <= resolved_now as expired,
        sum(case when locked.execute_at is null or locked.execute_at > resolved_now then 1 else 0 end)
          over (order by locked.execute_at nulls first, locked.id rows between unbounded preceding and current row)
          as future_ordinal
      from locked
    ), updated as (
      update public.publication_items item
      set status = case when candidates.expired
            then 'ignored'::public.publication_item_status
            else 'waiting'::public.publication_item_status end,
          execute_at = case when candidates.expired then item.execute_at
            else safe_base + (((candidates.future_ordinal * traditional_interval_minutes)::text || ' minutes')::interval)
          end,
          suspended_at = null, suspension_reason = null,
          next_attempt_at = null, lease_until = null, claimed_by = null,
          active_claim_consumed_attempt = false,
          last_error_code = null, last_error_message = null
      from candidates
      where item.id = candidates.id
      returning item.id, candidates.expired, candidates.execute_at as previous_execute_at, item.execute_at
    ), events as (
      insert into public.publication_item_events (
        organization_id, publication_item_id, event_type, previous_status, status,
        actor_user_id, actor_label, metadata
      )
      select p_organization_id, updated.id, 'resumed', 'suspended',
        case when updated.expired
          then 'ignored'::public.publication_item_status
          else 'waiting'::public.publication_item_status end,
        resolved_user_id, resolved_actor_label,
        jsonb_build_object(
          'action', 'manual_batch_profile_resume', 'batch_id', p_batch_id,
          'profile_id', p_profile_id, 'expired', updated.expired,
          'previous_execute_at', updated.previous_execute_at,
          'rescheduled_execute_at', updated.execute_at,
          'interval_minutes', traditional_interval_minutes
        )
      from updated returning publication_item_id
    )
    select count(*) filter (where not updated.expired)::bigint,
      count(*) filter (where updated.expired)::bigint,
      (select count(*)::bigint from events)
    into traditional_resumed, traditional_ignored, traditional_event_count
    from updated;

    if traditional_event_count = 0 then
      raise exception using errcode = '22023', message = 'Não existem publicações suspensas para este lote e perfil.';
    end if;
    if traditional_event_count <> traditional_resumed + traditional_ignored then
      raise exception using errcode = 'P0001', message = 'Falha ao auditar a retomada tradicional.';
    end if;
    if traditional_resumed > 0 then
      first_execute := safe_base + make_interval(mins => traditional_interval_minutes);
      last_execute := safe_base + (((traditional_resumed * traditional_interval_minutes::bigint)::text || ' minutes')::interval);
    end if;
  end if;

  perform public.sync_publication_batch_status(p_batch_id);

  insert into public.profile_publication_resumptions (
    organization_id, batch_id, profile_id, plan_id, actor_user_id, actor_label,
    resumed_item_count, ignored_item_count, resumed_compact_slot_count,
    ignored_compact_slot_count, safe_base_at, first_execute_at, last_execute_at,
    metadata
  ) values (
    p_organization_id, p_batch_id, p_profile_id, resumed_plan_id,
    resolved_user_id, resolved_actor_label, traditional_resumed,
    traditional_ignored, compact_resumed, compact_ignored,
    safe_base, first_execute, last_execute,
    jsonb_build_object('manual', true, 'isolated_batch_profile', true)
  ) returning id into audit_id;

  return jsonb_build_object(
    'resumptionId', audit_id,
    'organizationId', p_organization_id,
    'batchId', p_batch_id,
    'profileId', p_profile_id,
    'planId', resumed_plan_id,
    'resumedItems', traditional_resumed::text,
    'ignoredItems', traditional_ignored::text,
    'resumedCompactSlots', compact_resumed::text,
    'ignoredCompactSlots', compact_ignored::text,
    'safeBaseAt', safe_base,
    'firstExecuteAt', first_execute,
    'lastExecuteAt', last_execute
  );
end;
$$;

revoke all on function public.resume_suspended_batch_profile_publications(uuid, uuid, uuid, timestamptz, text)
  from public, anon;
grant execute on function public.resume_suspended_batch_profile_publications(uuid, uuid, uuid, timestamptz, text)
  to authenticated, service_role;
