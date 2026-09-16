-- Esquema de horários SEQUENCIAL na programação em massa (/postagem).
--
-- DECISÃO DO DONO (16/09/2026). Um terceiro esquema, ao lado de "intervalo
-- contínuo" e "uma vez por dia": o operador escolhe o intervalo entre as
-- postagens, a quantidade de postagens por perfil e, se quiser, o horário
-- inicial. Ele IGNORA COMPLETAMENTE a limitação de minutos entre postagens do
-- mesmo perfil e herda todo o resto (formato, origem de mídia, legenda, capa,
-- ordem da rotação, encadeamento quando não há início escolhido).
--
-- AS TRÊS TRAVAS DE MINUTOS QUE EXISTIAM, e o que acontece com cada uma só para
-- itens de plano sequencial:
--
--   1. Piso de 29 minutos no plano (`bulk_publication_plans_minimum_interval_check`,
--      328). Passa a valer só fora do sequencial; o sequencial aceita 1 minuto.
--   2. Pulo de 10 minutos na geração (`process_bulk_rotation_generation_chunk`,
--      328): slot a menos de 10 min de post do mesmo perfil e formato de OUTRO
--      lote era pulado. No sequencial só é pulado o slot que cairia EXATAMENTE no
--      mesmo instante de outro item ativo — o único caso em que o gatilho de vaga
--      única (177) derrubaria o bloco inteiro com 23505.
--   3. Intervalo mínimo por formato na reserva de despacho
--      (`reserve_publication_dispatch_capacity`, 372): 45 s, e 1.500 s para reel,
--      mais a trava de "outra publicação do mesmo perfil e formato em voo". Sem
--      liberar esta, uma sequência de reels a cada 5 min seria adiada 25 min por
--      post e VENCERIA pelo corte de 300 s. Para item de plano sequencial o bloco
--      inteiro é pulado.
--
--   E a reserva de horizonte (`enforce_active_publication_slot_uniqueness`, 177):
--   item de plano sequencial não é barrado pelo horizonte de outro plano, e o
--   horizonte de um plano sequencial não barra item de outro plano. Sem isso, um
--   início escolhido por cima de um lote em andamento faria a geração de UM dos
--   dois falhar até esgotar as tentativas.
--
-- O QUE CONTINUA VALENDO NO SEQUENCIAL: rotação v2 (offset e passo por perfil),
-- dispersão de 10 minutos a partir do início (gatilho da 331, que desloca o
-- ponto de partida de cada perfil sem mudar o intervalo), invariante de nunca
-- materializar slot vencido (326), teto de 7 dias (329), limite de 100
-- publicações por perfil em 24 h (reserva; é o limite da Meta) e vaga única por
-- instante exato (177).
--
-- COMO O HORÁRIO É GUARDADO. O gerador calcula `execute_at(i) = base + (i + 1) ×
-- intervalo`. Com início escolhido, `base = início − intervalo`, então o slot 0
-- cai exatamente no início (mais o deslocamento de dispersão do perfil). Sem
-- início, a base é a mesma do intervalo contínuo — `greatest(agora, último item
-- ativo do perfil no formato, fim do horizonte ativo)` — e o primeiro post sai um
-- intervalo depois dela.
--
-- CUSTO NO CAMINHO QUENTE. A reserva ganha uma leitura por índice único
-- (`bulk_publication_plans.batch_id`) por item reservado. O gatilho de
-- publication_items só consulta o plano do próprio lote quando já achou conflito
-- de horizonte (raro). A geração não muda de custo.

set lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 1. Tabela do plano
-- ---------------------------------------------------------------------------

alter table public.bulk_publication_plans
  drop constraint if exists bulk_publication_plans_schedule_mode_check;
alter table public.bulk_publication_plans
  add constraint bulk_publication_plans_schedule_mode_check
  check (schedule_mode in ('interval', 'daily_time', 'sequential'));

alter table public.bulk_publication_plans
  drop constraint if exists bulk_publication_plans_daily_time_check;
alter table public.bulk_publication_plans
  add constraint bulk_publication_plans_daily_time_check
  check ((schedule_mode in ('interval', 'sequential') and daily_time is null)
    or (schedule_mode = 'daily_time' and daily_time is not null));

alter table public.bulk_publication_plans
  add column if not exists sequential_start_at timestamptz;

comment on column public.bulk_publication_plans.sequential_start_at is
  'Horário inicial escolhido no esquema sequencial (antes da dispersão por perfil). Nulo quando o operador não escolheu: a sequência começa depois da fila atual do perfil, como no intervalo contínuo.';

alter table public.bulk_publication_plans
  drop constraint if exists bulk_publication_plans_sequential_start_check;
alter table public.bulk_publication_plans
  add constraint bulk_publication_plans_sequential_start_check
  check (sequential_start_at is null or schedule_mode = 'sequential');

alter table public.bulk_publication_plans
  drop constraint if exists bulk_publication_plans_minimum_interval_check;
alter table public.bulk_publication_plans
  add constraint bulk_publication_plans_minimum_interval_check
  check (interval_minutes >= 29 or schedule_mode = 'sequential');

-- ---------------------------------------------------------------------------
-- 2. Regras do sequencial (uma função, usada pela revisão e pela criação)
-- ---------------------------------------------------------------------------

