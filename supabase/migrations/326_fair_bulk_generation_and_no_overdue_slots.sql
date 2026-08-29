-- Incidente 29/08/2026: agendamentos criados a partir das 03:31 UTC ficaram com
-- ZERO itens gerados por mais de 7 horas, enquanto planos mais antigos geravam
-- normalmente. A fronteira caiu exatamente na ordem de criação dos planos.
--
-- Causa raiz: claim_bulk_rotation_generation_chunks seleciona os chunks com
-- `order by plan.created_at, plan.id, ...` — prioridade absoluta por idade, sem
-- nenhuma forma de rodízio. Combinado com o horizonte de 48h em
-- process_bulk_rotation_generation_chunk (cada perfil de um plano de rotação
-- horária ganha 1 slot novo por hora, indefinidamente, até o plano acabar), os
-- planos antigos NUNCA ficam ociosos: eles reabastecem a fila de prioridade na
-- mesma velocidade em que ela é drenada. Nenhum plano novo recebe um ciclo.
--
-- Esta migration corrige dois pontos independentes:
--
-- 1. Justiça: o claim passa a fazer rodízio entre planos (uma posição por plano
--    por rodada), com prioridade extra para planos que ainda não geraram nada.
--    Mesmo padrão de fairness que claim_publication_items já usa por
--    organização/perfil desde a 315.
--
-- 2. Nunca gerar item já vencido: process_bulk_rotation_generation_chunk passa a
--    avançar o cursor automaticamente para além dos slots cujo horário já
--    passou, sem materializar publication_items. Hoje essa política só existe
--    como operação manual (advance_bulk_rotation_cursor_past_cutoff, 312) — e,
--    como a 315 removeu de propósito o descarte por atraso no despacho, um item
--    vencido criado tarde seria publicado tarde, sem limite. A regra passa a ser
--    invariante do gerador.

-- ---------------------------------------------------------------------------
-- 1. Claim justo entre planos
-- ---------------------------------------------------------------------------

