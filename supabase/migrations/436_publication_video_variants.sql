-- 436 — Variante de video por post (Reels), gerada numa VPS separada.
--
-- POR QUE EXISTE. O mesmo arquivo sobe dezenas de vezes por dia em perfis
-- diferentes (19/09/2026: 50.010 reels de 1.512 arquivos; media de 33 posts por
-- arquivo, maximo de 176). O dono mediu que conteudo repetido perde alcance e que
-- o Variador manual nao escala (uma leva modificada em 100 perfis x 24 posts/dia
-- vira repetida em ~2 h). Com esta migration um plano em massa pode pedir que
-- CADA post de Reel suba um arquivo unico, gerado pelo worker de variantes
-- (scripts/workers/publication-video-variant-worker.mjs) numa VPS propria.
--
-- DECISOES DO DONO (20/09/2026):
--   * Variante que nao ficou pronta NAO posta o arquivo cru: o item fica
--     bloqueado na preparacao e vence pelo corte normal de atraso (300 s).
--   * A opcao mora no plano em massa (Rotacao, Diario, Sequencial), so Reel,
--     so perfil da API oficial da Meta.
--   * Receitas: `micro` (padrao), `container` e `light` (teste de desempenho).
--   * Uma variante por post, guardada no R2 e apagada depois de postar.
--
-- DESENHO, E O QUE ELE EVITA DE PROPOSITO:
--   * TABELA LATERAL, nao coluna em publication_items: a tabela quente tem 7
--     gatilhos e ~34 indices, e o arquivo frio (333) exige paridade de colunas.
--     A lateral some em cascata com o item -- estado operacional que nao
--     sobrevive ao item, como as outras seis tabelas em cascata da 333.
--   * claim_publication_items NAO MUDA (75% do tempo de banco da fila, medido em
--     20/09). O predicado da 426 ja exige preparation_status = 'ready'; a variante
--     entra como condicao da PREPARACAO, que roda 24 h antes.
--   * O ITEM NAO NASCE BLOQUEADO: o gatilho publication_item_media_reset_v2_preparation
--     (264) recoloca 'pending' quando o gerador liga a midia. Por isso o worker
--     trabalha com 30 h de antecedencia, mais que a janela de 24 h da preparacao;
--     so o item criado em cima da hora leva UM bloqueio, que o worker libera ao
--     concluir (complete_publication_video_variant).
--   * SEM CORRIDA entre preparacao e conclusao: as duas RPCs travam na mesma
--     ordem, variante -> item.
--   * UNICIDADE PROVADA NO BANCO: SHA-256 por variante com indice unico por
--     arquivo de origem. Saida repetida (defeito no sorteio) e recusada com 23505
--     e o worker sorteia de novo.
--
-- PESO NO BANCO, estimado sobre o pg_stat_statements de 20/09 (media de 13,2
-- dias; caminho quente ~8.000 s/dia): com a frota inteira migrada, ~+18 mil
-- chamadas/dia (+2,6%) e ~+33 s/dia (+0,4%), ja descontado o
-- record_media_asset_delivery_attempt que os posts com variante deixam de chamar.
-- O worker limita a 2 chamadas simultaneas.
--
-- Aditiva. Nada muda para plano sem receita: video_variant_recipe nasce NULL e
-- o gerador so cria a linha lateral quando ha receita.

-- O ALTER TABLE e a FK nova pedem trava forte por instantes; se houver transacao
-- longa na frente, desiste em vez de enfileirar a fila inteira atras.
set lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 1. Receita no plano
-- ---------------------------------------------------------------------------

alter table public.bulk_publication_plans
  add column if not exists video_variant_recipe text;

alter table public.bulk_publication_plans
  drop constraint if exists bulk_publication_plans_video_variant_recipe_check;
alter table public.bulk_publication_plans
  add constraint bulk_publication_plans_video_variant_recipe_check
  check (video_variant_recipe is null
    or (video_variant_recipe in ('container', 'micro', 'light') and format = 'reel'));

comment on column public.bulk_publication_plans.video_variant_recipe is
  '436: receita de variante de video por post. NULL = posta o arquivo original (comportamento de sempre). So Reel.';

-- ---------------------------------------------------------------------------
-- 2. Tabela lateral
-- ---------------------------------------------------------------------------

