-- 437 — Lista de legendas no plano em massa (uma legenda diferente a cada post).
--
-- POR QUE EXISTE. O plano em massa tinha UMA legenda, copiada em todos os posts.
-- Com esta migration o dono pode colar varias legendas inteiras separadas por
-- ";" (a separacao e a validacao ficam no app, lib/publications/bulk-caption-list.ts)
-- e cada post recebe uma delas, trocando a cada post do perfil.
--
-- DECISOES DO DONO (21/09/2026): cada item e uma legenda inteira; troca a cada
-- post; sem IA; o modo de uma legenda so continua padrao e identico.
--
-- COMO A LEGENDA DE CADA POST E ESCOLHIDA. Mesmo desenho do rodizio de midias
-- (196): cada perfil do plano ganha, na confirmacao, um ponto de partida e um
-- passo coprimo com N, e o post do slot s recebe a legenda
--   ordinal = mod(caption_offset + s * caption_step, N).
-- Consequencias garantidas: o perfil passa por todas as N antes de repetir; nunca
-- repete a legenda do post anterior (N >= 2); perfis diferentes andam em ordens
-- diferentes. A semente e rotation_seed || ':caption:' || ordinal do perfil, com
-- ordinal 0 nos helpers: com a semente do plano mais o ordinal (como nas midias)
-- o ponto de partida da legenda andaria junto com o da midia em todos os perfis
-- (os dois sao lineares no ordinal), e com N igual ao numero de midias o video i
-- sairia sempre com a legenda i+d. Sempre diversificado, mesmo com order_mode
-- 'same_order'. Deterministico: o gerador refaz um bloco e sai a mesma legenda.
--
-- DESENHO, E O QUE ELE EVITA:
--   * TABELA LATERAL bulk_publication_plan_captions, espelho de
--     bulk_publication_plan_media, e nao text[] na linha do plano: o gerador faz
--     `select * into plan_row` a cada bloco e leria a lista inteira toda vez.
--   * Nenhuma coluna, gatilho ou indice novo em publication_items. A legenda de
--     cada item ja era uma coluna; so o valor escrito muda.
--   * A ordem de cada perfil e gravada na confirmacao (como rotation_offset e
--     rotation_step), nao recalculada a cada bloco: um plano em andamento nunca
--     muda de ordem, e o suporte responde "qual legenda o perfil X recebe no slot
--     s" com uma consulta.
--   * PLANO SEM LISTA NAO MUDA NADA: caption_variant_count = 0, o join com a
--     tabela de legendas usa mod(..., nullif(0, 0)) = null e nao encontra linha,
--     e o item recebe plan_row.caption como antes.
--   * ITEM SEM LEGENDA E IMPOSSIVEL NO MODO LISTA: o gerador recusa (P0001) plano
--     com lista incompleta, e o filtro no CTE desired faz qualquer lacuna virar
--     23505 na conferencia, desfazendo o bloco. Nada de coalesce: plan_row.caption
--     e null no modo lista e um coalesce publicaria sem legenda em silencio.
--   * CRIACAO: create_bulk_*_plan_v4 = v3 + p_caption_variants. A v3 fica
--     intocada: um parametro com default nela criaria uma segunda versao que casa
--     com as chamadas de hoje e o PostgREST responderia PGRST203 (ambigua).
--
-- A PROXIMA COPIA DO GERADOR PARTE DESTA MIGRATION, NAO DA 436. Uma copia a partir
-- da 436 derrubaria as listas de legendas (o teste
-- lib/publications/caption-variants-migration.test.ts barra isso).
--
-- PESO: plano normal nao paga nada. Plano com lista: uma leitura por chave
-- primaria por post no gerador e, na confirmacao, um UPDATE dos perfis do plano
-- (medido em 21/09: o sorteio para 651 perfis e 1.000 legendas custa ~0,5 s).
--
-- Aditiva.

-- O ALTER TABLE pede trava forte por instantes; se houver transacao longa na
-- frente, desiste em vez de enfileirar o gerador atras.
set lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 1. Colunas
-- ---------------------------------------------------------------------------

alter table public.bulk_publication_plans
  add column if not exists caption_variant_count integer not null default 0;

alter table public.bulk_publication_plans
  drop constraint if exists bulk_publication_plans_caption_variants_check;
alter table public.bulk_publication_plans
  add constraint bulk_publication_plans_caption_variants_check
  check (caption_variant_count = 0
    or (caption_variant_count between 2 and 1000 and caption is null and format <> 'story'));

