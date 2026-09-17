-- Esquema Sequencial: sem horário inicial escolhido, o primeiro post fica pelo
-- menos 30 minutos à frente.
--
-- PEDIDO DO DONO (17/09/2026): "se tiver demorado pra preencher a fila por ter
-- vários agendamentos, já perdeu o primeiro post; mesmo sem escolher horário
-- inicial, já tem que ser uns 30 min à frente".
--
-- POR QUE. Na 432, sem início escolhido, a base do perfil era
-- `greatest(agora, último item ativo do perfil no formato, fim do horizonte)` e
-- o primeiro post saía UM intervalo depois dela. No intervalo contínuo isso nunca
-- doeu, porque o piso de 29 minutos já joga o primeiro post meia hora à frente;
-- no sequencial o intervalo pode ser de 1 minuto. E o gerador pula todo horário
-- que já venceu quando chega nele (invariante da 326): medido em 17/09/2026 nos
-- 63 planos dos 4 dias anteriores, o último perfil de um plano terminou de gerar
-- em 8 min na mediana, 40 min no p90 e 59 min no pior caso (planos de 377-416
-- perfis criados juntos às 06:52-07:05 de 14/09).
--
-- O QUE MUDA. Só a base sem início escolhido, na revisão e na criação:
-- `greatest(agora + 30 min − intervalo, agora, último item ativo, fim do
-- horizonte)`. O primeiro post fica em pelo menos agora + 30 min e continua
-- depois do que o perfil já tem agendado. Com início escolhido nada muda (a
-- revisão já exige 30 min de folga). Planos já criados não mudam.
--
-- Cópias integrais das duas funções da 432 (conferidas iguais à produção em
-- 17/09/2026), com a troca apenas da linha da base.

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
        -- 434: primeiro post pelo menos 30 min depois da revisão.
        resolved_now + interval '30 minutes' - p_interval_minutes * interval '1 minute',
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
      -- 434: sem início escolhido, o primeiro post fica pelo menos 30 minutos à
      -- frente da confirmação, mesmo que o perfil não tenha nada agendado. O
      -- gerador nunca cria horário vencido (326) e, com a fila de geração cheia,
      -- chega a levar 40 min (p90) até o último perfil de um plano: com a base
      -- em "agora" e intervalo de 5 min, os primeiros posts nasciam vencidos.
      schedule_base := greatest(resolved_now + interval '30 minutes' - p_interval_minutes * interval '1 minute', resolved_now, coalesce(active_last, resolved_now), coalesce(reserved_last, resolved_now));
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

notify pgrst, 'reload schema';