create table if not exists public.publication_item_video_variants (
  -- PK = FK: no maximo uma variante por item, e o PostgREST embute como objeto.
  publication_item_id uuid primary key
    references public.publication_items(id) on delete cascade,
  organization_id uuid not null,
  plan_id uuid,
  source_media_asset_id uuid not null,
  recipe text not null check (recipe in ('container', 'micro', 'light')),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'failed', 'deleted')),
  -- Copia do execute_at do item, para o claim ordenar sem tocar na tabela quente.
  -- O claim a reconfere por PK e corrige se o item foi reagendado.
  execute_at timestamptz not null,
  claimed_by text,
  lease_until timestamptz,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default timezone('utc', now()),
  last_error_code text,
  last_error_message text,
  storage_path text,
  size_bytes bigint,
  checksum_sha256 text,
  recipe_params jsonb,
  encode_ms integer,
  ready_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

comment on table public.publication_item_video_variants is
  '436: uma linha por post de Reel com variante de video. Estado operacional: some em cascata com o item (arquivo frio, 333). O objeto no R2 e apagado pelo worker de variantes depois que o item termina; a regra de ciclo de vida do bucket (10 dias) cobre o que escapar.';

-- Fila do worker: o que falta gerar, do post mais proximo para o mais distante.
create index if not exists publication_item_video_variants_work_idx
  on public.publication_item_video_variants (execute_at, publication_item_id)
  where status in ('pending', 'processing');

-- Coleta de lixo: variantes prontas cujo horario ja passou.
create index if not exists publication_item_video_variants_gc_idx
  on public.publication_item_video_variants (execute_at, publication_item_id)
  where status = 'ready';

create index if not exists publication_item_video_variants_plan_idx
  on public.publication_item_video_variants (plan_id, status);

-- A prova de que nenhum video se repete: o mesmo arquivo de origem nunca tem
-- duas variantes com os mesmos bytes.
create unique index if not exists publication_item_video_variants_unique_bytes_idx
  on public.publication_item_video_variants (source_media_asset_id, checksum_sha256)
  where checksum_sha256 is not null;

-- Tabela que so cresce por insert e muda de estado 2-3 vezes por linha: o
-- autovacuum padrao (20% de tuplas mortas) deixaria o indice parcial da fila
-- inchado. Mesmos numeros da 417.
alter table public.publication_item_video_variants set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_vacuum_insert_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02
);

alter table public.publication_item_video_variants enable row level security;
revoke all on table public.publication_item_video_variants from public, anon, authenticated;
grant select, insert, update, delete on table public.publication_item_video_variants to service_role;

-- ---------------------------------------------------------------------------
-- 3. Worker de variantes: claim, conclusao, falha
-- ---------------------------------------------------------------------------