comment on column public.bulk_publication_plans.caption_variant_count is
  '437: quantas legendas a lista do plano tem (bulk_publication_plan_captions). 0 = modo de sempre, uma legenda (caption) para todos.';

alter table public.bulk_publication_plan_profiles
  add column if not exists caption_offset bigint not null default 0,
  add column if not exists caption_step bigint not null default 1;

-- NOT VALID: as linhas existentes ja tem os defaults validos, e validar varreria
-- ~70 mil linhas segurando a trava. Linhas novas e atualizadas sao conferidas.
alter table public.bulk_publication_plan_profiles
  drop constraint if exists bulk_publication_plan_profiles_caption_rotation_check;
alter table public.bulk_publication_plan_profiles
  add constraint bulk_publication_plan_profiles_caption_rotation_check
  check (caption_offset >= 0 and caption_step > 0) not valid;

comment on column public.bulk_publication_plan_profiles.caption_offset is
  '437: ponto de partida do perfil na lista de legendas do plano. Gravado na confirmacao.';
comment on column public.bulk_publication_plan_profiles.caption_step is
  '437: passo do perfil na lista de legendas (coprimo com a quantidade). Gravado na confirmacao.';

-- ---------------------------------------------------------------------------
-- 2. Tabela das legendas
-- ---------------------------------------------------------------------------