create or replace function public.assert_bulk_sequential_schedule(
  p_interval_minutes integer,
  p_post_count bigint,
  p_start_at timestamptz,
  p_now timestamptz
)
returns void
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_interval_minutes is null or p_interval_minutes < 1 then
    raise exception using errcode = '22023', message = 'O intervalo precisa ser de pelo menos 1 minuto.';
  end if;
  if p_post_count is null or p_post_count < 1 then
    raise exception using errcode = '22023', message = 'Quantidade de postagens inválida.';
  end if;
  if p_post_count::numeric * p_interval_minutes::numeric > 7 * 1440 then
    raise exception using errcode = '22023', message = 'A sequência passa de 7 dias. Reduza o intervalo ou a quantidade de postagens.';
  end if;
  -- Mesma conta de lib/publications/bulk-rotation.ts#bulkSequentialPostsInAnyDay.
  if least(p_post_count, (1440 / p_interval_minutes)::bigint + 1) > 100 then
    raise exception using errcode = '22023', message = 'Com esse intervalo cada perfil passaria de 100 publicações em 24 horas, o limite da Meta. Aumente o intervalo ou reduza a quantidade.';
  end if;
  if p_start_at is not null and p_start_at <= p_now then
    raise exception using errcode = '22023', message = 'O horário inicial já passou. Escolha um horário futuro e revise o plano.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Revisão (prévia) do plano sequencial
-- ---------------------------------------------------------------------------