create or replace function public.claim_bulk_rotation_generation_chunks(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 300,
  p_max_failures integer default 3
)
returns table (
  id uuid, plan_id uuid, plan_profile_id uuid, organization_id uuid,
  profile_id uuid, status text, slot_start text, slot_count text,
  next_slot_index text, attempt_count integer, lease_until timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  affected_plan_id uuid;
  affected_plan_ids uuid[] := '{}'::uuid[];
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if p_limit not between 1 and 50 or p_lease_seconds not between 60 and 3600
    or p_max_failures not between 1 and 20 then
    raise exception using errcode = '22023', message = 'Parâmetros de claim inválidos.';
  end if;

  with paused_chunks as (
    update public.bulk_publication_generation_chunks chunk
    set status = 'paused', claimed_by = null, lease_until = null,
        last_error_message = 'Perfil offline; geração suspensa sem consumir retry.'
    from public.bulk_publication_plan_profiles profile_plan
    join public.instagram_profiles profile on profile.id = profile_plan.profile_id
    where chunk.plan_profile_id = profile_plan.id
      and chunk.status in ('queued', 'processing', 'failed')
      and chunk.retry_exhausted_at is null
      and (chunk.claimed_by is null or chunk.lease_until is null or chunk.lease_until <= timezone('utc', now()))
      and (profile.deleted_at is not null or profile.status <> 'online')
    returning chunk.plan_id, chunk.plan_profile_id
  ), suspended_profiles as (
    update public.bulk_publication_plan_profiles profile_plan
    set status = 'suspended', suspended_at = coalesce(profile_plan.suspended_at, timezone('utc', now())),
        suspension_reason = 'Perfil offline; geração suspensa sem consumir retry.'
    where profile_plan.id in (select paused.plan_profile_id from paused_chunks paused)
    returning profile_plan.plan_id
  )
  select coalesce(array_agg(distinct suspended.plan_id), '{}'::uuid[])
  into affected_plan_ids from suspended_profiles suspended;

  foreach affected_plan_id in array affected_plan_ids loop
    perform public.refresh_bulk_rotation_plan_state(affected_plan_id);
  end loop;

  return query
  -- `ranked` não pode conter FOR UPDATE (funções de janela e locking não
  -- coexistem no mesmo nível), por isso o lock é aplicado depois em `candidates`,
  -- exatamente como claim_publication_items faz.
  with ranked as (
    select chunk.id,
      chunk.plan_id as ranked_plan_id,
      plan.created_at as plan_created_at,
      -- posição do chunk dentro do próprio plano: a rodada N atende a N-ésima
      -- posição de cada plano ativo, então nenhum plano monopoliza o worker.
      row_number() over (
        partition by chunk.plan_id
        order by profile_plan.ordinal, chunk.chunk_ordinal, chunk.id
      ) as plan_position,
      -- um plano que ainda não gerou nada é o pior caso possível de experiência
      -- (o lote aparece vazio para o usuário): ele fura a fila.
      case when plan.generated_publications = 0 then 0 else 1 end as starvation_band
    from public.bulk_publication_generation_chunks chunk
    join public.bulk_publication_plans plan on plan.id = chunk.plan_id
    join public.bulk_publication_plan_profiles profile_plan on profile_plan.id = chunk.plan_profile_id
    join public.instagram_profiles profile on profile.id = chunk.profile_id
    where plan.status in ('queued', 'generating')
      and profile_plan.status in ('queued', 'generating')
      and profile.deleted_at is null and profile.status = 'online'
      and chunk.status in ('queued', 'processing', 'failed')
      and chunk.retry_exhausted_at is null
      and chunk.consecutive_failure_count < p_max_failures
      and (chunk.lease_until is null or chunk.lease_until <= timezone('utc', now()))
      and profile_plan.schedule_base_at
        + ((((chunk.next_slot_index + 1) * plan.interval_minutes::bigint)::text || ' minutes')::interval)
          <= timezone('utc', now()) + interval '48 hours'
  ), selected as (
    select ranked.id from ranked
    order by ranked.starvation_band, ranked.plan_position,
      ranked.plan_created_at, ranked.ranked_plan_id, ranked.id
    limit p_limit
  ), candidates as (
    select chunk.id
    from public.bulk_publication_generation_chunks chunk
    join selected on selected.id = chunk.id
    for update of chunk skip locked
  ), claimed as (
    update public.bulk_publication_generation_chunks chunk
    set status = 'processing', claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        attempt_count = chunk.attempt_count + 1, last_error_message = null
    from candidates where chunk.id = candidates.id returning chunk.*
  ), activated_profiles as (
    update public.bulk_publication_plan_profiles profile_plan set status = 'generating'
    where profile_plan.id in (select claimed.plan_profile_id from claimed)
    returning profile_plan.plan_id
  ), activated_plans as (
    update public.bulk_publication_plans plan
    set status = 'generating', started_at = coalesce(plan.started_at, timezone('utc', now())), completed_at = null
    where plan.id in (select activated.plan_id from activated_profiles activated)
    returning plan.id
  )
  select claimed.id, claimed.plan_id, claimed.plan_profile_id, claimed.organization_id,
    claimed.profile_id, claimed.status, claimed.slot_start::text, claimed.slot_count::text,
    claimed.next_slot_index::text, claimed.attempt_count, claimed.lease_until
  from claimed;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Nunca materializar slot com horário já vencido
-- ---------------------------------------------------------------------------

create or replace function public.process_bulk_rotation_generation_chunk(
  p_chunk_id uuid,
  p_worker_id text,
  p_step_size integer default 50
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  chunk_row public.bulk_publication_generation_chunks%rowtype;
  profile_plan public.bulk_publication_plan_profiles%rowtype;
  plan_row public.bulk_publication_plans%rowtype;
  range_start bigint;
  range_end bigint;
  horizon_slot_exclusive bigint;
  segment_end bigint;
  first_future_slot bigint;
  skipped_overdue bigint := 0;
  total_ignored bigint;
  inserted_count bigint := 0;
  materialized_count bigint := 0;
  completed boolean;
begin
  if p_step_size not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Passo adaptativo deve estar entre 1 e 100 slots.';
  end if;
  select * into chunk_row from public.bulk_publication_generation_chunks chunk
  where chunk.id = p_chunk_id and chunk.claimed_by = trim(p_worker_id)
    and chunk.status = 'processing' for update;
  if chunk_row.id is null then
    raise exception using errcode = 'P0002', message = 'Chunk compacto não encontrado ou pertence a outro worker.';
  end if;
  select * into profile_plan from public.bulk_publication_plan_profiles
  where id = chunk_row.plan_profile_id for update;
  select * into plan_row from public.bulk_publication_plans where id = chunk_row.plan_id;
  if profile_plan.id is null or plan_row.id is null or plan_row.status not in ('queued', 'generating') then
    raise exception using errcode = 'P0002', message = 'Plano compacto não está disponível para geração.';
  end if;

  if not exists (
    select 1 from public.instagram_profiles profile
    where profile.id = chunk_row.profile_id and profile.organization_id = chunk_row.organization_id
      and profile.deleted_at is null and profile.status = 'online'
  ) then
    update public.bulk_publication_generation_chunks
    set status = 'paused', claimed_by = null, lease_until = null,
        attempt_count = greatest(attempt_count - 1, 0),
        last_error_message = 'Perfil offline; geração suspensa sem consumir retry.'
    where id = chunk_row.id;
    update public.bulk_publication_plan_profiles
    set status = 'suspended', suspended_at = coalesce(suspended_at, timezone('utc', now())),
        suspension_reason = 'Perfil offline; retomada manual necessária.'
    where id = profile_plan.id;
    perform public.refresh_bulk_rotation_plan_state(plan_row.id);
    return jsonb_build_object('chunkId', chunk_row.id, 'planId', plan_row.id,
      'status', 'suspended', 'generatedItems', '0', 'nextSlotIndex', chunk_row.next_slot_index::text);
  end if;

  segment_end := chunk_row.slot_start + chunk_row.slot_count;

  -- INVARIANTE: nunca materializar um slot cujo execute_at já passou.
  -- execute_at(i) = schedule_base_at + (i + 1) * interval_minutes, logo o
  -- primeiro slot ainda não vencido é floor((now - base) / interval).
  -- Mesma fórmula usada por advance_bulk_rotation_cursor_past_cutoff (312).
  first_future_slot := greatest(chunk_row.next_slot_index, floor(
    extract(epoch from (timezone('utc', now()) - profile_plan.schedule_base_at))
      / 60 / plan_row.interval_minutes
  )::bigint);
  skipped_overdue := greatest(least(first_future_slot, segment_end) - chunk_row.next_slot_index, 0);
  range_start := least(first_future_slot, segment_end);
  total_ignored := chunk_row.ignored_items + skipped_overdue;

  horizon_slot_exclusive := greatest(0, floor(
    extract(epoch from ((timezone('utc', now()) + interval '48 hours') - profile_plan.schedule_base_at))
      / 60 / plan_row.interval_minutes
  )::bigint);
  range_end := least(range_start + p_step_size::bigint, segment_end, horizon_slot_exclusive);

  if range_start >= segment_end then
    update public.bulk_publication_generation_chunks
    set status = 'completed', claimed_by = null, lease_until = null,
        next_slot_index = range_start,
        ignored_items = total_ignored,
        generated_items = greatest(range_start - chunk_row.slot_start - total_ignored, 0),
        completed_at = coalesce(completed_at, timezone('utc', now())), last_progress_at = timezone('utc', now())
    where id = chunk_row.id;
    update public.bulk_publication_plan_profiles
    set status = 'completed', next_slot_index = total_slot_count,
        ignored_slot_count = profile_plan.ignored_slot_count + skipped_overdue,
        generated_slot_count = greatest(total_slot_count - (profile_plan.ignored_slot_count + skipped_overdue), 0)
    where id = profile_plan.id;
    update public.bulk_publication_profile_horizons
    set status = 'completed', released_at = coalesce(released_at, timezone('utc', now()))
    where plan_profile_id = profile_plan.id and status = 'active';
    perform public.refresh_bulk_rotation_plan_state(plan_row.id);
    return jsonb_build_object('chunkId', chunk_row.id, 'planId', plan_row.id,
      'status', 'completed', 'generatedItems', '0',
      'skippedOverdueItems', skipped_overdue::text,
      'nextSlotIndex', range_start::text);
  end if;

  if range_start >= range_end then
    -- Só há slots além do horizonte de 48h. Persiste o avanço por vencimento
    -- (se houve) antes de devolver o chunk para a fila.
    update public.bulk_publication_generation_chunks
    set status = 'queued', claimed_by = null, lease_until = null,
        next_slot_index = range_start,
        ignored_items = total_ignored,
        generated_items = greatest(range_start - chunk_row.slot_start - total_ignored, 0),
        attempt_count = greatest(attempt_count - 1, 0), last_error_message = null,
        last_progress_at = case when skipped_overdue > 0 then timezone('utc', now()) else last_progress_at end
    where id = chunk_row.id;
    if skipped_overdue > 0 then
      update public.bulk_publication_plan_profiles
      set next_slot_index = range_start,
          ignored_slot_count = profile_plan.ignored_slot_count + skipped_overdue,
          generated_slot_count = greatest(range_start - chunk_row.slot_start - total_ignored, 0)
      where id = profile_plan.id;
      perform public.refresh_bulk_rotation_plan_state(plan_row.id);
    end if;
    return jsonb_build_object('chunkId', chunk_row.id, 'planId', plan_row.id,
      'status', 'horizon_waiting', 'processedItems', '0',
      'skippedOverdueItems', skipped_overdue::text,
      'nextSlotIndex', range_start::text, 'horizonHours', 48);
  end if;

  with desired as (
    select slot.slot_index,
      concat('bulk:', plan_row.id, ':', profile_plan.profile_id, ':', slot.slot_index) as idempotency_key,
      profile_plan.schedule_base_at + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval) as execute_at,
      media.media_asset_id
    from generate_series(range_start, range_end - 1) slot(slot_index)
    join public.bulk_publication_plan_media media on media.plan_id = plan_row.id
      and media.ordinal = mod(profile_plan.rotation_offset + slot.slot_index * profile_plan.rotation_step, plan_row.media_count)
  ), inserted as (
    insert into public.publication_items (
      organization_id, batch_id, profile_id, format, status, execute_at, caption,
      idempotency_key, reel_cover_media_asset_id
    )
    select plan_row.organization_id, plan_row.batch_id, profile_plan.profile_id,
      plan_row.format, 'waiting'::public.publication_item_status, desired.execute_at,
      plan_row.caption, desired.idempotency_key, plan_row.reel_cover_media_asset_id
    from desired
    where not exists (
      select 1 from public.publication_items existing
      where existing.organization_id = plan_row.organization_id
        and existing.idempotency_key = desired.idempotency_key
    )
    on conflict (organization_id, idempotency_key) do nothing
    returning id, idempotency_key
  ), inserted_media as (
    insert into public.publication_item_media (organization_id, publication_item_id, media_asset_id, position)
    select plan_row.organization_id, inserted.id, desired.media_asset_id, 0
    from inserted join desired using (idempotency_key)
    returning publication_item_id
  ), inserted_events as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status, status,
      actor_user_id, actor_label, metadata
    )
    select plan_row.organization_id, inserted.id, 'queued', null, 'waiting',
      plan_row.created_by, trim(p_worker_id),
      jsonb_build_object('execute_at', desired.execute_at, 'bulk_plan_id', plan_row.id,
        'bulk_chunk_id', chunk_row.id, 'bulk_slot_index', desired.slot_index::text,
        'bulk_algorithm_version', plan_row.algorithm_version,
        'reel_cover_media_asset_id', plan_row.reel_cover_media_asset_id)
    from inserted join desired using (idempotency_key)
    returning publication_item_id
  ) select count(*)::bigint into inserted_count from inserted;

  select count(*)::bigint into materialized_count
  from generate_series(range_start, range_end - 1) slot(slot_index)
  join public.publication_items item
    on item.organization_id = plan_row.organization_id
   and item.idempotency_key = concat('bulk:', plan_row.id, ':', profile_plan.profile_id, ':', slot.slot_index)
   and item.batch_id = plan_row.batch_id and item.profile_id = profile_plan.profile_id
   and item.format = plan_row.format
   and item.execute_at = profile_plan.schedule_base_at + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval)
   and item.caption is not distinct from plan_row.caption
   and item.reel_cover_media_asset_id is not distinct from plan_row.reel_cover_media_asset_id
  join public.bulk_publication_plan_media media
    on media.plan_id = plan_row.id
   and media.ordinal = mod(profile_plan.rotation_offset + slot.slot_index * profile_plan.rotation_step, plan_row.media_count)
  join public.publication_item_media link
    on link.publication_item_id = item.id and link.organization_id = item.organization_id
   and link.position = 0 and link.media_asset_id = media.media_asset_id;
  if materialized_count <> range_end - range_start then
    raise exception using errcode = '23505', message = 'Conflito de idempotência ao materializar chunk compacto.';
  end if;

  completed := range_end >= segment_end;
  update public.bulk_publication_generation_chunks
  set next_slot_index = range_end,
      generated_items = greatest(range_end - chunk_row.slot_start - total_ignored, 0),
      ignored_items = total_ignored,
      status = case when completed then 'completed' else 'queued' end,
      claimed_by = null, lease_until = null, consecutive_failure_count = 0,
      retry_exhausted_at = null, last_error_message = null,
      last_progress_at = timezone('utc', now()),
      completed_at = case when completed then timezone('utc', now()) else null end
  where id = chunk_row.id;
  update public.bulk_publication_plan_profiles
  set next_slot_index = range_end,
      generated_slot_count = greatest(range_end - chunk_row.slot_start - total_ignored, 0),
      ignored_slot_count = profile_plan.ignored_slot_count + skipped_overdue,
      status = case when completed then 'completed' else 'generating' end
  where id = profile_plan.id;
  if completed then
    update public.bulk_publication_profile_horizons
    set status = 'completed', released_at = coalesce(released_at, timezone('utc', now()))
    where plan_profile_id = profile_plan.id and status = 'active';
  end if;
  perform public.refresh_bulk_rotation_plan_state(plan_row.id);
  return jsonb_build_object('chunkId', chunk_row.id, 'planId', plan_row.id,
    'status', case when completed then 'completed' else 'queued' end,
    'processedItems', (range_end - range_start)::text,
    'insertedItems', inserted_count::text,
    'idempotentItems', (range_end - range_start - inserted_count)::text,
    'skippedOverdueItems', skipped_overdue::text,
    'nextSlotIndex', range_end::text, 'horizonHours', 48);
end;
$$;

revoke all on function public.claim_bulk_rotation_generation_chunks(text, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.process_bulk_rotation_generation_chunk(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_bulk_rotation_generation_chunks(text, integer, integer, integer)
  to service_role;
grant execute on function public.process_bulk_rotation_generation_chunk(uuid, text, integer)
  to service_role;

notify pgrst, 'reload schema';
