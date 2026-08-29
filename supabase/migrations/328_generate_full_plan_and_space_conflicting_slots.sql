-- Duas mudanças que precisam entrar juntas.
--
-- 1) FIM DO HORIZONTE MÓVEL DE 48 HORAS NA GERAÇÃO
--
-- A janela de 48h foi introduzida na migration 303 (28/08/2026), dentro de uma
-- migration cujo título é "Controles estruturais de pressão", com a justificativa
-- de reduzir WAL e evitar statement_timeout (plans/plano-estabilizacao-supabase-
-- carga-e-upgrade-2026-08-27.md:145,165). As migrations 084, 086, 196 e 207 não
-- tinham horizonte nenhum: o sistema gerou planos inteiros de 084 até 303.
--
-- O efeito colateral, medido em produção em 29/08 às 12:00 UTC:
--   - worker de geração OCIOSO (claimedChunks: 0 em todo ciclo) com 24.350 itens
--     ainda por gerar;
--   - TODO plano ativo com o último item exatamente em now()+48h, nenhum
--     materializado até a data que o usuário pediu.
--
-- E, pior, o horizonte faz cada plano de rotação horária ganhar 1 slot novo por
-- perfil por hora, indefinidamente. O gerador nunca fica ocioso e disputa banco
-- para sempre com as publicações que estão subindo naquele momento. Foi também o
-- amplificador da inanição corrigida pela 326: planos antigos reabastecem a fila
-- de prioridade na mesma velocidade em que ela drena.
--
-- Nenhuma invariante de correção depende do horizonte: idempotência é a
-- idempotency_key única; colisão de horário é o trigger
-- enforce_active_publication_slot_uniqueness; encadeamento entre lotes é
-- bulk_publication_profile_horizons.reserved_through (reserva o período inteiro
-- já na confirmação, mesmo com zero itens); não materializar vencido é a
-- invariante first_future_slot da 326. O custo POR TRANSAÇÃO também não muda:
-- p_step_size continua limitado a 100 slots por chamada.
--
-- 2) JANELA DE ESPAÇAMENTO ENTRE POSTS DO MESMO PERFIL
--
-- Hoje, quando dois lotes produzem o mesmo horário para o mesmo perfil e formato
-- (caso real: dois lotes de Story ancorados em 28/08 10:00), o trigger de vaga
-- única barra o insert, materialized_count fica menor que o esperado e a função
-- levanta 23505 — o chunk falha e o lote inteiro trava tentando para sempre.
--
-- Com o horizonte removido isso ficaria pior: em vez de perder 1 slot por
-- tentativa, uma fatia inteira de até 100 slots reverte, até esgotar
-- p_max_failures e o chunk virar retry_exhausted. Por isso as duas mudanças
-- entram na mesma migration.
--
-- A regra de produto, definida pelo usuário: Story agendado posta no horário
-- pedido, sem encadear e sem regra extra; a proteção contra agendar em cima é
-- uma janela de 10 minutos. Se um horário cair a menos de 10 minutos de um post
-- já marcado do mesmo formato no mesmo perfil, aquele horário é PULADO e
-- contabilizado como ignorado — o lote segue e termina normalmente.
--
-- Dentro de um mesmo lote a janela nunca dispara: Reels tem piso de 29 minutos
-- e Story é de 24 em 24 horas. Ela só age em cruzamento entre lotes distintos,
-- por isso o filtro exclui explicitamente o próprio batch_id do plano.