create or replace function public.claim_publication_video_variants(
  p_worker_id text,
  p_limit integer default 30,
  p_lease_seconds integer default 300,
  p_lead_hours integer default 30
) returns table (
  publication_item_id uuid,
  organization_id uuid,
  source_media_asset_id uuid,
  recipe text,
  execute_at timestamptz,
  attempt_count integer,
  source_storage_path text,
  source_size_bytes bigint,
  source_mime_type text
)
language plpgsql security definer set search_path = public as $$
declare
  resolved_now timestamptz := timezone('utc', now());
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode reivindicar variantes.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120
    or p_limit not between 1 and 200 or p_lease_seconds not between 30 and 1800
    or p_lead_hours not between 1 and 168 then
    raise exception using errcode = '22023', message = 'Parâmetros de claim de variante inválidos.';
  end if;

  return query
  with candidates as (
    select variant.publication_item_id
    from public.publication_item_video_variants variant
    where variant.status in ('pending', 'processing')
      and variant.execute_at <= resolved_now + make_interval(hours => p_lead_hours)
      and variant.next_attempt_at <= resolved_now
      and (variant.lease_until is null or variant.lease_until <= resolved_now)
    order by variant.execute_at, variant.publication_item_id
    limit p_limit
  ), locked as (
    -- Reconfere sob a trava (disciplina da 425): outro processo pode ter levado
    -- a linha entre a selecao e a trava.
    select variant.publication_item_id
    from public.publication_item_video_variants variant
    join candidates using (publication_item_id)
    where variant.status in ('pending', 'processing')
      and (variant.lease_until is null or variant.lease_until <= resolved_now)
    for update of variant skip locked
  ), opened as (
    -- Leitura do item por PK: so gera variante para item que ainda vai postar.
    select locked.publication_item_id, item.execute_at,
      (item.status in ('waiting', 'ready') and item.archived_at is null) as is_open,
      -- Perfil suspenso: o item pode voltar. Nem gera (gastaria nucleo e R2 com
      -- post que talvez nunca saia) nem descarta; olha de novo em 1 h.
      (item.status = 'suspended' and item.archived_at is null) as is_paused
    from locked
    join public.publication_items item on item.id = locked.publication_item_id
  ), closed as (
    -- Item cancelado, vencido ou removido antes de a variante existir: nao ha
    -- objeto no R2, a linha vai direto para 'deleted'.
    update public.publication_item_video_variants variant
    set status = 'deleted', deleted_at = resolved_now, claimed_by = null, lease_until = null,
        updated_at = resolved_now
    from opened
    where variant.publication_item_id = opened.publication_item_id
      and not opened.is_open and not opened.is_paused
    returning variant.publication_item_id
  ), paused as (
    update public.publication_item_video_variants variant
    set status = 'pending', next_attempt_at = resolved_now + interval '1 hour',
        claimed_by = null, lease_until = null, updated_at = resolved_now
    from opened
    where variant.publication_item_id = opened.publication_item_id and opened.is_paused
    returning variant.publication_item_id
  ), claimed as (
    update public.publication_item_video_variants variant
    set status = 'processing',
        claimed_by = trim(p_worker_id),
        lease_until = resolved_now + make_interval(secs => p_lease_seconds),
        attempt_count = variant.attempt_count + 1,
        execute_at = coalesce(opened.execute_at, variant.execute_at),
        updated_at = resolved_now
    from opened
    where variant.publication_item_id = opened.publication_item_id and opened.is_open
    returning variant.*
  )
  select claimed.publication_item_id, claimed.organization_id, claimed.source_media_asset_id,
    claimed.recipe, claimed.execute_at, claimed.attempt_count,
    asset.storage_path, asset.size_bytes, asset.mime_type
  from claimed
  left join public.media_assets asset on asset.id = claimed.source_media_asset_id
  order by claimed.execute_at, claimed.publication_item_id;
end;
$$;