create or replace function public.review_bulk_sequential_rotation_schedule(
  p_organization_id uuid,
  p_profile_ids uuid[],
  p_interval_minutes integer,
  p_post_count bigint,
  p_start_at timestamptz,
  p_format public.publication_format,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  resolved_now timestamptz := coalesce(p_now, timezone('utc', now()));
  requested_profile_count bigint;
  online_profile_count bigint;
  resolved_expected numeric;
  spread_seconds numeric;
  sample_first_execute_at timestamptz;
  sample_last_execute_at timestamptz;
begin
  if auth.uid() is null or not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_profile_ids is null or cardinality(p_profile_ids) = 0 or array_position(p_profile_ids, null) is not null then
    raise exception using errcode = '22023', message = 'Selecione pelo menos um perfil válido.';
  end if;
  perform public.assert_bulk_sequential_schedule(p_interval_minutes, p_post_count, p_start_at, resolved_now);
  if p_format not in ('image', 'reel', 'story') then
    raise exception using errcode = '22023', message = 'Formato inválido para programação em massa.';
  end if;

  select count(*)::bigint into requested_profile_count from (select distinct value from unnest(p_profile_ids) as input(value)) requested;
  select count(*)::bigint into online_profile_count from (select distinct value from unnest(p_profile_ids) as input(value)) requested join public.instagram_profiles profile_row on profile_row.id = requested.value where profile_row.organization_id = p_organization_id and profile_row.deleted_at is null and profile_row.status = 'online';
  if requested_profile_count <> online_profile_count then
    raise exception using errcode = 'P0001', message = 'O conjunto de perfis mudou; atualize a seleção antes de revisar.';
  end if;
  resolved_expected := requested_profile_count::numeric * p_post_count::numeric;
  if resolved_expected > 9223372036854775807::numeric then raise exception using errcode = '22003', message = 'Projeção total não cabe em bigint.'; end if;

  -- Deslocamento do último perfil na dispersão padrão de 600 s (331).
  spread_seconds := case when requested_profile_count <= 1 then 0
    else (requested_profile_count - 1)::numeric * 600 / requested_profile_count::numeric end;

  if p_start_at is not null then
    sample_first_execute_at := p_start_at;
    sample_last_execute_at := p_start_at
      + ((p_post_count - 1) * p_interval_minutes) * interval '1 minute'
      + spread_seconds * interval '1 second';
  else
    with requested as (
      select distinct value as profile_id from unnest(p_profile_ids) as input(value)
    ), profile_bases as (
      select requested.profile_id, greatest(
        resolved_now,
        coalesce((select max(item.execute_at) from public.publication_items item where item.organization_id = p_organization_id and item.profile_id = requested.profile_id and item.format = p_format and item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.execute_at is not null), resolved_now),
        coalesce((select max(horizon.reserved_through) from public.bulk_publication_profile_horizons horizon join public.bulk_publication_plans horizon_plan on horizon_plan.id = horizon.plan_id where horizon.organization_id = p_organization_id and horizon.profile_id = requested.profile_id and horizon.status = 'active' and horizon_plan.format = p_format), resolved_now)
      ) as schedule_base from requested
    ) select min(schedule_base + p_interval_minutes * interval '1 minute'),
             max(schedule_base + (p_post_count * p_interval_minutes) * interval '1 minute') + spread_seconds * interval '1 second'
      into sample_first_execute_at, sample_last_execute_at from profile_bases;
  end if;

  return jsonb_build_object(
    'profileCount', online_profile_count::text,
    'slotsPerProfile', p_post_count::text,
    'expectedPublications', resolved_expected::bigint::text,
    'firstExecuteAt', sample_first_execute_at,
    'lastExecuteAt', sample_last_execute_at,
    'startAt', p_start_at,
    'reviewedAt', resolved_now
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Criação atômica do plano sequencial
-- ---------------------------------------------------------------------------
--
-- Mesma estrutura de `create_bulk_rotation_plan` (177) com o que os invólucros
-- v2 (202) e de capa (207) acrescentam, numa função só: aqui o plano já nasce
-- `schedule_mode = 'sequential'`, e por isso não dá para reaproveitar a função
-- antiga — ela insere com o modo padrão `interval`, que a constraint de 29
-- minutos recusaria antes de qualquer update.

create or replace function public.create_bulk_sequential_rotation_plan_v2(
  p_organization_id uuid,
  p_request_key text,
  p_name text,
  p_profile_ids uuid[],
  p_origin_type text,
  p_origin_group_id uuid,
  p_format public.publication_format,
  p_interval_minutes integer,
  p_post_count bigint,
  p_start_at timestamptz,
  p_caption text,
  p_order_mode text,
  p_rotation_seed text,
  p_reel_cover_media_asset_id uuid,
  p_reel_cover_origin_type text,
  p_reel_cover_origin_group_id uuid,
  p_algorithm_version smallint default 2,
  p_chunk_size integer default 500,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_now timestamptz := coalesce(p_now, timezone('utc', now()));
  resolved_user_id uuid := auth.uid();
  clean_request_key text := trim(coalesce(p_request_key, ''));
  clean_name text := trim(coalesce(p_name, ''));
  clean_seed text := trim(coalesce(p_rotation_seed, ''));
  requested_profile_count bigint;
  online_profile_count bigint;
  resolved_media_count bigint;
  resolved_duration_days bigint;
  resolved_expected numeric;
  resolved_request_hash text;
  existing_plan public.bulk_publication_plans%rowtype;
  created_plan public.bulk_publication_plans%rowtype;
  created_batch public.publication_batches%rowtype;
  profile_record record;
  profile_plan public.bulk_publication_plan_profiles%rowtype;
  active_last timestamptz;
  reserved_last timestamptz;
  schedule_base timestamptz;
  first_execute timestamptz;
  last_execute timestamptz;
begin
  if resolved_user_id is null or not public.has_organization_role(
    p_organization_id, array['admin', 'operator']::public.organization_role[]
  ) then raise exception using errcode = '42501', message = 'Ação não permitida.'; end if;
  if char_length(clean_request_key) not between 16 and 240 then raise exception using errcode = '22023', message = 'Chave de idempotência inválida.'; end if;
  if char_length(clean_name) not between 1 and 160 then raise exception using errcode = '22023', message = 'Nome do lote inválido.'; end if;
  if p_profile_ids is null or cardinality(p_profile_ids) = 0 or array_position(p_profile_ids, null) is not null then raise exception using errcode = '22023', message = 'Selecione pelo menos um perfil válido.'; end if;
  if p_origin_type not in ('group', 'ungrouped') or (p_origin_type = 'group' and p_origin_group_id is null) or (p_origin_type = 'ungrouped' and p_origin_group_id is not null) then raise exception using errcode = '22023', message = 'Origem de mídia inválida.'; end if;
  if p_format not in ('image', 'reel', 'story') then raise exception using errcode = '22023', message = 'Formato inválido para programação em massa.'; end if;
  perform public.assert_bulk_sequential_schedule(p_interval_minutes, p_post_count, p_start_at, resolved_now);
  if p_caption is not null and char_length(p_caption) > 2200 then raise exception using errcode = '22023', message = 'Legenda excede 2.200 caracteres.'; end if;
  if p_order_mode not in ('same_order', 'diversified') or clean_seed = '' or p_algorithm_version <> 2 then raise exception using errcode = '22023', message = 'Configuração de rotação inválida.'; end if;
  if p_chunk_size not between 1 and 1000 then raise exception using errcode = '22023', message = 'Tamanho de chunk deve estar entre 1 e 1.000.'; end if;

  -- Capa: mesmas regras do invólucro da 207.
  if p_reel_cover_media_asset_id is not null and p_format <> 'reel' then
    raise exception using errcode = '22023', message = 'Capa personalizada só pode ser usada em Reel.';
  end if;
  if p_reel_cover_media_asset_id is not null and not public.bulk_reel_cover_is_eligible(
    p_organization_id, p_reel_cover_media_asset_id, p_reel_cover_origin_type, p_reel_cover_origin_group_id
  ) then
    raise exception using errcode = '22023', message = 'A imagem de capa não está disponível na origem selecionada.';
  end if;
  if p_reel_cover_media_asset_id is null
    and (p_reel_cover_origin_type is not null or p_reel_cover_origin_group_id is not null) then
    raise exception using errcode = '22023', message = 'Configuração de capa inconsistente.';
  end if;

  resolved_request_hash := encode(extensions.digest(concat_ws('|', 'sequential', clean_name, p_origin_type, coalesce(p_origin_group_id::text, ''), p_format::text, p_interval_minutes::text, p_post_count::text, coalesce(to_char(p_start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''), coalesce(p_caption, ''), p_order_mode, clean_seed, p_algorithm_version::text, p_chunk_size::text, coalesce(p_reel_cover_media_asset_id::text, ''), (select string_agg(value::text, ',' order by first_ordinal) from (select value, min(ordinality) as first_ordinal from unnest(p_profile_ids) with ordinality input(value, ordinality) group by value) ordered_profiles)), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || clean_request_key, 0));
  select * into existing_plan from public.bulk_publication_plans where organization_id = p_organization_id and request_key = clean_request_key;
  if existing_plan.id is not null then
    if existing_plan.request_hash <> resolved_request_hash then raise exception using errcode = '23505', message = 'Chave de idempotência já usada com outro conteúdo.'; end if;
    return jsonb_build_object('created', false, 'planId', existing_plan.id, 'batchId', existing_plan.batch_id, 'profileCount', existing_plan.profile_count::text, 'mediaCount', existing_plan.media_count::text, 'slotsPerProfile', existing_plan.slots_per_profile::text, 'expectedPublications', existing_plan.expected_publications::text, 'algorithmVersion', existing_plan.algorithm_version, 'scheduleMode', existing_plan.schedule_mode, 'reelCoverMediaAssetId', existing_plan.reel_cover_media_asset_id);
  end if;

  resolved_duration_days := greatest(ceil(p_post_count::numeric * p_interval_minutes::numeric / 1440)::bigint, 1);
  select count(*)::bigint into requested_profile_count from (select distinct value from unnest(p_profile_ids) as input(value)) requested;
  select count(*)::bigint into online_profile_count from (select distinct value from unnest(p_profile_ids) as input(value)) requested join public.instagram_profiles profile_row on profile_row.id = requested.value where profile_row.organization_id = p_organization_id and profile_row.deleted_at is null and profile_row.status = 'online';
  if requested_profile_count <> online_profile_count then raise exception using errcode = 'P0001', message = 'O conjunto de perfis mudou; revise novamente antes de confirmar.'; end if;
  if p_origin_type = 'group' and not exists (select 1 from public.profile_groups group_row where group_row.id = p_origin_group_id and group_row.organization_id = p_organization_id and group_row.deleted_at is null) then raise exception using errcode = '23514', message = 'Grupo de origem inválido.'; end if;

  select count(*)::bigint into resolved_media_count from public.media_assets asset where asset.organization_id = p_organization_id and asset.deleted_at is null and asset.deletion_requested_at is null and asset.status = 'ready' and public.media_asset_has_storage_object(asset.storage_path) and (p_format = 'story' or (p_format = 'image' and asset.kind = 'image') or (p_format = 'reel' and asset.kind = 'video')) and ((p_origin_type = 'group' and exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.group_id = p_origin_group_id and assignment.media_asset_id = asset.id)) or (p_origin_type = 'ungrouped' and not exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id)));
  if resolved_media_count = 0 then raise exception using errcode = '22023', message = 'A origem não possui mídias elegíveis para o formato.'; end if;

  resolved_expected := requested_profile_count::numeric * p_post_count::numeric;
  if resolved_expected > 9223372036854775807::numeric then raise exception using errcode = '22003', message = 'Projeção total não cabe em bigint.'; end if;
  insert into public.publication_batches (organization_id, created_by, created_by_email, name, status, scheduled_for, review_confirmed_at) values (p_organization_id, resolved_user_id, nullif(auth.jwt() ->> 'email', ''), clean_name, 'queued', resolved_now, resolved_now) returning * into created_batch;
  insert into public.bulk_publication_plans (organization_id, created_by, created_by_email, batch_id, request_key, request_hash, name, format, origin_type, origin_group_id, caption, interval_minutes, duration_days, slots_per_profile, order_mode, algorithm_version, rotation_seed, profile_count, media_count, expected_publications, chunk_size, expected_chunks, schedule_mode, sequential_start_at, reel_cover_media_asset_id) values (p_organization_id, resolved_user_id, nullif(auth.jwt() ->> 'email', ''), created_batch.id, clean_request_key, resolved_request_hash, clean_name, p_format, p_origin_type, p_origin_group_id, nullif(p_caption, ''), p_interval_minutes, resolved_duration_days, p_post_count, p_order_mode, 2, clean_seed, requested_profile_count, resolved_media_count, resolved_expected::bigint, p_chunk_size, requested_profile_count, 'sequential', p_start_at, p_reel_cover_media_asset_id) returning * into created_plan;
  insert into public.bulk_publication_plan_media (plan_id, organization_id, media_asset_id, ordinal, kind, storage_path) select created_plan.id, p_organization_id, eligible.id, (row_number() over (order by eligible.created_at, eligible.id) - 1)::bigint, eligible.kind, eligible.storage_path from public.media_assets eligible where eligible.organization_id = p_organization_id and eligible.deleted_at is null and eligible.deletion_requested_at is null and eligible.status = 'ready' and public.media_asset_has_storage_object(eligible.storage_path) and (p_format = 'story' or (p_format = 'image' and eligible.kind = 'image') or (p_format = 'reel' and eligible.kind = 'video')) and ((p_origin_type = 'group' and exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.group_id = p_origin_group_id and assignment.media_asset_id = eligible.id)) or (p_origin_type = 'ungrouped' and not exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.media_asset_id = eligible.id)));

  for profile_record in select requested.value as profile_id, (row_number() over (order by requested.first_ordinal) - 1)::bigint as ordinal from (select value, min(ordinality) as first_ordinal from unnest(p_profile_ids) with ordinality input(value, ordinality) group by value) requested order by requested.first_ordinal loop
    perform pg_advisory_xact_lock(hashtextextended(profile_record.profile_id::text, 0));
    if p_start_at is not null then
      -- Slot 0 = base + 1 intervalo = início escolhido. A dispersão (gatilho da
      -- 331) soma o deslocamento do perfil nos três campos logo no insert.
      schedule_base := p_start_at - p_interval_minutes * interval '1 minute';
    else
      select max(item.execute_at) into active_last from public.publication_items item where item.organization_id = p_organization_id and item.profile_id = profile_record.profile_id and item.format = p_format and item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.execute_at is not null;
      select max(horizon.reserved_through) into reserved_last from public.bulk_publication_profile_horizons horizon join public.bulk_publication_plans horizon_plan on horizon_plan.id = horizon.plan_id where horizon.organization_id = p_organization_id and horizon.profile_id = profile_record.profile_id and horizon.status = 'active' and horizon_plan.format = p_format;
      schedule_base := greatest(resolved_now, coalesce(active_last, resolved_now), coalesce(reserved_last, resolved_now));
    end if;
    first_execute := schedule_base + p_interval_minutes * interval '1 minute';
    last_execute := schedule_base + (p_post_count * p_interval_minutes) * interval '1 minute';
    insert into public.bulk_publication_plan_profiles (plan_id, organization_id, profile_id, ordinal, schedule_base_at, first_execute_at, last_execute_at, total_slot_count, rotation_offset, rotation_step) values (created_plan.id, p_organization_id, profile_record.profile_id, profile_record.ordinal, schedule_base, first_execute, last_execute, p_post_count, case when p_order_mode = 'same_order' then 0 else public.bulk_rotation_v2_profile_offset(clean_seed, profile_record.ordinal, resolved_media_count) end, case when p_order_mode = 'same_order' then 1 else public.bulk_rotation_v2_profile_step(clean_seed, profile_record.ordinal, resolved_media_count) end) returning * into profile_plan;
    insert into public.bulk_publication_profile_horizons (plan_id, plan_profile_id, organization_id, profile_id, reserved_from, first_execute_at, reserved_through, slot_count) values (created_plan.id, profile_plan.id, p_organization_id, profile_record.profile_id, schedule_base, first_execute, last_execute, p_post_count);
    insert into public.bulk_publication_generation_chunks (plan_id, plan_profile_id, organization_id, profile_id, chunk_ordinal, slot_start, slot_count, next_slot_index) values (created_plan.id, profile_plan.id, p_organization_id, profile_record.profile_id, profile_record.ordinal, 0, p_post_count, 0);
  end loop;
  return jsonb_build_object('created', true, 'planId', created_plan.id, 'batchId', created_plan.batch_id, 'profileCount', created_plan.profile_count::text, 'mediaCount', created_plan.media_count::text, 'slotsPerProfile', created_plan.slots_per_profile::text, 'expectedPublications', created_plan.expected_publications::text, 'firstExecuteAt', (select min(first_execute_at) from public.bulk_publication_plan_profiles where plan_id = created_plan.id), 'lastExecuteAt', (select max(last_execute_at) from public.bulk_publication_plan_profiles where plan_id = created_plan.id), 'algorithmVersion', 2, 'scheduleMode', 'sequential', 'reelCoverMediaAssetId', p_reel_cover_media_asset_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Geração: sem a janela de 10 minutos para o sequencial
-- ---------------------------------------------------------------------------
-- Cópia integral da 328 (conferida igual à produção em 16/09/2026) com duas
-- mudanças: `spacing` passa a depender do modo do plano, e o predicado de
-- conflito ganha o ramo de instante exato.

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

  -- Sequencial (432): sem a janela de 10 minutos entre lotes. Só é pulado o slot
  -- que cairia no MESMO instante de outro item ativo do perfil e formato — o caso
  -- em que o gatilho de vaga única (177) derrubaria o bloco inteiro com 23505.
  spacing := case when plan_row.schedule_mode = 'sequential'
    then interval '0' else make_interval(mins => spacing_minutes) end;

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
      and ((spacing > interval '0'
          and conflicting.execute_at > profile_plan.schedule_base_at + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval) - spacing
          and conflicting.execute_at < profile_plan.schedule_base_at + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval) + spacing)
        or (spacing = interval '0'
          and conflicting.execute_at = profile_plan.schedule_base_at + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval)))
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
        and ((spacing > interval '0'
            and conflicting.execute_at > profile_plan.schedule_base_at + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval) - spacing
            and conflicting.execute_at < profile_plan.schedule_base_at + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval) + spacing)
          or (spacing = interval '0'
            and conflicting.execute_at = profile_plan.schedule_base_at + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval)))
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
-- 6. Vaga única e horizonte: sequencial não barra nem é barrado
-- ---------------------------------------------------------------------------
-- Cópia integral da 177 (conferida igual à produção) com as duas exceções.