create table if not exists public.bulk_publication_plan_captions (
  plan_id uuid not null references public.bulk_publication_plans (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  ordinal bigint not null check (ordinal between 0 and 999),
  caption text not null check (char_length(caption) between 1 and 2200),
  created_at timestamptz not null default timezone('utc', now()),
  -- Chave primaria (e nao so unique): e a busca do gerador, uma por post.
  primary key (plan_id, ordinal)
);

comment on table public.bulk_publication_plan_captions is
  '437: lista de legendas de um plano em massa, na ordem colada. Escrita so por apply_bulk_plan_caption_variants, na confirmacao do plano. Some em cascata com o plano.';

alter table public.bulk_publication_plan_captions enable row level security;
revoke all on table public.bulk_publication_plan_captions from public, anon, authenticated;
grant select, insert, delete on table public.bulk_publication_plan_captions to service_role;

-- ---------------------------------------------------------------------------
-- 3. Validacao e gravacao da lista
-- ---------------------------------------------------------------------------

-- As mesmas regras de lib/publications/bulk-caption-list.ts. O app ja valida;
-- esta e a ultima barreira para quem chama a RPC direto.
create or replace function public.assert_bulk_caption_variants(
  p_format public.publication_format,
  p_caption text,
  p_caption_variants text[]
) returns void
language plpgsql set search_path = public as $$
declare
  item_count integer := coalesce(cardinality(p_caption_variants), 0);
begin
  if p_caption_variants is null then
    return;
  end if;
  if p_format = 'story' then
    raise exception using errcode = '22023', message = 'Story não leva legenda no Instagram; a lista de legendas não vale para Story.';
  end if;
  if nullif(p_caption, '') is not null then
    raise exception using errcode = '22023', message = 'Use uma legenda para todos os posts ou a lista de legendas, não as duas.';
  end if;
  if array_ndims(p_caption_variants) is distinct from 1 or item_count not between 2 and 1000 then
    raise exception using errcode = '22023', message = 'A lista precisa ter de 2 a 1.000 legendas.';
  end if;
  if exists (
    select 1 from unnest(p_caption_variants) as item(caption)
    where item.caption is null or item.caption !~ '\S' or char_length(item.caption) > 2200
  ) then
    raise exception using errcode = '22023', message = 'A lista tem legenda vazia ou acima de 2.200 caracteres.';
  end if;
  if (select count(distinct item.caption) from unnest(p_caption_variants) as item(caption)) <> item_count then
    raise exception using errcode = '22023', message = 'A lista tem legendas repetidas.';
  end if;
  if (select sum(char_length(item.caption)) from unnest(p_caption_variants) as item(caption)) > 300000 then
    raise exception using errcode = '22023', message = 'A lista de legendas passa de 300.000 caracteres.';
  end if;
end;
$$;

-- Na criacao grava a lista e a ordem de cada perfil; na repeticao do mesmo
-- pedido confere que a lista e a mesma (a lista nao entra no request_hash da v2,
-- mesmo padrao da capa na 207 e da receita de video na 436).
create or replace function public.apply_bulk_plan_caption_variants(
  p_result jsonb,
  p_caption_variants text[]
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  resolved_plan_id uuid := nullif(p_result ->> 'planId', '')::uuid;
  item_count integer := coalesce(cardinality(p_caption_variants), 0);
  target_plan public.bulk_publication_plans%rowtype;
  inserted_count bigint;
begin
  if resolved_plan_id is null then
    raise exception using errcode = 'P0002', message = 'Plano em massa não foi criado.';
  end if;
  select * into target_plan from public.bulk_publication_plans where id = resolved_plan_id for update;
  if target_plan.id is null then
    raise exception using errcode = 'P0002', message = 'Plano em massa não foi criado.';
  end if;

  if coalesce((p_result ->> 'created')::boolean, false) then
    if item_count = 0 then
      return p_result;
    end if;
    insert into public.bulk_publication_plan_captions (plan_id, organization_id, ordinal, caption)
    select target_plan.id, target_plan.organization_id, item.position - 1, item.caption
    from unnest(p_caption_variants) with ordinality as item(caption, position);
    get diagnostics inserted_count = row_count;
    if inserted_count <> item_count then
      raise exception using errcode = 'P0001', message = 'Lista de legendas não foi gravada inteira.';
    end if;

    update public.bulk_publication_plans
    set caption_variant_count = item_count
    where id = target_plan.id;

    -- Semente por perfil e ordinal 0 nos helpers: ver o cabecalho.
    update public.bulk_publication_plan_profiles profile_plan
    set caption_offset = public.bulk_rotation_v2_profile_offset(target_plan.rotation_seed || ':caption:' || profile_plan.ordinal, 0, item_count),
        caption_step = public.bulk_rotation_v2_profile_step(target_plan.rotation_seed || ':caption:' || profile_plan.ordinal, 0, item_count)
    where profile_plan.plan_id = target_plan.id;
  else
    if target_plan.caption_variant_count <> item_count or (item_count > 0 and exists (
      select 1
      from unnest(p_caption_variants) with ordinality as item(caption, position)
      left join public.bulk_publication_plan_captions stored
        on stored.plan_id = target_plan.id and stored.ordinal = item.position - 1
      where stored.caption is distinct from item.caption
    )) then
      raise exception using errcode = '23505', message = 'Este pedido já foi criado com outra lista de legendas.';
    end if;
  end if;
  return p_result || jsonb_build_object('captionVariantCount', item_count);
end;
$$;

revoke all on function public.assert_bulk_caption_variants(public.publication_format, text, text[]) from public, anon, authenticated;
revoke all on function public.apply_bulk_plan_caption_variants(jsonb, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Criacao de plano com lista: v4 = v3 + p_caption_variants
-- ---------------------------------------------------------------------------
-- Valida ANTES de criar qualquer coisa; a v3 continua tratando a receita de
-- video; o apply grava a lista na mesma transacao -- antes do commit nenhum chunk
-- e visivel para o gerador, entao nenhum item nasce sem a ordem do perfil.

create or replace function public.create_bulk_rotation_plan_v4(
  p_organization_id uuid, p_request_key text, p_name text, p_profile_ids uuid[],
  p_origin_type text, p_origin_group_id uuid, p_format public.publication_format,
  p_interval_minutes integer, p_duration_days bigint, p_caption text, p_order_mode text,
  p_rotation_seed text, p_reel_cover_media_asset_id uuid, p_reel_cover_origin_type text,
  p_reel_cover_origin_group_id uuid, p_video_variant_recipe text, p_caption_variants text[],
  p_algorithm_version smallint default 2, p_chunk_size integer default 500,
  p_now timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_bulk_caption_variants(p_format, p_caption, p_caption_variants);
  return public.apply_bulk_plan_caption_variants(
    public.create_bulk_rotation_plan_v3(
      p_organization_id, p_request_key, p_name, p_profile_ids, p_origin_type, p_origin_group_id,
      p_format, p_interval_minutes, p_duration_days, p_caption, p_order_mode, p_rotation_seed,
      p_reel_cover_media_asset_id, p_reel_cover_origin_type, p_reel_cover_origin_group_id,
      p_video_variant_recipe, p_algorithm_version, p_chunk_size, p_now),
    p_caption_variants);
end;
$$;

create or replace function public.create_bulk_daily_rotation_plan_v4(
  p_organization_id uuid, p_request_key text, p_name text, p_profile_ids uuid[],
  p_origin_type text, p_origin_group_id uuid, p_format public.publication_format,
  p_repeat_days bigint, p_daily_time time, p_caption text, p_order_mode text,
  p_rotation_seed text, p_reel_cover_media_asset_id uuid, p_reel_cover_origin_type text,
  p_reel_cover_origin_group_id uuid, p_video_variant_recipe text, p_caption_variants text[],
  p_algorithm_version smallint default 2, p_chunk_size integer default 500,
  p_now timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_bulk_caption_variants(p_format, p_caption, p_caption_variants);
  return public.apply_bulk_plan_caption_variants(
    public.create_bulk_daily_rotation_plan_v3(
      p_organization_id, p_request_key, p_name, p_profile_ids, p_origin_type, p_origin_group_id,
      p_format, p_repeat_days, p_daily_time, p_caption, p_order_mode, p_rotation_seed,
      p_reel_cover_media_asset_id, p_reel_cover_origin_type, p_reel_cover_origin_group_id,
      p_video_variant_recipe, p_algorithm_version, p_chunk_size, p_now),
    p_caption_variants);
end;
$$;

create or replace function public.create_bulk_sequential_rotation_plan_v4(
  p_organization_id uuid, p_request_key text, p_name text, p_profile_ids uuid[],
  p_origin_type text, p_origin_group_id uuid, p_format public.publication_format,
  p_interval_minutes integer, p_post_count bigint, p_start_at timestamptz, p_caption text,
  p_order_mode text, p_rotation_seed text, p_reel_cover_media_asset_id uuid,
  p_reel_cover_origin_type text, p_reel_cover_origin_group_id uuid, p_video_variant_recipe text,
  p_caption_variants text[],
  p_algorithm_version smallint default 2, p_chunk_size integer default 500,
  p_now timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_bulk_caption_variants(p_format, p_caption, p_caption_variants);
  return public.apply_bulk_plan_caption_variants(
    public.create_bulk_sequential_rotation_plan_v3(
      p_organization_id, p_request_key, p_name, p_profile_ids, p_origin_type, p_origin_group_id,
      p_format, p_interval_minutes, p_post_count, p_start_at, p_caption, p_order_mode, p_rotation_seed,
      p_reel_cover_media_asset_id, p_reel_cover_origin_type, p_reel_cover_origin_group_id,
      p_video_variant_recipe, p_algorithm_version, p_chunk_size, p_now),
    p_caption_variants);
end;
$$;

-- Licao da 433: funcao nova nasce com execute para PUBLIC; sem o grant explicito
-- para authenticated o painel recebe 42501 e o service_role esconde a falha.
revoke all on function public.create_bulk_rotation_plan_v4(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, text, text, text, uuid, text, uuid, text, text[], smallint, integer, timestamptz) from public, anon;
revoke all on function public.create_bulk_daily_rotation_plan_v4(uuid, text, text, uuid[], text, uuid, public.publication_format, bigint, time, text, text, text, uuid, text, uuid, text, text[], smallint, integer, timestamptz) from public, anon;
revoke all on function public.create_bulk_sequential_rotation_plan_v4(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, timestamptz, text, text, text, uuid, text, uuid, text, text[], smallint, integer, timestamptz) from public, anon;
grant execute on function public.create_bulk_rotation_plan_v4(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, text, text, text, uuid, text, uuid, text, text[], smallint, integer, timestamptz) to authenticated, service_role;
grant execute on function public.create_bulk_daily_rotation_plan_v4(uuid, text, text, uuid[], text, uuid, public.publication_format, bigint, time, text, text, text, uuid, text, uuid, text, text[], smallint, integer, timestamptz) to authenticated, service_role;
grant execute on function public.create_bulk_sequential_rotation_plan_v4(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, timestamptz, text, text, text, uuid, text, uuid, text, text[], smallint, integer, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Geracao: a legenda de cada post sai da lista
-- ---------------------------------------------------------------------------
-- Copia integral da 436 (conferida igual a producao em 21/09/2026, 14.954
-- caracteres) com as mudancas marcadas com 437: a guarda de lista incompleta, o
-- left join na tabela de legendas (no CTE desired e na conferencia), a coluna
-- desired.caption no insert e a comparacao da conferencia. Na conferencia o join
-- das legendas vem ANTES do join de publication_items: a comparacao fica no ON
-- desse join e nao pode citar uma tabela juntada depois (42P01 so apareceria na
-- primeira execucao, para todo plano).

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
  -- 436: o plano pede variante de video e este perfil pode recebe-la.
  wants_video_variant boolean := false;
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

  -- 437: plano com lista de legendas so gera com a lista inteira no banco. Sem
  -- ela o item nasceria sem legenda (plan_row.caption e null no modo lista).
  if plan_row.caption_variant_count > 0 then
    if (select count(*) from public.bulk_publication_plan_captions caption_row
        where caption_row.plan_id = plan_row.id) <> plan_row.caption_variant_count then
      raise exception using errcode = 'P0001', message = 'Lista de legendas do plano incompleta; geração interrompida.';
    end if;
  end if;

  -- Sequencial (432): sem a janela de 10 minutos entre lotes. Só é pulado o slot
  -- que cairia no MESMO instante de outro item ativo do perfil e formato — o caso
  -- em que o gatilho de vaga única (177) derrubaria o bloco inteiro com 23505.
  spacing := case when plan_row.schedule_mode = 'sequential'
    then interval '0' else make_interval(mins => spacing_minutes) end;

  -- 436: variante so para Reel de perfil da API oficial da Meta. Calculado uma vez
  -- por chamada; plano sem receita nao paga nem a leitura do perfil.
  wants_video_variant := plan_row.video_variant_recipe is not null
    and plan_row.format = 'reel'
    and exists (
      select 1 from public.instagram_profiles profile
      where profile.id = chunk_row.profile_id and profile.provider = 'meta_official'
    );

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
      -- 437: legenda da lista (uma por post) ou a legenda unica de sempre.
      case when plan_row.caption_variant_count > 0 then caption_variant.caption else plan_row.caption end as caption,
      media.media_asset_id
    from generate_series(range_start, range_end - 1) slot(slot_index)
    join public.bulk_publication_plan_media media on media.plan_id = plan_row.id
      and media.ordinal = mod(profile_plan.rotation_offset + slot.slot_index * profile_plan.rotation_step, plan_row.media_count)
    -- 437: plano sem lista tem contagem 0; nullif faz o mod dar null e o join nao
    -- encontrar linha, sem divisao por zero.
    left join public.bulk_publication_plan_captions caption_variant
      on caption_variant.plan_id = plan_row.id
     and caption_variant.ordinal = mod(profile_plan.caption_offset + slot.slot_index * profile_plan.caption_step, nullif(plan_row.caption_variant_count, 0))
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
      -- 437: nunca materializar item de lista sem legenda.
      and (plan_row.caption_variant_count = 0 or caption_variant.caption is not null)
  ), inserted as (
    insert into public.publication_items (
      organization_id, batch_id, profile_id, format, status, execute_at, caption,
      idempotency_key, reel_cover_media_asset_id
    )
    select plan_row.organization_id, plan_row.batch_id, profile_plan.profile_id,
      plan_row.format, 'waiting'::public.publication_item_status, desired.execute_at,
      desired.caption, desired.idempotency_key, plan_row.reel_cover_media_asset_id
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
  ), inserted_variants as (
    -- 436: a linha da variante nasce na MESMA instrucao do item, entao nao existe
    -- item de plano com receita sem a linha (a preparacao trata item sem linha
    -- como post normal, e postaria o arquivo cru).
    insert into public.publication_item_video_variants (
      publication_item_id, organization_id, plan_id, source_media_asset_id, recipe, execute_at
    )
    select inserted.id, plan_row.organization_id, plan_row.id, desired.media_asset_id,
      plan_row.video_variant_recipe, desired.execute_at
    from inserted join desired using (idempotency_key)
    where wants_video_variant
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
  -- 437: antes do join de itens, porque a comparacao da legenda fica no ON dele.
  left join public.bulk_publication_plan_captions caption_variant
    on caption_variant.plan_id = plan_row.id
   and caption_variant.ordinal = mod(profile_plan.caption_offset + slot.slot_index * profile_plan.caption_step, nullif(plan_row.caption_variant_count, 0))
  join public.publication_items item
    on item.organization_id = plan_row.organization_id
   and item.idempotency_key = concat('bulk:', plan_row.id, ':', profile_plan.profile_id, ':', slot.slot_index)
   and item.batch_id = plan_row.batch_id and item.profile_id = profile_plan.profile_id
   and item.format = plan_row.format
   and item.execute_at = profile_plan.schedule_base_at + ((((slot.slot_index + 1) * plan_row.interval_minutes::bigint)::text || ' minutes')::interval)
   and item.caption is not distinct from (case when plan_row.caption_variant_count > 0 then caption_variant.caption else plan_row.caption end)
   and (plan_row.caption_variant_count = 0 or caption_variant.caption is not null)
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

notify pgrst, 'reload schema';