-- ---------------------------------------------------------------------------
-- 1. Claim sem o filtro de horizonte
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
  -- coexistem no mesmo nível), por isso o lock é aplicado depois em `candidates`.
  with ranked as (
    select chunk.id,
      chunk.plan_id as ranked_plan_id,
      plan.created_at as plan_created_at,
      -- rodízio: a rodada N atende a N-ésima posição de cada plano ativo, então
      -- nenhum plano monopoliza o worker (correção da 326, preservada).
      row_number() over (
        partition by chunk.plan_id
        order by profile_plan.ordinal, chunk.chunk_ordinal, chunk.id
      ) as plan_position,
      -- plano que ainda não gerou nada fura a fila: é o pior caso de experiência
      -- (o lote aparece vazio para o usuário).
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
      -- SEM filtro de horizonte: o plano é gerado até o fim, de uma vez.
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
-- 2. Geração do plano inteiro + janela de espaçamento
-- ---------------------------------------------------------------------------

-- A assinatura continua sendo (uuid, text, integer): a janela de espaçamento é
-- uma constante da função, não um parâmetro. Um parâmetro com default só seria
-- ajustável por migration de qualquer forma (o worker nunca o envia), e mudar a
-- assinatura quebraria supabase/tests/304, que hoje passa e afirma sobre
-- 'public.process_bulk_rotation_generation_chunk(uuid,text,integer)'.
create or replace function public.process_bulk_rotation_generation_chunk(
  p_chunk_id uuid,
  p_worker_id text,
  p_step_size integer default 50
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  -- Janela mínima entre posts do mesmo perfil e formato vindos de lotes
  -- diferentes. Regra de produto: 10 minutos.
  spacing_minutes constant integer := 10;
  chunk_row public.bulk_publication_generation_chunks%rowtype;
  profile_plan public.bulk_publication_plan_profiles%rowtype;
  plan_row public.bulk_publication_plans%rowtype;
  range_start bigint;
  range_end bigint;
  segment_end bigint;
  first_future_slot bigint;
  skipped_overdue bigint := 0;
  skipped_conflict bigint := 0;
  skipped_total bigint := 0;
  desired_count bigint := 0;
  total_ignored bigint;
  inserted_count bigint := 0;
  materialized_count bigint := 0;
  spacing interval;
  completed boolean;
begin
  if p_step_size not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Passo adaptativo deve estar entre 1 e 100 slots.';
  end if;
  spacing := make_interval(mins => spacing_minutes);

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

  -- INVARIANTE (326): nunca materializar um slot cujo execute_at já passou.
  -- execute_at(i) = schedule_base_at + (i + 1) * interval_minutes, logo o
  -- primeiro slot ainda não vencido é floor((now - base) / interval).
  first_future_slot := greatest(chunk_row.next_slot_index, floor(
    extract(epoch from (timezone('utc', now()) - profile_plan.schedule_base_at))
      / 60 / plan_row.interval_minutes
  )::bigint);
  skipped_overdue := greatest(least(first_future_slot, segment_end) - chunk_row.next_slot_index, 0);
  range_start := least(first_future_slot, segment_end);

  -- SEM horizonte: o fim do próprio plano é o único limite.
  range_end := least(range_start + p_step_size::bigint, segment_end);

  if range_start >= segment_end then
    skipped_total := skipped_overdue;
    total_ignored := chunk_row.ignored_items + skipped_total;
    update public.bulk_publication_generation_chunks
    set status = 'completed', claimed_by = null, lease_until = null,
        next_slot_index = range_start,
        ignored_items = total_ignored,
        generated_items = greatest(range_start - chunk_row.slot_start - total_ignored, 0),
        completed_at = coalesce(completed_at, timezone('utc', now())), last_progress_at = timezone('utc', now())
    where id = chunk_row.id;
    update public.bulk_publication_plan_profiles
    set status = 'completed', next_slot_index = total_slot_count,
        ignored_slot_count = profile_plan.ignored_slot_count + skipped_total,
        generated_slot_count = greatest(total_slot_count - (profile_plan.ignored_slot_count + skipped_total), 0)
    where id = profile_plan.id;
    update public.bulk_publication_profile_horizons
    set status = 'completed', released_at = coalesce(released_at, timezone('utc', now()))
    where plan_profile_id = profile_plan.id and status = 'active';
    perform public.refresh_bulk_rotation_plan_state(plan_row.id);
    return jsonb_build_object('chunkId', chunk_row.id, 'planId', plan_row.id,
      'status', 'completed', 'generatedItems', '0',
      'skippedOverdueItems', skipped_overdue::text,
      'skippedConflictItems', '0',
      'nextSlotIndex', range_start::text);
  end if;

  -- Quantos slots da fatia sobrevivem à janela de espaçamento. Um slot é
  -- descartado quando já existe post ativo do mesmo perfil e formato, de OUTRO
  -- lote, a menos de spacing_minutes do horário calculado.
  select count(*)::bigint into desired_count
  from generate_series(range_start, range_end - 1) slot(slot_index)
  join public.bulk_publication_plan_media media on media.plan_id = plan_row.id
    and media.ordinal = mod(profile_plan.rotation_offset + slot.slot_index * profile_plan.rotation_step, plan_row.media_count)
  where not exists (
    select 1 from public.publication_items conflicting
    where conflicting.organization_id = plan_row.organization_id
      and conflicting.profile_id = profile_plan.profile_id
      and conflicting.format = plan_row.format
      and conflicting.archived_at is null
      and conflicting.batch_id <> plan_row.batch_id
      and conflicting.status in ('waiting', 'ready', 'preparing', 'publishing')
      and conflicting.execute_at > profile_plan.schedule_base_at
        + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval) - spacing
      and conflicting.execute_at < profile_plan.schedule_base_at
        + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval) + spacing
  );

  skipped_conflict := greatest((range_end - range_start) - desired_count, 0);
  skipped_total := skipped_overdue + skipped_conflict;
  total_ignored := chunk_row.ignored_items + skipped_total;

  with desired as (
    select slot.slot_index,
      concat('bulk:', plan_row.id, ':', profile_plan.profile_id, ':', slot.slot_index) as idempotency_key,
      profile_plan.schedule_base_at + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval) as execute_at,
      media.media_asset_id
    from generate_series(range_start, range_end - 1) slot(slot_index)
    join public.bulk_publication_plan_media media on media.plan_id = plan_row.id
      and media.ordinal = mod(profile_plan.rotation_offset + slot.slot_index * profile_plan.rotation_step, plan_row.media_count)
    where not exists (
      select 1 from public.publication_items conflicting
      where conflicting.organization_id = plan_row.organization_id
        and conflicting.profile_id = profile_plan.profile_id
        and conflicting.format = plan_row.format
        and conflicting.archived_at is null
        and conflicting.batch_id <> plan_row.batch_id
        and conflicting.status in ('waiting', 'ready', 'preparing', 'publishing')
        and conflicting.execute_at > profile_plan.schedule_base_at
          + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval) - spacing
        and conflicting.execute_at < profile_plan.schedule_base_at
          + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval) + spacing
    )
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

  -- Compara com o que era DESEJADO após a janela de espaçamento, não com a
  -- fatia bruta: um slot pulado por conflito não é erro de idempotência.
  if materialized_count <> desired_count then
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
      ignored_slot_count = profile_plan.ignored_slot_count + skipped_total,
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
    'idempotentItems', (desired_count - inserted_count)::text,
    'skippedOverdueItems', skipped_overdue::text,
    'skippedConflictItems', skipped_conflict::text,
    'nextSlotIndex', range_end::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Piso de 29 minutos entre postagens de um mesmo lote (modo intervalo)