create or replace function public.enforce_active_publication_slot_uniqueness()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.execute_at is not null
    and new.status in ('waiting', 'ready', 'preparing', 'publishing')
    and exists (
      select 1
      from public.publication_items occupied
      where occupied.organization_id = new.organization_id
        and occupied.profile_id = new.profile_id
        and occupied.format = new.format
        and occupied.execute_at = new.execute_at
        and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
        and occupied.id <> new.id
    ) then
    raise exception using errcode = '23505', message = 'active_publication_slot_conflict';
  end if;

  if tg_op = 'INSERT'
    and new.execute_at is not null
    and new.status in ('waiting', 'ready', 'preparing', 'publishing')
    and exists (
      select 1
      from public.bulk_publication_profile_horizons horizon
      join public.bulk_publication_plans plan on plan.id = horizon.plan_id
      where horizon.organization_id = new.organization_id
        and horizon.profile_id = new.profile_id
        and plan.format = new.format
        and horizon.status = 'active'
        -- Horizonte de plano sequencial não barra item de outro plano (432).
        and plan.schedule_mode <> 'sequential'
        and new.execute_at >= horizon.first_execute_at
        and new.execute_at <= horizon.reserved_through
        and new.batch_id <> plan.batch_id
        and new.created_at >= horizon.created_at
    )
    -- Item de plano sequencial não é barrado pelo horizonte de outro plano (432).
    -- Consultado só depois de achar conflito, então não pesa no insert comum.
    and not exists (
      select 1
      from public.bulk_publication_plans own_plan
      where own_plan.batch_id = new.batch_id
        and own_plan.schedule_mode = 'sequential'
    ) then
    raise exception using errcode = '23505', message = 'bulk_publication_horizon_conflict';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Reserva de despacho: sequencial sem intervalo mínimo por perfil