create or replace function public.complete_publication_video_variant(
  p_item_id uuid,
  p_worker_id text,
  p_storage_path text,
  p_size_bytes bigint,
  p_checksum_sha256 text,
  p_recipe_params jsonb,
  p_encode_ms integer
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  resolved_now timestamptz := timezone('utc', now());
  updated_variant public.publication_item_video_variants%rowtype;
  released boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode concluir variantes.';
  end if;
  if char_length(trim(coalesce(p_storage_path, ''))) not between 8 and 600
    or coalesce(p_size_bytes, 0) <= 0
    or coalesce(p_checksum_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Resultado de variante inválido.';
  end if;

  -- ORDEM DE TRAVA: variante primeiro, item depois. A mesma de
  -- resolve_publication_preparation_for_variant.
  -- Nao exige lease vigente: se o ffmpeg demorou mais que o lease e ninguem
  -- levou a linha, o trabalho feito vale. Colisao de bytes (indice unico)
  -- estoura 23505 e o worker sorteia de novo.
  update public.publication_item_video_variants variant
  set status = 'ready', storage_path = trim(p_storage_path), size_bytes = p_size_bytes,
      checksum_sha256 = p_checksum_sha256, recipe_params = p_recipe_params,
      encode_ms = p_encode_ms, ready_at = resolved_now,
      claimed_by = null, lease_until = null, last_error_code = null, last_error_message = null,
      updated_at = resolved_now
  where variant.publication_item_id = p_item_id
    and variant.status = 'processing'
    and variant.claimed_by = trim(p_worker_id)
  returning variant.* into updated_variant;

  if updated_variant.publication_item_id is null then
    -- Outro processo levou a linha: o chamador apaga o objeto que acabou de subir.
    return jsonb_build_object('itemId', p_item_id, 'status', 'stale');
  end if;

  -- Item criado em cima da hora, que a preparacao bloqueou esperando a variante:
  -- libera para a proxima passada. Item ainda 'pending' nao e tocado -- zero
  -- escrita a mais na tabela quente no caso normal.
  update public.publication_items item
  set next_preparation_at = resolved_now
  where item.id = p_item_id
    and item.preparation_status = 'blocked'
    and item.preparation_error_code = 'preparation_variant_pending'
    and item.status in ('waiting', 'ready');
  released := found;

  return jsonb_build_object('itemId', p_item_id, 'status', 'ready', 'releasedPreparation', released);
end;
$$;

create or replace function public.fail_publication_video_variant(
  p_item_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text default null,
  p_retry_seconds integer default 120,
  p_terminal boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  -- Oito tentativas com recuo cobrem queda de rede e de R2; depois disso o
  -- defeito e do arquivo ou da receita, e insistir so gasta nucleo.
  max_attempts constant integer := 8;
  resolved_now timestamptz := timezone('utc', now());
  updated_variant public.publication_item_video_variants%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode registrar falha de variante.';
  end if;
  if p_retry_seconds not between 5 and 86400 then
    raise exception using errcode = '22023', message = 'Intervalo de nova tentativa inválido.';
  end if;

  update public.publication_item_video_variants variant
  set status = case when p_terminal or variant.attempt_count >= max_attempts then 'failed' else 'pending' end,
      next_attempt_at = resolved_now + make_interval(secs => p_retry_seconds),
      claimed_by = null, lease_until = null,
      last_error_code = left(nullif(trim(coalesce(p_error_code, '')), ''), 120),
      last_error_message = left(nullif(trim(coalesce(p_error_message, '')), ''), 1200),
      updated_at = resolved_now
  where variant.publication_item_id = p_item_id
    and variant.status = 'processing'
    and variant.claimed_by = trim(p_worker_id)
  returning variant.* into updated_variant;

  if updated_variant.publication_item_id is null then
    return jsonb_build_object('itemId', p_item_id, 'status', 'stale');
  end if;
  return jsonb_build_object('itemId', p_item_id, 'status', updated_variant.status,
    'attemptCount', updated_variant.attempt_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Preparacao e despacho: decidir com a variante travada, e re-enfileirar
-- ---------------------------------------------------------------------------

-- Chamada pela preparacao no lugar de complete_publication_preparation quando o
-- item tem linha de variante. Mesmas conferencias de lease daquela RPC.
create or replace function public.resolve_publication_preparation_for_variant(
  p_item_id uuid,
  p_worker_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  -- Um dia: maior que qualquer espera real. Quem encurta e o worker de
  -- variantes, ao concluir. Sem isso o item voltaria a preparacao a cada 15 min
  -- (o p_retry_seconds fixo do publicador) so para ser bloqueado de novo.
  blocked_seconds constant integer := 86400;
  resolved_now timestamptz := timezone('utc', now());
  variant_row public.publication_item_video_variants%rowtype;
  variant_ready boolean;
  updated_item public.publication_items%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode resolver a preparação.';
  end if;

  -- ORDEM DE TRAVA: variante primeiro, item depois.
  select * into variant_row from public.publication_item_video_variants variant
  where variant.publication_item_id = p_item_id for update;
  if variant_row.publication_item_id is null then
    raise exception using errcode = 'P0002', message = 'Item sem variante de vídeo.';
  end if;
  variant_ready := variant_row.status = 'ready' and variant_row.storage_path is not null;

  update public.publication_items item
  set preparation_status = case when variant_ready then 'ready' else 'blocked' end,
      prepared_at = case when variant_ready then resolved_now else null end,
      preparation_claimed_by = null,
      preparation_lease_until = null,
      next_preparation_at = case when variant_ready then null
        else resolved_now + make_interval(secs => blocked_seconds) end,
      preparation_error_code = case when variant_ready then null
        when variant_row.status = 'failed' then 'preparation_variant_failed'
        else 'preparation_variant_pending' end,
      preparation_error_message = case when variant_ready then null
        when variant_row.status = 'failed' then left(concat('Variante de vídeo falhou: ', coalesce(variant_row.last_error_code, 'sem código')), 1200)
        else 'Variante de vídeo ainda não está pronta; o post não sobe com o arquivo original.' end
  where item.id = p_item_id
    and item.pipeline_version = 2
    and item.preparation_status = 'preparing'
    and item.preparation_claimed_by = trim(p_worker_id)
    and item.preparation_lease_until > resolved_now
  returning item.* into updated_item;

  if updated_item.id is null then
    raise exception using errcode = '40001', message = 'Lease de preparação ausente ou expirado';
  end if;
  return jsonb_build_object('itemId', updated_item.id, 'status', updated_item.preparation_status,
    'variantStatus', variant_row.status);
end;
$$;

-- O publicador achou a variante 'ready' no banco e o objeto ausente no R2.
-- Nunca cai para o original: a variante volta para a fila do worker.
create or replace function public.requeue_publication_video_variant(
  p_item_id uuid,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  resolved_now timestamptz := timezone('utc', now());
  updated_variant public.publication_item_video_variants%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode re-enfileirar variantes.';
  end if;

  update public.publication_item_video_variants variant
  set status = 'pending', storage_path = null, size_bytes = null, checksum_sha256 = null,
      ready_at = null, claimed_by = null, lease_until = null, next_attempt_at = resolved_now,
      last_error_code = 'video_variant_object_missing',
      last_error_message = left(nullif(trim(coalesce(p_reason, '')), ''), 1200),
      updated_at = resolved_now
  where variant.publication_item_id = p_item_id and variant.status = 'ready'
  returning variant.* into updated_variant;

  if updated_variant.publication_item_id is null then
    return jsonb_build_object('itemId', p_item_id, 'status', 'unchanged');
  end if;

  -- O item volta para a preparacao, que o bloqueia ate a variante nova existir.
  update public.publication_items item
  set preparation_status = 'pending', prepared_at = null, next_preparation_at = null,
      preparation_claimed_by = null, preparation_lease_until = null
  where item.id = p_item_id and item.status in ('waiting', 'ready')
    and item.preparation_status = 'ready';

  return jsonb_build_object('itemId', p_item_id, 'status', 'requeued');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Coleta de lixo: postou, apagou
-- ---------------------------------------------------------------------------

create or replace function public.claim_publication_video_variant_gc(
  p_limit integer default 200,
  p_grace_minutes integer default 60
) returns table (publication_item_id uuid, storage_path text)
language plpgsql security definer set search_path = public as $$
declare
  resolved_now timestamptz := timezone('utc', now());
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode coletar variantes.';
  end if;
  if p_limit not between 1 and 1000 or p_grace_minutes not between 5 and 10080 then
    raise exception using errcode = '22023', message = 'Parâmetros de coleta inválidos.';
  end if;

  -- So olha variante pronta cujo horario ja passou ha mais que a folga (indice
  -- parcial de 'ready'): o conjunto e pequeno e nao cresce com a fila futura.
  -- Item ainda vivo (suspenso, em nova tentativa) fica para a proxima passada.
  return query
  select variant.publication_item_id, variant.storage_path
  from public.publication_item_video_variants variant
  join public.publication_items item on item.id = variant.publication_item_id
  where variant.status = 'ready'
    and variant.execute_at <= resolved_now - make_interval(mins => p_grace_minutes)
    and (item.status in ('published', 'ignored', 'cancelled', 'removed')
      or (item.status = 'failed' and item.next_attempt_at is null))
  order by variant.execute_at, variant.publication_item_id
  limit p_limit;
end;
$$;

-- Chamada DEPOIS de o objeto sair do R2. Apagar no R2 e idempotente, entao uma
-- confirmacao perdida so repete o delete na passada seguinte.
create or replace function public.confirm_publication_video_variant_gc(
  p_item_ids uuid[]
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  resolved_now timestamptz := timezone('utc', now());
  confirmed integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode confirmar a coleta.';
  end if;
  if p_item_ids is null or cardinality(p_item_ids) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Lista de coleta inválida.';
  end if;

  update public.publication_item_video_variants variant
  set status = 'deleted', deleted_at = resolved_now, updated_at = resolved_now
  where variant.publication_item_id = any(p_item_ids) and variant.status = 'ready';
  get diagnostics confirmed = row_count;
  return jsonb_build_object('confirmed', confirmed);
end;
$$;

revoke all on function public.claim_publication_video_variants(text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_publication_video_variant(uuid, text, text, bigint, text, jsonb, integer) from public, anon, authenticated;
revoke all on function public.fail_publication_video_variant(uuid, text, text, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.resolve_publication_preparation_for_variant(uuid, text) from public, anon, authenticated;
revoke all on function public.requeue_publication_video_variant(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_publication_video_variant_gc(integer, integer) from public, anon, authenticated;
revoke all on function public.confirm_publication_video_variant_gc(uuid[]) from public, anon, authenticated;
grant execute on function public.claim_publication_video_variants(text, integer, integer, integer) to service_role;
grant execute on function public.complete_publication_video_variant(uuid, text, text, bigint, text, jsonb, integer) to service_role;
grant execute on function public.fail_publication_video_variant(uuid, text, text, text, integer, boolean) to service_role;
grant execute on function public.resolve_publication_preparation_for_variant(uuid, text) to service_role;
grant execute on function public.requeue_publication_video_variant(uuid, text) to service_role;
grant execute on function public.claim_publication_video_variant_gc(integer, integer) to service_role;
grant execute on function public.confirm_publication_video_variant_gc(uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Geracao: cria a linha da variante junto com o item
-- ---------------------------------------------------------------------------
-- Copia integral da 432 (conferida igual a producao em 20/09/2026, 13.762
-- caracteres) com duas mudancas, marcadas com 436: a variavel
-- `wants_video_variant` e o CTE `inserted_variants`.

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
-- 7. Criacao de plano com receita: wrappers finos sobre a v2
-- ---------------------------------------------------------------------------
-- A v2 continua sendo quem autoriza (has_organization_role), valida e cria. O
-- wrapper so grava a receita NA MESMA TRANSACAO -- antes do commit nenhum chunk
-- e visivel para o gerador, entao nenhum item nasce sem a linha da variante.
-- Repeticao do mesmo pedido (created = false) com receita diferente e recusada:
-- a receita nao entra no hash de idempotencia da v2.

create or replace function public.apply_bulk_plan_video_variant_recipe(
  p_result jsonb,
  p_format public.publication_format,
  p_video_variant_recipe text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  resolved_plan_id uuid := nullif(p_result ->> 'planId', '')::uuid;
  existing_recipe text;
begin
  if p_video_variant_recipe is not null and p_video_variant_recipe not in ('container', 'micro', 'light') then
    raise exception using errcode = '22023', message = 'Receita de variante de vídeo inválida.';
  end if;
  if p_video_variant_recipe is not null and p_format <> 'reel' then
    raise exception using errcode = '22023', message = 'Variante de vídeo só existe para Reels.';
  end if;
  if resolved_plan_id is null then
    raise exception using errcode = 'P0002', message = 'Plano em massa não foi criado.';
  end if;

  if coalesce((p_result ->> 'created')::boolean, false) then
    update public.bulk_publication_plans
    set video_variant_recipe = p_video_variant_recipe
    where id = resolved_plan_id;
  else
    select video_variant_recipe into existing_recipe
    from public.bulk_publication_plans where id = resolved_plan_id;
    if existing_recipe is distinct from p_video_variant_recipe then
      raise exception using errcode = '23505',
        message = 'Este pedido já foi criado com outra opção de variante de vídeo.';
    end if;
  end if;
  return p_result || jsonb_build_object('videoVariantRecipe', p_video_variant_recipe);
end;
$$;

revoke all on function public.apply_bulk_plan_video_variant_recipe(jsonb, public.publication_format, text) from public, anon, authenticated;

create or replace function public.create_bulk_rotation_plan_v3(
  p_organization_id uuid, p_request_key text, p_name text, p_profile_ids uuid[],
  p_origin_type text, p_origin_group_id uuid, p_format public.publication_format,
  p_interval_minutes integer, p_duration_days bigint, p_caption text, p_order_mode text,
  p_rotation_seed text, p_reel_cover_media_asset_id uuid, p_reel_cover_origin_type text,
  p_reel_cover_origin_group_id uuid, p_video_variant_recipe text,
  p_algorithm_version smallint default 2, p_chunk_size integer default 500,
  p_now timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return public.apply_bulk_plan_video_variant_recipe(
    public.create_bulk_rotation_plan_v2(
      p_organization_id, p_request_key, p_name, p_profile_ids, p_origin_type, p_origin_group_id,
      p_format, p_interval_minutes, p_duration_days, p_caption, p_order_mode, p_rotation_seed,
      p_reel_cover_media_asset_id, p_reel_cover_origin_type, p_reel_cover_origin_group_id,
      p_algorithm_version, p_chunk_size, p_now),
    p_format, p_video_variant_recipe);
end;
$$;

create or replace function public.create_bulk_daily_rotation_plan_v3(
  p_organization_id uuid, p_request_key text, p_name text, p_profile_ids uuid[],
  p_origin_type text, p_origin_group_id uuid, p_format public.publication_format,
  p_repeat_days bigint, p_daily_time time, p_caption text, p_order_mode text,
  p_rotation_seed text, p_reel_cover_media_asset_id uuid, p_reel_cover_origin_type text,
  p_reel_cover_origin_group_id uuid, p_video_variant_recipe text,
  p_algorithm_version smallint default 2, p_chunk_size integer default 500,
  p_now timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return public.apply_bulk_plan_video_variant_recipe(
    public.create_bulk_daily_rotation_plan_v2(
      p_organization_id, p_request_key, p_name, p_profile_ids, p_origin_type, p_origin_group_id,
      p_format, p_repeat_days, p_daily_time, p_caption, p_order_mode, p_rotation_seed,
      p_reel_cover_media_asset_id, p_reel_cover_origin_type, p_reel_cover_origin_group_id,
      p_algorithm_version, p_chunk_size, p_now),
    p_format, p_video_variant_recipe);
end;
$$;

create or replace function public.create_bulk_sequential_rotation_plan_v3(
  p_organization_id uuid, p_request_key text, p_name text, p_profile_ids uuid[],
  p_origin_type text, p_origin_group_id uuid, p_format public.publication_format,
  p_interval_minutes integer, p_post_count bigint, p_start_at timestamptz, p_caption text,
  p_order_mode text, p_rotation_seed text, p_reel_cover_media_asset_id uuid,
  p_reel_cover_origin_type text, p_reel_cover_origin_group_id uuid, p_video_variant_recipe text,
  p_algorithm_version smallint default 2, p_chunk_size integer default 500,
  p_now timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return public.apply_bulk_plan_video_variant_recipe(
    public.create_bulk_sequential_rotation_plan_v2(
      p_organization_id, p_request_key, p_name, p_profile_ids, p_origin_type, p_origin_group_id,
      p_format, p_interval_minutes, p_post_count, p_start_at, p_caption, p_order_mode, p_rotation_seed,
      p_reel_cover_media_asset_id, p_reel_cover_origin_type, p_reel_cover_origin_group_id,
      p_algorithm_version, p_chunk_size, p_now),
    p_format, p_video_variant_recipe);
end;
$$;

-- Licao da 433: funcao nova nasce com execute para PUBLIC; sem o grant explicito
-- para authenticated o painel recebe 42501 e o service_role esconde a falha.
revoke all on function public.create_bulk_rotation_plan_v3(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, text, text, text, uuid, text, uuid, text, smallint, integer, timestamptz) from public, anon;
revoke all on function public.create_bulk_daily_rotation_plan_v3(uuid, text, text, uuid[], text, uuid, public.publication_format, bigint, time, text, text, text, uuid, text, uuid, text, smallint, integer, timestamptz) from public, anon;
revoke all on function public.create_bulk_sequential_rotation_plan_v3(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, timestamptz, text, text, text, uuid, text, uuid, text, smallint, integer, timestamptz) from public, anon;
grant execute on function public.create_bulk_rotation_plan_v3(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, text, text, text, uuid, text, uuid, text, smallint, integer, timestamptz) to authenticated, service_role;
grant execute on function public.create_bulk_daily_rotation_plan_v3(uuid, text, text, uuid[], text, uuid, public.publication_format, bigint, time, text, text, text, uuid, text, uuid, text, smallint, integer, timestamptz) to authenticated, service_role;
grant execute on function public.create_bulk_sequential_rotation_plan_v3(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, timestamptz, text, text, text, uuid, text, uuid, text, smallint, integer, timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