-- ---------------------------------------------------------------------------
--
-- Sem o horizonte, o único freio contra um plano absurdo passa a ser o intervalo.
-- A trava protege o banco e, principalmente, os perfis: postar mais rápido que
-- isso derruba conta.
--
-- Verificado em produção: nenhum plano jamais usou intervalo abaixo de 50
-- minutos, então a constraint valida sem reescrever linha nenhuma. O modo diário
-- passa 1440 internamente e não é afetado.
--
-- Implementado como CHECK na tabela (e não reescrevendo create_bulk_rotation_plan
-- e review_bulk_rotation_schedule, funções longas cuja cópia integral só
-- adicionaria risco de transcrição). A mensagem amigável fica na validação da
-- aplicação, em lib/publications/bulk-api.ts; esta constraint é o anteparo de
-- último recurso para qualquer chamada direta à RPC.

alter table public.bulk_publication_plans
  drop constraint if exists bulk_publication_plans_minimum_interval_check;
alter table public.bulk_publication_plans
  add constraint bulk_publication_plans_minimum_interval_check
  check (interval_minutes >= 29);

revoke all on function public.claim_bulk_rotation_generation_chunks(text, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.process_bulk_rotation_generation_chunk(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_bulk_rotation_generation_chunks(text, integer, integer, integer)
  to service_role;
grant execute on function public.process_bulk_rotation_generation_chunk(uuid, text, integer)
  to service_role;

notify pgrst, 'reload schema';