-- ---------------------------------------------------------------------------
-- Cópia integral da 372 (conferida igual à produção) com o bloco de exceção.

create or replace function public.reserve_publication_dispatch_capacity(
  p_item_id uuid,
  p_worker_id text,
  p_reservation_seconds integer default null
)
returns table (
  allowed boolean,
  reason text,
  provider text,
  current_count integer,
  limit_value integer,
  next_attempt_at timestamptz,
  settings jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  profile_provider text;
  setting_row public.publication_rate_limit_settings%rowtype;
  effective_reservation_seconds integer;
  effective_min_seconds integer;
  now_at timestamptz := timezone('utc', now());
  check_reason text;
  check_message text;
  check_count integer := 0;
  check_limit integer := 0;
  retry_at timestamptz;
  last_profile_publication_at timestamptz;
  sibling_reservation_expires_at timestamptz;
  shard_count integer;
  lock_bucket integer;
  profile_meta_app_id uuid;
  app_minute_limit integer;
  app_check_count integer;
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if p_reservation_seconds is not null and p_reservation_seconds not between 60 and 900 then
    raise exception using errcode = '22023', message = 'Duração de reserva inválida.';
  end if;

  select item_source.* into item_row
  from public.publication_items as item_source
  where item_source.id = p_item_id
    and item_source.claimed_by = trim(p_worker_id)
    and item_source.lease_until > now_at
    and item_source.status in ('preparing', 'publishing')
  for update;

  if item_row.id is null then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker.';
  end if;

  select profile.provider::text, profile.meta_app_id
  into profile_provider, profile_meta_app_id
  from public.instagram_profiles as profile
  where profile.id = item_row.profile_id
    and profile.organization_id = item_row.organization_id
    and profile.deleted_at is null;

  if profile_provider is null then
    raise exception using errcode = 'P0002', message = 'Perfil da publicação não encontrado.';
  end if;

  select setting_source.* into setting_row
  from public.publication_rate_limit_settings as setting_source
  where setting_source.enabled = true
    and (setting_source.organization_id = item_row.organization_id or setting_source.organization_id is null)
    and (setting_source.provider = profile_provider or setting_source.provider is null)
  order by (setting_source.organization_id is not null) desc,
           (setting_source.provider is not null) desc,
           setting_source.updated_at desc,
           setting_source.id desc
  limit 1;

  if setting_row.id is null then
    insert into public.publication_rate_limit_settings (organization_id, provider)
    values (null, null)
    on conflict do nothing;

    select setting_source.* into setting_row
    from public.publication_rate_limit_settings as setting_source
    where setting_source.organization_id is null
      and setting_source.provider is null
    limit 1;
  end if;

  effective_reservation_seconds := coalesce(p_reservation_seconds, setting_row.reservation_seconds, 300);

  -- Valor do formato deste item, caindo para o escalar quando não houver entrada.
  effective_min_seconds := coalesce(
    nullif(setting_row.min_seconds_between_profile_publications_by_format ->> item_row.format::text, '')::integer,
    setting_row.min_seconds_between_profile_publications,
    0
  );

  -- ESQUEMA SEQUENCIAL (432, decisão do dono em 16/09/2026): item de plano
  -- sequencial ignora toda limitação de minutos entre postagens do mesmo perfil —
  -- o intervalo mínimo por formato (45 s; reel 1.500 s) e a trava de outra
  -- publicação do mesmo perfil e formato em voo, que moram no mesmo bloco abaixo.
  -- Sem isto, reels a cada 5 min seriam adiados 25 min cada e venceriam pelo
  -- corte de 300 s. O limite de 24 h e as cotas por minuto continuam valendo.
  -- Custo: uma leitura pelo índice único de bulk_publication_plans.batch_id.
  if effective_min_seconds > 0 and exists (
    select 1
    from public.bulk_publication_plans as sequential_plan
    where sequential_plan.batch_id = item_row.batch_id
      and sequential_plan.schedule_mode = 'sequential'
  ) then
    effective_min_seconds := 0;
  end if;

  -- O balde vem do PERFIL, entao dois despachos do mesmo perfil caem sempre no
  -- mesmo balde e continuam serializados entre si. O que deixa de disputar sao
  -- perfis diferentes da mesma organizacao -- que era toda a contencao.
  --
  -- coalesce para 1, e nao para o default da coluna: valor ausente degrada para
  -- o comportamento conhecido (lock unico), nunca para o novo.
  shard_count := greatest(coalesce(setting_row.dispatch_lock_shards, 1), 1);
  lock_bucket := public.publication_dispatch_lock_bucket(item_row.profile_id, shard_count);

  -- Quando existe cota POR APP, o lock precisa ser POR APP. Contar por app
  -- dentro de um lock que fatia por perfil deixaria dois baldes do mesmo app
  -- lendo a mesma contagem e passando juntos -- a corrida que a 360 aceitou de
  -- proposito para a cota da organizacao (excesso limitado, protecao nossa) mas
  -- que aqui estouraria limite de PROVEDOR, que nao e nosso para gastar.
  --
  -- Perfil sem app (os legados, com meta_app_id nulo) continua no balde por
  -- perfil: eles nao consomem cota de app nenhum, entao nao ha o que serializar
  -- alem do que a 360 ja serializa.
  if profile_provider = 'meta_official' and profile_meta_app_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      item_row.organization_id::text || ':meta_app:' || profile_meta_app_id::text, 4));
  else
    perform pg_advisory_xact_lock(hashtextextended(
      item_row.organization_id::text || ':' || profile_provider || ':' || lock_bucket::text, 4));
  end if;
  perform pg_advisory_xact_lock(hashtextextended(item_row.profile_id::text, 5));

  -- Reentrância: o próprio item já reservou capacidade nesta janela e portanto já
  -- passou pelas checagens. Não é um bypass — é o mesmo item repetindo a tentativa.
  if exists (
    select 1
    from public.publication_dispatch_rate_reservations as reservation
    where reservation.publication_item_id = item_row.id
      and reservation.expires_at > now_at
  ) then
    return query select true, null::text, profile_provider, 0, 0, null::timestamptz, to_jsonb(setting_row);
    return;
  end if;

  -- O momento em que este perfil publicou algo deste formato pela última vez.
  -- Precisa considerar o envio já aceito e ainda não confirmado: no Zernio o post
  -- já está no ar, mas published_at só aparece 2+ minutos depois. Comparar só com
  -- published_at deixava passar tudo que acontecesse nessa janela cega.
  select greatest(
    coalesce((
      select max(published_item.published_at)
      from public.publication_items as published_item
      where published_item.profile_id = item_row.profile_id
        and published_item.format = item_row.format
        and published_item.status = 'published'
        and published_item.published_at is not null
    ), '-infinity'::timestamptz),
    coalesce((
      select max(accepted_item.provider_creation_started_at)
      from public.publication_items as accepted_item
      where accepted_item.profile_id = item_row.profile_id
        and accepted_item.format = item_row.format
        and accepted_item.id <> item_row.id
        and accepted_item.creation_id is not null
        and accepted_item.status in ('preparing', 'publishing')
        and accepted_item.provider_creation_started_at is not null
    ), '-infinity'::timestamptz)
  ) into last_profile_publication_at;

  -- Reserva viva de OUTRO item do mesmo perfil e formato: há uma publicação em
  -- voo agora. Sem isto, 32 despachos concorrentes leem o mesmo estado e passam
  -- todos juntos — o advisory lock serializa as transações, mas não impede a
  -- decisão duplicada quando ambas leem um passado que ainda não mudou.
  select max(reservation.expires_at) into sibling_reservation_expires_at
  from public.publication_dispatch_rate_reservations as reservation
  join public.publication_items as reserved_item
    on reserved_item.id = reservation.publication_item_id
  where reservation.profile_id = item_row.profile_id
    and reservation.publication_item_id <> item_row.id
    and reservation.expires_at > now_at
    and reserved_item.format = item_row.format;

  if effective_min_seconds > 0 then
    if last_profile_publication_at > '-infinity'::timestamptz
      and last_profile_publication_at + make_interval(secs => effective_min_seconds) > now_at
    then
      check_reason := 'profile_min_interval';
      check_message := 'Publicação adiada para respeitar intervalo mínimo entre publicações do mesmo perfil.';
      check_count := 1;
      check_limit := effective_min_seconds;
      retry_at := last_profile_publication_at + make_interval(secs => effective_min_seconds);
    elsif sibling_reservation_expires_at is not null then
      check_reason := 'profile_min_interval';
      check_message := 'Publicação adiada: outra publicação do mesmo perfil e formato está em andamento.';
      check_count := 1;
      check_limit := effective_min_seconds;
      retry_at := greatest(sibling_reservation_expires_at, now_at + make_interval(secs => effective_min_seconds));
    end if;
  end if;

  if check_reason is null then
    select count(*)::integer into check_count
    from public.publication_items as published_item
    where published_item.profile_id = item_row.profile_id
      and published_item.status = 'published'
      and published_item.published_at >= now_at - interval '24 hours';

    check_count := check_count + (
      select count(*)::integer
      from public.publication_dispatch_rate_reservations as reservation
      where reservation.profile_id = item_row.profile_id
        and reservation.expires_at > now_at
    );
    check_limit := setting_row.max_profile_publications_per_24h;

    if check_count >= check_limit then
      check_reason := 'profile_24h_limit';
      check_message := 'Publicação adiada pelo limite de publicações do perfil em 24 horas.';
      select min(expiry) into retry_at
      from (
        select published_item.published_at + interval '24 hours' as expiry
        from public.publication_items as published_item
        where published_item.profile_id = item_row.profile_id
          and published_item.status = 'published'
          and published_item.published_at >= now_at - interval '24 hours'
        union all
        select reservation.expires_at as expiry
        from public.publication_dispatch_rate_reservations as reservation
        where reservation.profile_id = item_row.profile_id
          and reservation.expires_at > now_at
      ) as expirations;
    end if;
  end if;

  if check_reason is null then
    select count(*)::integer into check_count
    from public.publication_items as published_item
    join public.instagram_profiles as profile on profile.id = published_item.profile_id
    where published_item.organization_id = item_row.organization_id
      and profile.provider::text = profile_provider
      and published_item.status = 'published'
      and published_item.published_at >= now_at - interval '1 minute';

    check_count := check_count + (
      select count(*)::integer
      from public.publication_dispatch_rate_reservations as reservation
      where reservation.organization_id = item_row.organization_id
        and reservation.provider = profile_provider
        and reservation.expires_at > now_at
    );
    check_limit := setting_row.max_provider_publications_per_minute;

    if check_count >= check_limit then
      check_reason := 'provider_minute_limit';
      check_message := 'Publicação adiada pelo limite por minuto do provedor nesta organização.';
      select min(expiry) into retry_at
      from (
        select published_item.published_at + interval '1 minute' as expiry
        from public.publication_items as published_item
        join public.instagram_profiles as profile on profile.id = published_item.profile_id
        where published_item.organization_id = item_row.organization_id
          and profile.provider::text = profile_provider
          and published_item.status = 'published'
          and published_item.published_at >= now_at - interval '1 minute'
        union all
        select reservation.expires_at as expiry
        from public.publication_dispatch_rate_reservations as reservation
        where reservation.organization_id = item_row.organization_id
          and reservation.provider = profile_provider
          and reservation.expires_at > now_at
      ) as expirations;
    end if;
  end if;


  -- COTA POR APP DA META. Existe porque a topologia inverteu: com a Zernio eram
  -- milhares de chaves e nenhuma chegava perto do proprio limite, entao uma cota
  -- agregada por organizacao era aproximacao boa. Com um app para ~100 perfis, o
  -- APP passa a ser o recurso escasso -- e era exatamente o que o sistema nao
  -- sabia contar.
  --
  -- E ADITIVA: a checagem da organizacao acima continua valendo e segue sendo a
  -- que protege o nosso banco. Esta protege o limite do PROVEDOR, que e outro
  -- eixo. Um item precisa passar nas duas.
  --
  -- SO VALE QUANDO CONFIGURADA. `meta_apps.max_publications_per_minute` nasce
  -- nulo de proposito: o limite real de chamadas por app da Meta e dinamico e
  -- so aparece no cabecalho X-App-Usage. Cravar um numero inventado aqui daria
  -- falsa sensacao de protecao e estrangularia a fila por engano. Com nulo o
  -- comportamento e identico ao de hoje, e a alavanca fica pronta para quando o
  -- numero real for medido.
  if check_reason is null
     and profile_provider = 'meta_official'
     and profile_meta_app_id is not null then
    select app_row.max_publications_per_minute into app_minute_limit
    from public.meta_apps as app_row
    where app_row.id = profile_meta_app_id
      and app_row.organization_id = item_row.organization_id
      and app_row.deleted_at is null;

    if app_minute_limit is not null then
      select count(*)::integer into app_check_count
      from public.publication_items as published_item
      join public.instagram_profiles as profile on profile.id = published_item.profile_id
      where published_item.organization_id = item_row.organization_id
        and profile.meta_app_id = profile_meta_app_id
        and published_item.status = 'published'
        and published_item.published_at >= now_at - interval '1 minute';

      app_check_count := app_check_count + (
        select count(*)::integer
        from public.publication_dispatch_rate_reservations as reservation
        join public.instagram_profiles as reserved_profile
          on reserved_profile.id = reservation.profile_id
        where reservation.organization_id = item_row.organization_id
          and reserved_profile.meta_app_id = profile_meta_app_id
          and reservation.expires_at > now_at
      );

      if app_check_count >= app_minute_limit then
        check_reason := 'meta_app_minute_limit';
        check_message := 'Publicação adiada pelo limite por minuto do app da Meta.';
        check_count := app_check_count;
        check_limit := app_minute_limit;
        retry_at := now_at + interval '1 minute';
      end if;
    end if;
  end if;

  if check_reason is not null then
    retry_at := coalesce(retry_at, now_at + interval '1 minute');

    update public.publication_items as item_update
    set status = 'waiting',
        claimed_by = null,
        lease_until = null,
        next_attempt_at = retry_at,
        last_error_code = check_reason,
        last_error_message = check_message
    where item_update.id = item_row.id;

    perform public.log_publication_item_event(
      item_row.id,
      'processing_deferred',
      item_row.status,
      'waiting',
      null,
      trim(p_worker_id),
      check_reason,
      check_message,
      jsonb_build_object(
        'provider', profile_provider,
        'format', item_row.format,
        'current_count', check_count,
        'limit_value', check_limit,
        'next_attempt_at', retry_at,
        'settings', to_jsonb(setting_row)
      )
    );

    return query select false, check_reason, profile_provider, check_count, check_limit, retry_at, to_jsonb(setting_row);
    return;
  end if;

  insert into public.publication_dispatch_rate_reservations (
    publication_item_id,
    organization_id,
    profile_id,
    provider,
    expires_at
  ) values (
    item_row.id,
    item_row.organization_id,
    item_row.profile_id,
    profile_provider,
    now_at + make_interval(secs => effective_reservation_seconds)
  )
  on conflict (publication_item_id) do update
  set expires_at = excluded.expires_at;

  return query select true, null::text, profile_provider, check_count, check_limit, null::timestamptz, to_jsonb(setting_row);
end;
$$;

revoke all on function public.assert_bulk_sequential_schedule(integer, bigint, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.review_bulk_sequential_rotation_schedule(uuid, uuid[], integer, bigint, timestamptz, public.publication_format, timestamptz) from public, anon;
grant execute on function public.review_bulk_sequential_rotation_schedule(uuid, uuid[], integer, bigint, timestamptz, public.publication_format, timestamptz) to authenticated, service_role;
revoke all on function public.create_bulk_sequential_rotation_plan_v2(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, timestamptz, text, text, text, uuid, text, uuid, smallint, integer, timestamptz) from public, anon;
grant execute on function public.create_bulk_sequential_rotation_plan_v2(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, timestamptz, text, text, text, uuid, text, uuid, smallint, integer, timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
