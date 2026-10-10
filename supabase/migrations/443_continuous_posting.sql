-- 443 — Postagem continua por grupo ("chave liga/desliga").
--
-- POR QUE EXISTE. Hoje cada post de plano em massa vira uma linha em
-- publication_items com ate 7 dias de antecedencia: centenas de milhares de linhas
-- futuras que o claim varre, que a queda de um perfil reescreve e que chegam em
-- ondas (mais de 600 posts em 5 minutos). Aqui o grupo guarda UMA REGRA por formato
-- e cada perfil guarda QUANDO E O PROXIMO POST. A linha do post so nasce na hora de
-- postar, ja reivindicada pelo publicador, e dali em diante e um item comum:
-- reserva de capacidade, sonda do R2, conteiner, confirmacao e retry de sempre.
-- Plano e contrato: plans/plano-postagem-continua.md e
-- plans/plano-postagem-continua-contrato.md.
--
-- DECISOES DO DONO (06/10 e 09/10/2026):
--   * So a quantidade por dia e configuravel (padrao 24 para Reel; Story com faixa
--     de horas e padrao 1). Nao existe "programar a frente".
--   * A origem das midias e um grupo (pode ser outro grupo, usado como pasta); o
--     ciclo sempre repete, com o sorteio de hoje (same_order / diversified).
--   * Post perdido por falha nossa PULA, nao recupera, e deixa aviso com detalhe.
--   * Erro 9 da Meta: o perfil descansa algumas horas (padrao 4) e volta sozinho.
--   * Ligar e recusado se o grupo ainda tem fila aberta do mesmo formato.
--   * So perfil `meta_official` online posta por regra continua.
--
-- DESENHO, E O QUE ELE EVITA DE PROPOSITO:
--   * NADA EXISTENTE MUDA. Nenhuma coluna, gatilho, indice ou funcao existente e
--     alterada ou reemitida; claim_publication_items fica intocada. Tudo aqui e
--     objeto novo.
--   * TABELA LATERAL (continuous_posting_items), nao coluna em publication_items:
--     a tabela quente tem espelho no arquivo frio com guarda de paridade (333). A
--     lateral some em cascata com o item, como a da 436.
--   * O ITEM NASCE `preparing` COM A PREPARACAO `ready`, e a midia e ligada depois,
--     na mesma transacao. O gatilho da 264 (publication_item_media) so devolve a
--     preparacao a `pending` em item `waiting`/`ready`; se o item nascesse `waiting`,
--     o retry (que o claim comum so aceita com preparacao `ready`) ficaria esperando
--     o laco de preparacao. Por isso esta funcao faz as validacoes locais da
--     preparacao (perfil online, midia pronta, formato).
--   * CRIAR O ITEM E AVANCAR O RELOGIO SAO A MESMA TRANSACAO, com a linha do estado
--     travada (`for update skip locked`) e a chave de idempotencia
--     `continuous:<regra>:<perfil>:<epoch do horario>`: um perfil nunca posta em dobro.
--   * UM LOTE POR REGRA POR DIA (BRT): todo item exige lote, e o lote exige um
--     usuario (quem ligou a chave). Sem linha em bulk_publication_plans o item nao e
--     tratado como sequencial e os intervalos minimos de sempre valem.
--   * A GRADE E FIXA: o horario seguinte sai do horario anterior, nao de quando o
--     post terminou. O inicio do envio fica sempre a um intervalo do anterior.
--   * O OBJETO NO STORAGE SO E CONFERIDO NA MIDIA ESCOLHIDA, nao na lista inteira
--     (a lista da 085 confere uma a uma). Midia sem objeto e pulada para a seguinte
--     do ciclo e fica registrada no metadata do evento.
--
-- Aditiva. Sem regra ligada, claim_continuous_posting_items faz uma leitura de
-- indice vazia e devolve nada; o publicador so a chama com
-- PUBLICATION_WORKER_CONTINUOUS_POSTING ligado.

-- As FKs novas (publication_items, publication_batches, instagram_profiles,
-- profile_groups) pedem trava forte por instantes; se houver transacao longa na
-- frente, desiste em vez de enfileirar a fila inteira atras.
set lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 1. Tabelas
-- ---------------------------------------------------------------------------

create table if not exists public.continuous_posting_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  group_id uuid not null references public.profile_groups(id) on delete cascade,
  format public.publication_format not null,
  enabled boolean not null default false,
  enabled_at timestamptz,
  -- Quem ligou a chave: e o `created_by` dos lotes do dia.
  enabled_by uuid,
  disabled_at timestamptz,
  -- So 'group' hoje. 'folder' entra quando existirem pastas de verdade; a logica
  -- de postagem nao muda, so de onde a lista de midias e lida.
  source_type text not null default 'group',
  source_group_id uuid not null references public.profile_groups(id) on delete cascade,
  rotation_mode text not null default 'diversified',
  posts_per_day integer not null,
  -- Minutos do dia em America/Sao_Paulo. So story; reel = null = dia inteiro.
  window_start_minute integer,
  window_end_minute integer,
  caption text,
  -- Nunca muda depois de criada: dela saem a fase de cada perfil na grade e o
  -- deslocamento/passo da rotacao. Trocar a semente embaralharia os horarios.
  rotation_seed text not null default gen_random_uuid()::text,
  rest_hours integer not null default 4,
  paused_at timestamptz,
  pause_reason text,
  last_synced_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint continuous_posting_rules_group_format_key unique (group_id, format),
  constraint continuous_posting_rules_format_check check (format in ('reel', 'story')),
  constraint continuous_posting_rules_source_type_check check (source_type in ('group')),
  constraint continuous_posting_rules_rotation_mode_check
    check (rotation_mode in ('same_order', 'diversified')),
  -- Reel ate 57: 86.400 / 57 = 1.515 s, acima do intervalo minimo de reel (1.500 s).
  -- Story ate 100: o limite da Meta e de 100 posts por 24 h moveis.
  constraint continuous_posting_rules_posts_per_day_check check (
    (format = 'reel' and posts_per_day between 1 and 57)
    or (format = 'story' and posts_per_day between 1 and 100)
  ),
  constraint continuous_posting_rules_window_check check (
    (format = 'reel' and window_start_minute is null and window_end_minute is null)
    or (
      format = 'story'
      and window_start_minute is not null and window_end_minute is not null
      and window_start_minute >= 0 and window_end_minute <= 1440
      and window_start_minute < window_end_minute
      -- Pelo menos um minuto por post, para a fatia nunca ser zero.
      and window_end_minute - window_start_minute >= posts_per_day
    )
  ),
  constraint continuous_posting_rules_caption_check
    check (caption is null or char_length(caption) <= 2200),
  constraint continuous_posting_rules_rest_hours_check check (rest_hours between 1 and 48),
  constraint continuous_posting_rules_pause_reason_check
    check (pause_reason is null or char_length(pause_reason) <= 500)
);

comment on table public.continuous_posting_rules is
  '443: regra de postagem continua, uma por (grupo, formato). Escrita so pelas RPCs upsert_continuous_posting_rule / set_continuous_posting_rule_enabled. paused_at e a pausa automatica (disjuntor do lote do dia); religar a chave zera.';

create index if not exists continuous_posting_rules_org_idx
  on public.continuous_posting_rules (organization_id);
create index if not exists continuous_posting_rules_source_group_idx
  on public.continuous_posting_rules (source_group_id);

create table if not exists public.continuous_posting_profile_states (
  rule_id uuid not null references public.continuous_posting_rules(id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles(id) on delete cascade,
  organization_id uuid not null,
  -- Ordem de entrada do perfil na regra; alimenta o deslocamento da rotacao.
  profile_ordinal bigint not null,
  cycle_position bigint not null default 0,
  -- 'infinity' = perfil estacionado (saiu do grupo, caiu ou nao e meta_official).
  -- A sincronizacao devolve o horario quando ele volta a ser elegivel, e a posicao
  -- do ciclo e preservada.
  next_post_at timestamptz not null,
  resting_until timestamptz,
  last_item_id uuid,
  last_post_at timestamptz,
  -- Ultimo erro inesperado ao criar o item (o horario nao avanca; o claim tenta de
  -- novo ate passar da tolerancia e o aviso de post pulado carrega este erro).
  last_error_code text,
  last_error_message text,
  last_error_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (rule_id, profile_id),
  constraint continuous_posting_profile_states_cycle_check check (cycle_position >= 0)
);

comment on table public.continuous_posting_profile_states is
  '443: relogio de cada perfil numa regra continua: posicao no ciclo de midias e quando e o proximo post. O claim trava a linha (for update skip locked), cria o item e avanca na mesma transacao.';

-- O claim le por aqui: o que venceu, do mais antigo para o mais novo.
create index if not exists continuous_posting_profile_states_next_post_idx
  on public.continuous_posting_profile_states (next_post_at, profile_id);
create index if not exists continuous_posting_profile_states_profile_idx
  on public.continuous_posting_profile_states (profile_id);

-- Uma atualizacao por post em cada linha, e o indice de next_post_at impede HOT:
-- o autovacuum padrao (20% de tuplas mortas) deixaria o indice inchado. Mesmos
-- numeros da 417 e da 436.
alter table public.continuous_posting_profile_states set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02
);

create table if not exists public.continuous_posting_batches (
  rule_id uuid not null references public.continuous_posting_rules(id) on delete cascade,
  -- Dia em America/Sao_Paulo.
  day date not null,
  organization_id uuid not null,
  batch_id uuid not null references public.publication_batches(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (rule_id, day)
);

comment on table public.continuous_posting_batches is
  '443: lote do dia de cada regra continua (todo item exige lote). Religar a regra apaga a linha de um lote com disjuntor pausado, e o proximo post cria um lote novo.';

create index if not exists continuous_posting_batches_batch_idx
  on public.continuous_posting_batches (batch_id);

create table if not exists public.continuous_posting_items (
  -- PK = FK: no maximo uma linha por item, e ela some em cascata com o item
  -- (arquivo frio, 333). Estado operacional que nao sobrevive ao item.
  publication_item_id uuid primary key
    references public.publication_items(id) on delete cascade,
  organization_id uuid not null,
  rule_id uuid not null references public.continuous_posting_rules(id) on delete cascade,
  profile_id uuid not null,
  slot_at timestamptz not null,
  media_asset_id uuid,
  notice_cleared_at timestamptz,
  notice_cleared_by uuid,
  created_at timestamptz not null default timezone('utc', now())
);

comment on table public.continuous_posting_items is
  '443: liga o item a regra continua que o criou, sem coluna nova em publication_items. Os avisos de post que falhou, venceu ou foi cancelado saem daqui (notice_cleared_at tira da tela).';

create index if not exists continuous_posting_items_rule_slot_idx
  on public.continuous_posting_items (rule_id, slot_at desc);
create index if not exists continuous_posting_items_open_notice_idx
  on public.continuous_posting_items (organization_id, slot_at desc)
  where notice_cleared_at is null;

-- So cresce por insert (um por post): mesmo ajuste da 436.
alter table public.continuous_posting_items set (
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_vacuum_insert_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02
);

create table if not exists public.continuous_posting_notices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  rule_id uuid not null references public.continuous_posting_rules(id) on delete cascade,
  group_id uuid,
  -- Nulo em aviso da regra (rule_paused).
  profile_id uuid,
  format public.publication_format not null,
  kind text not null,
  slot_at timestamptz,
  delay_seconds integer,
  skipped_count integer not null default 1,
  resting_until timestamptz,
  error_code text,
  error_message text,
  -- Snapshots: o perfil pode ser apagado e o grupo renomeado depois do aviso.
  username_snapshot text,
  group_name_snapshot text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  cleared_at timestamptz,
  cleared_by uuid,
  constraint continuous_posting_notices_kind_check check (kind in (
    'skipped_late', 'skipped_no_media', 'skipped_slot_conflict', 'profile_rest', 'rule_paused'
  )),
  constraint continuous_posting_notices_skipped_count_check check (skipped_count >= 0),
  constraint continuous_posting_notices_metadata_check check (jsonb_typeof(metadata) = 'object')
);

comment on table public.continuous_posting_notices is
  '443: avisos da postagem continua que nao tem item: post pulado por atraso, origem sem midia, vaga ocupada, perfil em descanso (erro 9) e regra pausada. Limpar so tira da tela.';

create index if not exists continuous_posting_notices_open_org_idx
  on public.continuous_posting_notices (organization_id, created_at desc)
  where cleared_at is null;
create index if not exists continuous_posting_notices_rule_profile_idx
  on public.continuous_posting_notices (rule_id, profile_id, kind, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. RLS e grants: leitura para membro; escrita so por RPC `security definer`
-- ---------------------------------------------------------------------------

alter table public.continuous_posting_rules enable row level security;
alter table public.continuous_posting_profile_states enable row level security;
alter table public.continuous_posting_batches enable row level security;
alter table public.continuous_posting_items enable row level security;
alter table public.continuous_posting_notices enable row level security;

drop policy if exists continuous_posting_rules_select_member on public.continuous_posting_rules;
create policy continuous_posting_rules_select_member
  on public.continuous_posting_rules for select to authenticated
  using (public.is_organization_member(organization_id));

drop policy if exists continuous_posting_profile_states_select_member on public.continuous_posting_profile_states;
create policy continuous_posting_profile_states_select_member
  on public.continuous_posting_profile_states for select to authenticated
  using (public.is_organization_member(organization_id));

drop policy if exists continuous_posting_batches_select_member on public.continuous_posting_batches;
create policy continuous_posting_batches_select_member
  on public.continuous_posting_batches for select to authenticated
  using (public.is_organization_member(organization_id));

drop policy if exists continuous_posting_items_select_member on public.continuous_posting_items;
create policy continuous_posting_items_select_member
  on public.continuous_posting_items for select to authenticated
  using (public.is_organization_member(organization_id));

drop policy if exists continuous_posting_notices_select_member on public.continuous_posting_notices;
create policy continuous_posting_notices_select_member
  on public.continuous_posting_notices for select to authenticated
  using (public.is_organization_member(organization_id));

revoke all on public.continuous_posting_rules from public, anon, authenticated;
revoke all on public.continuous_posting_profile_states from public, anon, authenticated;
revoke all on public.continuous_posting_batches from public, anon, authenticated;
revoke all on public.continuous_posting_items from public, anon, authenticated;
revoke all on public.continuous_posting_notices from public, anon, authenticated;

grant select on public.continuous_posting_rules to authenticated;
grant select on public.continuous_posting_profile_states to authenticated;
grant select on public.continuous_posting_batches to authenticated;
grant select on public.continuous_posting_items to authenticated;
grant select on public.continuous_posting_notices to authenticated;

grant all on public.continuous_posting_rules to service_role;
grant all on public.continuous_posting_profile_states to service_role;
grant all on public.continuous_posting_batches to service_role;
grant all on public.continuous_posting_items to service_role;
grant all on public.continuous_posting_notices to service_role;

-- ---------------------------------------------------------------------------
-- 3. A grade de horarios
-- ---------------------------------------------------------------------------

-- Primeiro horario ESTRITAMENTE depois de p_after, para uma regra e um perfil.
--
--   Reel (dia inteiro): faixa = 86.400 s, base = 00:00 BRT. A fase do perfil e fixa
--     (hash da semente + perfil), entao a grade e a mesma todos os dias e o
--     intervalo entre inicios nao muda na virada do dia.
--   Story (janela): faixa = a janela; a fase e sorteada de novo a cada dia (o dia
--     entra no hash), entao o horario muda de um dia para o outro.
--
-- Horario k do dia = base + fase + floor(k * faixa / posts_por_dia), com a fase em
-- [0, floor(faixa / posts_por_dia)). Tudo em segundo inteiro: quando a faixa nao e
-- divisivel pela quantidade (ex.: 7 por dia = 12.342,86 s) os intervalos alternam
-- entre o piso e o teto (12.342 e 12.343 s) e os 7 somam 86.400 s exatos, sem
-- acumular desvio.
create or replace function public.continuous_posting_next_slot(
  p_format public.publication_format,
  p_posts_per_day integer,
  p_window_start_minute integer,
  p_window_end_minute integer,
  p_rotation_seed text,
  p_profile_id uuid,
  p_after timestamptz
) returns timestamptz
language sql
stable
parallel safe
set search_path = public
as $$
  with cfg as (
    select
      (case when p_format = 'story' then p_window_start_minute * 60 else 0 end)::bigint as base_seconds,
      (case when p_format = 'story' then (p_window_end_minute - p_window_start_minute) * 60 else 86400 end)::bigint as span_seconds,
      (p_after at time zone 'America/Sao_Paulo')::date as local_day
  ), days as (
    -- O dia de p_after e os dois seguintes: o proximo horario esta sempre neles.
    select cfg.local_day + day_offset.value as day, cfg.base_seconds, cfg.span_seconds,
      mod(
        hashtextextended(
          p_rotation_seed || ':phase:' || p_profile_id::text
            || case when p_format = 'story'
                 then ':' || to_char(cfg.local_day + day_offset.value, 'YYYY-MM-DD')
                 else '' end,
          0
        )::numeric + 9223372036854775808::numeric,
        greatest(cfg.span_seconds / p_posts_per_day, 1)::numeric
      )::bigint as phase_seconds
    from cfg
    cross join generate_series(0, 2) as day_offset(value)
  )
  select min(slot.slot_at)
  from days
  cross join generate_series(0, p_posts_per_day - 1) as slot_index(value)
  cross join lateral (
    select (
      days.day::timestamp + make_interval(secs => (
        days.base_seconds + days.phase_seconds
          + (slot_index.value::bigint * days.span_seconds) / p_posts_per_day
      )::double precision)
    ) at time zone 'America/Sao_Paulo' as slot_at
  ) slot
  where slot.slot_at > p_after;
$$;

-- Percorre a grade a partir de um horario dela (p_from) e devolve quantos horarios
-- caem ate p_until (contando p_from) e o primeiro horario depois de p_until. Usada
-- para dizer "quantos posts ficaram de fora" num atraso ou num descanso.
create or replace function public.continuous_posting_walk_slots(
  p_format public.publication_format,
  p_posts_per_day integer,
  p_window_start_minute integer,
  p_window_end_minute integer,
  p_rotation_seed text,
  p_profile_id uuid,
  p_from timestamptz,
  p_until timestamptz,
  out next_slot_at timestamptz,
  out skipped_slots integer
)
language plpgsql
stable
set search_path = public
as $$
declare
  -- 20 dias a 100 por dia. Acima disso so interessa onde a grade recomeca.
  max_steps constant integer := 2000;
begin
  next_slot_at := p_from;
  skipped_slots := 0;
  while next_slot_at <= p_until and skipped_slots < max_steps loop
    skipped_slots := skipped_slots + 1;
    next_slot_at := public.continuous_posting_next_slot(
      p_format, p_posts_per_day, p_window_start_minute, p_window_end_minute,
      p_rotation_seed, p_profile_id, next_slot_at);
  end loop;
  if next_slot_at <= p_until then
    next_slot_at := public.continuous_posting_next_slot(
      p_format, p_posts_per_day, p_window_start_minute, p_window_end_minute,
      p_rotation_seed, p_profile_id, p_until);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Midias da origem e sincronizacao dos perfis (internas)
-- ---------------------------------------------------------------------------

-- A regra de elegibilidade da 085 (list_bulk_rotation_media_ids): pronta, nao
-- apagada, sem exclusao pedida, reel = video, story = qualquer tipo, na ordem
-- (created_at, id). p_check_storage = true confere o objeto no storage midia a
-- midia, como a 085; o claim passa false e confere so a midia escolhida.
create or replace function public.continuous_posting_media_ids(
  p_organization_id uuid,
  p_source_group_id uuid,
  p_format public.publication_format,
  p_check_storage boolean
) returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(asset.id order by asset.created_at, asset.id), '{}'::uuid[])
  from public.media_group_assignments assignment
  join public.media_assets asset on asset.id = assignment.media_asset_id
  where assignment.organization_id = p_organization_id
    and assignment.group_id = p_source_group_id
    and asset.organization_id = p_organization_id
    and asset.deleted_at is null
    and asset.deletion_requested_at is null
    and asset.status = 'ready'
    and (p_format = 'story' or (p_format = 'reel' and asset.kind = 'video'))
    and (not p_check_storage or public.media_asset_has_storage_object(asset.storage_path));
$$;

-- Deixa os estados da regra de acordo com o grupo:
--   * perfil que deixou de ser elegivel (saiu do grupo, caiu, apagado, nao e
--     meta_official) e estacionado em 'infinity', guardando a posicao do ciclo;
--   * perfil elegivel estacionado (ou todos, com p_recalculate) recebe o proximo
--     horario depois de agora, ou depois do descanso se ainda estiver descansando;
--   * perfil novo no grupo ganha estado e comeca no proximo horario dele.
-- Devolve quantos perfis elegiveis ficaram com estado.
create or replace function public.continuous_posting_sync_rule_states(
  p_rule_id uuid,
  p_recalculate boolean default false
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  now_ts timestamptz := now();
  rule_row public.continuous_posting_rules%rowtype;
  ordinal_base bigint;
  eligible_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' and auth.uid() is null then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  -- Trava a regra: duas sincronizacoes da mesma regra entram em fila aqui.
  select rule.* into rule_row
  from public.continuous_posting_rules rule
  where rule.id = p_rule_id
  for update;
  if not found then
    return 0;
  end if;

  update public.continuous_posting_profile_states state
  set next_post_at = 'infinity', updated_at = now_ts
  where state.rule_id = rule_row.id
    and state.next_post_at < 'infinity'::timestamptz
    and not exists (
      select 1
      from public.profile_group_members member
      join public.instagram_profiles profile on profile.id = member.profile_id
      where member.group_id = rule_row.group_id
        and member.profile_id = state.profile_id
        and profile.organization_id = rule_row.organization_id
        and profile.deleted_at is null
        and profile.status = 'online'
        and profile.provider = 'meta_official'
    );

  update public.continuous_posting_profile_states state
  set next_post_at = public.continuous_posting_next_slot(
        rule_row.format, rule_row.posts_per_day, rule_row.window_start_minute,
        rule_row.window_end_minute, rule_row.rotation_seed, state.profile_id,
        greatest(now_ts, coalesce(state.resting_until, now_ts))),
      resting_until = case when state.resting_until > now_ts then state.resting_until else null end,
      last_error_code = null, last_error_message = null, last_error_at = null,
      updated_at = now_ts
  where state.rule_id = rule_row.id
    and (p_recalculate or state.next_post_at = 'infinity'::timestamptz)
    and exists (
      select 1
      from public.profile_group_members member
      join public.instagram_profiles profile on profile.id = member.profile_id
      where member.group_id = rule_row.group_id
        and member.profile_id = state.profile_id
        and profile.organization_id = rule_row.organization_id
        and profile.deleted_at is null
        and profile.status = 'online'
        and profile.provider = 'meta_official'
    );

  select coalesce(max(state.profile_ordinal) + 1, 0) into ordinal_base
  from public.continuous_posting_profile_states state
  where state.rule_id = rule_row.id;

  insert into public.continuous_posting_profile_states (
    rule_id, profile_id, organization_id, profile_ordinal, next_post_at
  )
  select rule_row.id, profile.id, rule_row.organization_id,
    ordinal_base + row_number() over (order by profile.id) - 1,
    public.continuous_posting_next_slot(
      rule_row.format, rule_row.posts_per_day, rule_row.window_start_minute,
      rule_row.window_end_minute, rule_row.rotation_seed, profile.id, now_ts)
  from public.profile_group_members member
  join public.instagram_profiles profile on profile.id = member.profile_id
  where member.group_id = rule_row.group_id
    and profile.organization_id = rule_row.organization_id
    and profile.deleted_at is null
    and profile.status = 'online'
    and profile.provider = 'meta_official'
    and not exists (
      select 1 from public.continuous_posting_profile_states existing
      where existing.rule_id = rule_row.id and existing.profile_id = profile.id
    )
  on conflict (rule_id, profile_id) do nothing;

  update public.continuous_posting_rules rule
  set last_synced_at = now_ts
  where rule.id = rule_row.id;

  select count(*)::integer into eligible_count
  from public.continuous_posting_profile_states state
  where state.rule_id = rule_row.id
    and state.next_post_at < 'infinity'::timestamptz;
  return eligible_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. A hora do post
-- ---------------------------------------------------------------------------

-- O trabalho inteiro do claim; devolve os ids dos itens criados. Separada da
-- funcao publica porque a `returns table` de la cria variaveis com os nomes das
-- colunas de publication_items (id, organization_id, status...), e aqui ha insert,
-- `on conflict` e `returning` nessas colunas.
create or replace function public.continuous_posting_claim_due(
  p_worker_id text,
  p_limit integer,
  p_lease_seconds integer
) returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Quantas midias seguidas sem objeto no storage o claim pula antes de desistir
  -- do horario. Mais que isso e a origem com defeito, nao uma midia.
  max_media_skips constant integer := 5;
  now_ts timestamptz := now();
  resolved_worker text := trim(coalesce(p_worker_id, ''));
  created_ids uuid[] := '{}'::uuid[];
  paused_rule_ids uuid[] := '{}'::uuid[];
  media_cache jsonb := '{}'::jsonb;
  general_lateness integer;
  lateness_by_format jsonb;
  format_lateness integer;
  tolerance_seconds integer;
  sync_rule record;
  candidate record;
  walked record;
  block_row record;
  slot_at_ts timestamptz;
  next_at timestamptz;
  delay_seconds_value integer;
  rest_until timestamptz;
  media_ids uuid[];
  media_count bigint;
  rotation_offset bigint;
  rotation_step bigint;
  cycle_cursor bigint;
  media_index bigint;
  candidate_media_id uuid;
  chosen_media_id uuid;
  media_storage_path text;
  skipped_media jsonb;
  slot_day date;
  day_batch_id uuid;
  item_key text;
  new_item_id uuid;
  conflict_code text;
  rule_was_paused boolean;
  error_state text;
  error_text text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode reivindicar postagem contínua.';
  end if;
  if char_length(resolved_worker) not between 3 and 120
    or p_limit is null or p_limit not between 1 and 100
    or p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Parâmetros de claim inválidos.';
  end if;

  -- No maximo uma vez por minuto por regra: perfil que entrou no grupo ganha
  -- estado, perfil que saiu ou caiu e estacionado. `skip locked` para que dois
  -- publicadores nao esperem um pelo outro.
  for sync_rule in
    select rule.id
    from public.continuous_posting_rules rule
    where rule.enabled
      and rule.paused_at is null
      and (rule.last_synced_at is null or rule.last_synced_at <= now_ts - interval '1 minute')
    order by rule.id
    for update of rule skip locked
  loop
    perform public.continuous_posting_sync_rule_states(sync_rule.id, false);
  end loop;

  -- A mesma tolerancia de atraso do claim comum (405 e 426): o menor valor entre
  -- as linhas habilitadas; o formato com janela propria (hoje so story) usa a dele.
  select min(settings.max_publication_lateness_seconds) into general_lateness
  from public.publication_rate_limit_settings settings
  where settings.enabled
    and settings.max_publication_lateness_seconds is not null;

  select coalesce(jsonb_object_agg(fmt.key, fmt.min_value), '{}'::jsonb) into lateness_by_format
  from (
    select kv.key, min((kv.value)::integer) as min_value
    from public.publication_rate_limit_settings settings,
         jsonb_each_text(coalesce(settings.max_publication_lateness_seconds_by_format, '{}'::jsonb)) kv
    where settings.enabled
    group by kv.key
  ) fmt;

  for candidate in
    select state.rule_id, state.profile_id, state.profile_ordinal, state.cycle_position,
      state.next_post_at, state.last_error_code, state.last_error_message,
      rule.organization_id, rule.group_id, rule.format, rule.source_group_id,
      rule.rotation_mode, rule.posts_per_day, rule.window_start_minute,
      rule.window_end_minute, rule.caption, rule.rotation_seed, rule.rest_hours,
      coalesce(rule.enabled_by, rule.updated_by, rule.created_by) as actor_id,
      grp.name as group_name, profile.username
    from public.continuous_posting_profile_states state
    join public.continuous_posting_rules rule on rule.id = state.rule_id
    join public.profile_groups grp on grp.id = rule.group_id
    join public.instagram_profiles profile on profile.id = state.profile_id
    where state.next_post_at <= now_ts
      and (state.resting_until is null or state.resting_until <= now_ts)
      and rule.enabled
      and rule.paused_at is null
      and grp.deleted_at is null
      and exists (
        select 1 from public.profile_group_members member
        where member.group_id = rule.group_id and member.profile_id = state.profile_id
      )
      -- As validacoes locais da preparacao, que este item nao percorre.
      and profile.organization_id = rule.organization_id
      and profile.deleted_at is null
      and profile.status = 'online'
      and profile.provider = 'meta_official'
      and profile.instagram_user_id is not null
      -- O mesmo filtro de app bloqueado do claim comum (394).
      and not exists (
        select 1 from public.meta_apps app
        where app.id = profile.meta_app_id
          and app.api_block_until is not null
          and app.api_block_until > now_ts
      )
    order by state.next_post_at, state.profile_id
    limit p_limit
    -- A linha travada e reconferida na versao atual: se outro publicador avancou o
    -- relogio entre a leitura e a trava, `next_post_at <= now` deixa de valer e a
    -- linha sai. A chave de idempotencia do item e a segunda barreira.
    for update of state skip locked
  loop
    if candidate.rule_id = any(paused_rule_ids) then
      continue;
    end if;

    -- Um bloco por perfil: um erro aqui pula so este perfil.
    begin
      slot_at_ts := candidate.next_post_at;

      -- 2. Descanso do erro 9. A 438 ja cancelou o item que recebeu o `9` e gravou a
      -- linha; aqui o perfil so para de receber reel ate o descanso acabar.
      if candidate.format = 'reel' then
        select block.last_detected_at, block.error_code, block.error_message into block_row
        from public.meta_profile_action_blocks block
        where block.profile_id = candidate.profile_id
          and block.last_detected_at > now_ts - make_interval(hours => candidate.rest_hours)
        order by block.last_detected_at desc
        limit 1;

        if found then
          rest_until := block_row.last_detected_at + make_interval(hours => candidate.rest_hours);
          select * into walked from public.continuous_posting_walk_slots(
            candidate.format, candidate.posts_per_day, candidate.window_start_minute,
            candidate.window_end_minute, candidate.rotation_seed, candidate.profile_id,
            slot_at_ts, rest_until);

          update public.continuous_posting_profile_states state
          set resting_until = rest_until, next_post_at = walked.next_slot_at,
              last_error_code = null, last_error_message = null, last_error_at = null,
              updated_at = now_ts
          where state.rule_id = candidate.rule_id and state.profile_id = candidate.profile_id;

          -- Um aviso por descanso: se o mesmo descanso for visto de novo, soma.
          update public.continuous_posting_notices notice
          set skipped_count = greatest(notice.skipped_count, walked.skipped_slots)
          where notice.rule_id = candidate.rule_id
            and notice.profile_id = candidate.profile_id
            and notice.kind = 'profile_rest'
            and notice.resting_until = rest_until;
          if not found then
            insert into public.continuous_posting_notices (
              organization_id, rule_id, group_id, profile_id, format, kind, slot_at,
              skipped_count, resting_until, error_code, error_message,
              username_snapshot, group_name_snapshot, metadata
            ) values (
              candidate.organization_id, candidate.rule_id, candidate.group_id,
              candidate.profile_id, candidate.format, 'profile_rest', slot_at_ts,
              walked.skipped_slots, rest_until,
              left(coalesce(nullif(trim(block_row.error_code), ''), '9'), 120),
              left(coalesce(nullif(trim(block_row.error_message), ''),
                'Meta limitou as ações da conta; perfil em descanso.'), 1200),
              candidate.username, candidate.group_name,
              jsonb_build_object('last_detected_at', block_row.last_detected_at,
                'rest_hours', candidate.rest_hours, 'worker_id', resolved_worker)
            );
          end if;
          continue;
        end if;
      end if;

      -- 3. Atraso: passou da tolerancia sem o post comecar (publicador parado,
      -- banco fora). Pula, avisa e segue para o proximo horario.
      format_lateness := nullif(lateness_by_format ->> candidate.format::text, '')::integer;
      tolerance_seconds := case
        when general_lateness is null then null
        when format_lateness is null then general_lateness
        else greatest(general_lateness, format_lateness)
      end;
      delay_seconds_value := floor(extract(epoch from now_ts - slot_at_ts))::integer;

      if tolerance_seconds is not null and delay_seconds_value > tolerance_seconds then
        select * into walked from public.continuous_posting_walk_slots(
          candidate.format, candidate.posts_per_day, candidate.window_start_minute,
          candidate.window_end_minute, candidate.rotation_seed, candidate.profile_id,
          slot_at_ts, now_ts);

        update public.continuous_posting_profile_states state
        set next_post_at = walked.next_slot_at,
            last_error_code = null, last_error_message = null, last_error_at = null,
            updated_at = now_ts
        where state.rule_id = candidate.rule_id and state.profile_id = candidate.profile_id;

        insert into public.continuous_posting_notices (
          organization_id, rule_id, group_id, profile_id, format, kind, slot_at,
          delay_seconds, skipped_count, error_code, error_message,
          username_snapshot, group_name_snapshot, metadata
        ) values (
          candidate.organization_id, candidate.rule_id, candidate.group_id,
          candidate.profile_id, candidate.format, 'skipped_late', slot_at_ts,
          delay_seconds_value, walked.skipped_slots,
          -- Se o horario ficou para tras por um erro ao criar o item, o aviso diz qual.
          left(candidate.last_error_code, 120), left(candidate.last_error_message, 1200),
          candidate.username, candidate.group_name,
          jsonb_build_object('tolerance_seconds', tolerance_seconds,
            'next_post_at', walked.next_slot_at, 'worker_id', resolved_worker)
        );
        continue;
      end if;

      next_at := public.continuous_posting_next_slot(
        candidate.format, candidate.posts_per_day, candidate.window_start_minute,
        candidate.window_end_minute, candidate.rotation_seed, candidate.profile_id, slot_at_ts);

      -- 4. Midia. A lista da origem e lida uma vez por regra nesta chamada.
      if not (media_cache ? candidate.rule_id::text) then
        media_cache := media_cache || jsonb_build_object(
          candidate.rule_id::text,
          to_jsonb(public.continuous_posting_media_ids(
            candidate.organization_id, candidate.source_group_id, candidate.format, false)));
      end if;
      select coalesce(array_agg(entry.value::uuid order by entry.ordinality), '{}'::uuid[])
      into media_ids
      from jsonb_array_elements_text(media_cache -> candidate.rule_id::text) with ordinality as entry(value, ordinality);
      media_count := cardinality(media_ids);

      chosen_media_id := null;
      skipped_media := '[]'::jsonb;
      cycle_cursor := candidate.cycle_position;

      if media_count > 0 then
        if candidate.rotation_mode = 'same_order' or media_count = 1 then
          rotation_offset := 0;
          rotation_step := 1;
        else
          rotation_offset := public.bulk_rotation_v2_profile_offset(
            candidate.rotation_seed, candidate.profile_ordinal, media_count);
          rotation_step := public.bulk_rotation_v2_profile_step(
            candidate.rotation_seed, candidate.profile_ordinal, media_count);
        end if;

        for attempt in 1 .. least(media_count, max_media_skips)::integer loop
          media_index := mod(rotation_offset + mod(cycle_cursor, media_count) * rotation_step, media_count);
          candidate_media_id := media_ids[(media_index + 1)::integer];

          select asset.storage_path into media_storage_path
          from public.media_assets asset
          where asset.id = candidate_media_id
            and asset.organization_id = candidate.organization_id
            and asset.deleted_at is null
            and asset.deletion_requested_at is null
            and asset.status = 'ready';

          if found and public.media_asset_has_storage_object(media_storage_path) then
            chosen_media_id := candidate_media_id;
            exit;
          end if;

          -- Midia sem objeto no storage: pula para a seguinte do ciclo.
          skipped_media := skipped_media || to_jsonb(candidate_media_id);
          cycle_cursor := cycle_cursor + 1;
        end loop;
      end if;

      if chosen_media_id is null then
        update public.continuous_posting_profile_states state
        set next_post_at = next_at, cycle_position = cycle_cursor,
            last_error_code = null, last_error_message = null, last_error_at = null,
            updated_at = now_ts
        where state.rule_id = candidate.rule_id and state.profile_id = candidate.profile_id;

        -- Origem vazia renderia um aviso por perfil por horario: soma no aviso
        -- aberto do perfil em vez de empilhar.
        update public.continuous_posting_notices notice
        set skipped_count = notice.skipped_count + 1, slot_at = slot_at_ts,
            metadata = notice.metadata || jsonb_build_object('last_slot_at', slot_at_ts,
              'media_count', media_count, 'skipped_media', skipped_media)
        where notice.id = (
          select open_notice.id
          from public.continuous_posting_notices open_notice
          where open_notice.rule_id = candidate.rule_id
            and open_notice.profile_id = candidate.profile_id
            and open_notice.kind = 'skipped_no_media'
            and open_notice.cleared_at is null
          order by open_notice.created_at desc
          limit 1
        );
        if not found then
          insert into public.continuous_posting_notices (
            organization_id, rule_id, group_id, profile_id, format, kind, slot_at,
            delay_seconds, skipped_count, error_code, error_message,
            username_snapshot, group_name_snapshot, metadata
          ) values (
            candidate.organization_id, candidate.rule_id, candidate.group_id,
            candidate.profile_id, candidate.format, 'skipped_no_media', slot_at_ts,
            delay_seconds_value, 1, 'continuous_no_media',
            case when media_count = 0
              then 'A origem não tem mídia pronta para este formato.'
              else 'As mídias seguintes do ciclo não têm arquivo no storage.' end,
            candidate.username, candidate.group_name,
            jsonb_build_object('source_group_id', candidate.source_group_id,
              'media_count', media_count, 'skipped_media', skipped_media,
              'worker_id', resolved_worker)
          );
        end if;
        continue;
      end if;

      -- 5. Lote do dia (BRT) da regra.
      slot_day := (slot_at_ts at time zone 'America/Sao_Paulo')::date;
      select day_batch.batch_id into day_batch_id
      from public.continuous_posting_batches day_batch
      where day_batch.rule_id = candidate.rule_id and day_batch.day = slot_day;

      if day_batch_id is null then
        -- Dois publicadores no primeiro post do dia: o segundo espera aqui e acha o
        -- lote que o primeiro criou, em vez de criar um lote orfao.
        perform pg_advisory_xact_lock(hashtextextended(
          'continuous_posting_batch:' || candidate.rule_id::text || ':' || slot_day::text, 0));
        select day_batch.batch_id into day_batch_id
        from public.continuous_posting_batches day_batch
        where day_batch.rule_id = candidate.rule_id and day_batch.day = slot_day;

        if day_batch_id is null then
          insert into public.publication_batches (
            organization_id, created_by, name, status, scheduled_for
          ) values (
            candidate.organization_id, candidate.actor_id,
            'Contínuo · ' || left(candidate.group_name, 100) || ' · '
              || case candidate.format when 'reel' then 'Reel' else 'Story' end
              || ' · ' || to_char(slot_day, 'DD/MM/YYYY'),
            'processing',
            slot_day::timestamp at time zone 'America/Sao_Paulo'
          )
          returning publication_batches.id into day_batch_id;

          insert into public.continuous_posting_batches (rule_id, day, organization_id, batch_id)
          values (candidate.rule_id, slot_day, candidate.organization_id, day_batch_id);
        end if;
      end if;

      -- Lote do dia com disjuntor pausado: a pausa que vale e a da regra.
      if exists (
        select 1 from public.publication_batch_circuit_breakers breaker
        where breaker.batch_id = day_batch_id and breaker.paused_at is not null
      ) then
        -- pause_reason vai para a tela como esta: frase curta, nao codigo.
        update public.continuous_posting_rules rule
        set paused_at = now_ts,
            pause_reason = coalesce((
              select case when breaker.consecutive_failures > 0
                then breaker.consecutive_failures::text || ' falhas seguidas no lote do dia'
                else 'Lote do dia pausado por falhas seguidas' end
              from public.publication_batch_circuit_breakers breaker
              where breaker.batch_id = day_batch_id
            ), 'Lote do dia pausado por falhas seguidas'),
            updated_at = now_ts
        where rule.id = candidate.rule_id and rule.paused_at is null;
        rule_was_paused := found;

        if rule_was_paused then
          insert into public.continuous_posting_notices (
            organization_id, rule_id, group_id, profile_id, format, kind, slot_at,
            skipped_count, error_code, error_message, group_name_snapshot, metadata
          ) values (
            candidate.organization_id, candidate.rule_id, candidate.group_id, null,
            candidate.format, 'rule_paused', slot_at_ts, 0, 'continuous_rule_paused',
            'Muitas falhas seguidas no lote do dia; a regra foi pausada. Religue a chave para continuar.',
            candidate.group_name,
            jsonb_build_object('batch_id', day_batch_id, 'day', slot_day, 'worker_id', resolved_worker)
          );
        end if;
        paused_rule_ids := paused_rule_ids || candidate.rule_id;
        continue;
      end if;

      -- 6. Item, ja reivindicado por este publicador.
      item_key := 'continuous:' || candidate.rule_id::text || ':' || candidate.profile_id::text
        || ':' || floor(extract(epoch from slot_at_ts))::bigint::text;
      new_item_id := null;
      conflict_code := null;

      -- O gatilho de vaga roda ANTES do `on conflict`: sem esta leitura, repetir o
      -- mesmo horario bateria na vaga do proprio item e viraria aviso de conflito.
      if not exists (
        select 1 from public.publication_items existing
        where existing.organization_id = candidate.organization_id
          and existing.idempotency_key = item_key
      ) then
        begin
          insert into public.publication_items (
            organization_id, batch_id, profile_id, format, status, execute_at, caption,
            idempotency_key, attempt_count, claimed_by, lease_until,
            active_claim_consumed_attempt, preparation_status, prepared_at
          ) values (
            candidate.organization_id, day_batch_id, candidate.profile_id, candidate.format,
            'preparing', slot_at_ts, candidate.caption, item_key, 1, resolved_worker,
            now_ts + make_interval(secs => p_lease_seconds), true, 'ready', now_ts
          )
          on conflict (organization_id, idempotency_key) do nothing
          returning publication_items.id into new_item_id;

          if new_item_id is not null then
            -- Depois do item, e com o item em `preparing`: o gatilho da 264 so
            -- devolve a preparacao a `pending` em item `waiting`/`ready`.
            insert into public.publication_item_media (
              organization_id, publication_item_id, media_asset_id, position
            ) values (candidate.organization_id, new_item_id, chosen_media_id, 0);

            insert into public.continuous_posting_items (
              publication_item_id, organization_id, rule_id, profile_id, slot_at, media_asset_id
            ) values (
              new_item_id, candidate.organization_id, candidate.rule_id,
              candidate.profile_id, slot_at_ts, chosen_media_id
            );

            insert into public.publication_item_events (
              organization_id, publication_item_id, event_type, previous_status, status,
              actor_user_id, actor_label, metadata
            ) values (
              candidate.organization_id, new_item_id, 'queued', null, 'preparing',
              candidate.actor_id, left(resolved_worker, 160),
              jsonb_build_object(
                'execute_at', slot_at_ts,
                'continuous_rule_id', candidate.rule_id,
                'slot_at', slot_at_ts,
                'cycle_position', cycle_cursor,
                'media_asset_id', chosen_media_id,
                'media_count', media_count,
                'skipped_media', skipped_media
              )
            );
          end if;
        exception when unique_violation then
          -- Vaga ocupada por outro item do perfil, ou horizonte de um plano.
          if sqlerrm in ('active_publication_slot_conflict', 'bulk_publication_horizon_conflict') then
            conflict_code := sqlerrm;
            new_item_id := null;
          else
            raise;
          end if;
        end;
      end if;

      -- 7. Avanca o relogio.
      if conflict_code is not null then
        update public.continuous_posting_profile_states state
        set next_post_at = next_at, cycle_position = cycle_cursor,
            last_error_code = null, last_error_message = null, last_error_at = null,
            updated_at = now_ts
        where state.rule_id = candidate.rule_id and state.profile_id = candidate.profile_id;

        insert into public.continuous_posting_notices (
          organization_id, rule_id, group_id, profile_id, format, kind, slot_at,
          delay_seconds, skipped_count, error_code, error_message,
          username_snapshot, group_name_snapshot, metadata
        ) values (
          candidate.organization_id, candidate.rule_id, candidate.group_id,
          candidate.profile_id, candidate.format, 'skipped_slot_conflict', slot_at_ts,
          delay_seconds_value, 1, conflict_code,
          case conflict_code
            when 'bulk_publication_horizon_conflict'
              then 'O horário cai dentro da reserva de um plano em massa do perfil.'
            else 'O perfil já tem outro post deste formato no mesmo horário.' end,
          candidate.username, candidate.group_name,
          jsonb_build_object('batch_id', day_batch_id, 'worker_id', resolved_worker)
        );
      else
        update public.continuous_posting_profile_states state
        set next_post_at = next_at,
            cycle_position = cycle_cursor + 1,
            last_item_id = coalesce(new_item_id, state.last_item_id),
            last_post_at = case when new_item_id is not null then now_ts else state.last_post_at end,
            last_error_code = null, last_error_message = null, last_error_at = null,
            updated_at = now_ts
        where state.rule_id = candidate.rule_id and state.profile_id = candidate.profile_id;

        if new_item_id is not null then
          created_ids := created_ids || new_item_id;
        end if;
      end if;
    exception when others then
      -- Erro inesperado: o bloco desfaz o que este perfil fez e os outros seguem.
      -- O horario NAO avanca: a proxima chamada tenta de novo ate passar da
      -- tolerancia, e ai o aviso de post pulado carrega este erro.
      get stacked diagnostics error_state = returned_sqlstate, error_text = message_text;
      update public.continuous_posting_profile_states state
      set last_error_code = left(error_state, 120),
          last_error_message = left(error_text, 1200),
          last_error_at = now_ts,
          updated_at = now_ts
      where state.rule_id = candidate.rule_id and state.profile_id = candidate.profile_id;
    end;
  end loop;

  return created_ids;
end;
$$;

-- O publicador chama esta, antes do claim comum, nos dois pontos em que
-- dispatchPublicationQueueDirect reivindica. Devolve a MESMA `returns table` de
-- claim_publication_items: dali em diante processClaimedItem nao distingue.
create or replace function public.claim_continuous_posting_items(
  p_worker_id text,
  p_limit integer,
  p_lease_seconds integer
) returns table (
  id uuid,
  organization_id uuid,
  batch_id uuid,
  profile_id uuid,
  format public.publication_format,
  status public.publication_item_status,
  execute_at timestamptz,
  caption text,
  idempotency_key text,
  attempt_count integer,
  creation_id text,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  created_ids uuid[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode reivindicar postagem contínua.';
  end if;

  created_ids := public.continuous_posting_claim_due(p_worker_id, p_limit, p_lease_seconds);
  if coalesce(cardinality(created_ids), 0) = 0 then
    return;
  end if;

  return query
  select item.id, item.organization_id, item.batch_id, item.profile_id,
    item.format, item.status, item.execute_at, item.caption, item.idempotency_key,
    item.attempt_count, item.creation_id, item.lease_until
  from public.publication_items item
  where item.id = any(created_ids)
  order by item.execute_at, item.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. A tela: regra (com numeros do dia), configurar, ligar e desligar
-- ---------------------------------------------------------------------------

-- O JSON da regra (secao 4 do contrato). Interna: quem chama ja conferiu a permissao.
create or replace function public.continuous_posting_rule_json(p_rule_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with clock as (
    select now() as now_ts,
      date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo' as day_start
  )
  select jsonb_build_object(
    'id', rule.id,
    'groupId', rule.group_id,
    'groupName', grp.name,
    'format', rule.format,
    'enabled', rule.enabled,
    'enabledAt', rule.enabled_at,
    'sourceGroupId', rule.source_group_id,
    'sourceGroupName', source_grp.name,
    'rotationMode', rule.rotation_mode,
    'postsPerDay', rule.posts_per_day,
    'windowStartMinute', rule.window_start_minute,
    'windowEndMinute', rule.window_end_minute,
    'caption', rule.caption,
    'restHours', rule.rest_hours,
    'pausedAt', rule.paused_at,
    'pauseReason', rule.pause_reason,
    'stats', jsonb_build_object(
      'eligibleProfiles', (
        select count(*)
        from public.profile_group_members member
        join public.instagram_profiles profile on profile.id = member.profile_id
        where member.group_id = rule.group_id
          and profile.organization_id = rule.organization_id
          and profile.deleted_at is null
          and profile.status = 'online'
          and profile.provider = 'meta_official'
      ),
      'eligibleMedia', cardinality(public.continuous_posting_media_ids(
        rule.organization_id, rule.source_group_id, rule.format, true)),
      'postedToday', coalesce(item_stats.posted_today, 0),
      'inFlight', coalesce(item_stats.in_flight, 0),
      'skippedToday', (
        select coalesce(sum(notice.skipped_count), 0)
        from public.continuous_posting_notices notice
        where notice.rule_id = rule.id
          and notice.kind in ('skipped_late', 'skipped_no_media', 'skipped_slot_conflict')
          and notice.created_at >= clock.day_start
      ),
      'failedToday', coalesce(item_stats.failed_today, 0),
      'restingProfiles', (
        select count(*)
        from public.continuous_posting_profile_states state
        where state.rule_id = rule.id and state.resting_until > clock.now_ts
      ),
      'nextPostAt', case when rule.enabled and rule.paused_at is null then (
        select min(state.next_post_at)
        from public.continuous_posting_profile_states state
        where state.rule_id = rule.id and state.next_post_at < 'infinity'::timestamptz
      ) end
    )
  )
  from public.continuous_posting_rules rule
  cross join clock
  left join public.profile_groups grp on grp.id = rule.group_id
  left join public.profile_groups source_grp on source_grp.id = rule.source_group_id
  left join lateral (
    -- Dois dias de horarios bastam: o que esta em voo ou terminou hoje nasceu ontem
    -- ou hoje. Le pela lateral (indice rule_id, slot_at), nunca varre a tabela quente.
    select
      count(*) filter (where item.status = 'published' and item.published_at >= clock.day_start) as posted_today,
      count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing', 'suspended')
        or (item.status = 'failed' and item.attempt_count < 5 and item.next_attempt_at is not null)) as in_flight,
      count(*) filter (where link.slot_at >= clock.day_start and (
        item.status in ('ignored', 'cancelled')
        or (item.status = 'failed' and not (item.attempt_count < 5 and item.next_attempt_at is not null))
      )) as failed_today
    from public.continuous_posting_items link
    join public.publication_items item on item.id = link.publication_item_id
    where link.rule_id = rule.id
      and link.slot_at >= clock.day_start - interval '1 day'
  ) item_stats on true
  where rule.id = p_rule_id;
$$;

create or replace function public.get_continuous_posting_rules(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  return coalesce((
    select jsonb_agg(public.continuous_posting_rule_json(listed.id) order by listed.group_name, listed.format, listed.id)
    from (
      select rule.id, rule.format, coalesce(grp.name, '') as group_name
      from public.continuous_posting_rules rule
      join public.profile_groups grp on grp.id = rule.group_id and grp.deleted_at is null
      where rule.organization_id = p_organization_id
    ) listed
  ), '[]'::jsonb);
end;
$$;

create or replace function public.upsert_continuous_posting_rule(
  p_group_id uuid,
  p_format public.publication_format,
  p_source_group_id uuid,
  p_rotation_mode text,
  p_posts_per_day integer,
  p_window_start_minute integer,
  p_window_end_minute integer,
  p_caption text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_ts timestamptz := now();
  group_row public.profile_groups%rowtype;
  existing_rule public.continuous_posting_rules%rowtype;
  saved_rule public.continuous_posting_rules%rowtype;
  resolved_source_group_id uuid := coalesce(p_source_group_id, p_group_id);
  resolved_rotation_mode text := coalesce(nullif(trim(coalesce(p_rotation_mode, '')), ''), 'diversified');
  resolved_posts_per_day integer;
  resolved_window_start integer;
  resolved_window_end integer;
  resolved_caption text := nullif(trim(coalesce(p_caption, '')), '');
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  select grp.* into group_row
  from public.profile_groups grp
  where grp.id = p_group_id and grp.deleted_at is null;
  if not found or not public.has_organization_role(
    group_row.organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if p_format is null or p_format not in ('reel', 'story') then
    raise exception using errcode = '22023', message = 'A postagem contínua aceita somente Reel e Story.';
  end if;
  if not exists (
    select 1 from public.profile_groups source_grp
    where source_grp.id = resolved_source_group_id
      and source_grp.organization_id = group_row.organization_id
      and source_grp.deleted_at is null
  ) then
    raise exception using errcode = '22023', message = 'Origem das mídias inválida.';
  end if;
  if resolved_rotation_mode not in ('same_order', 'diversified') then
    raise exception using errcode = '22023', message = 'Modo de sorteio inválido.';
  end if;

  resolved_posts_per_day := coalesce(p_posts_per_day, case when p_format = 'reel' then 24 else 1 end);
  if (p_format = 'reel' and resolved_posts_per_day not between 1 and 57)
    or (p_format = 'story' and resolved_posts_per_day not between 1 and 100) then
    raise exception using errcode = '22023',
      message = 'Quantidade por dia inválida (Reel: 1 a 57; Story: 1 a 100).';
  end if;

  if p_format = 'story' then
    resolved_window_start := p_window_start_minute;
    resolved_window_end := p_window_end_minute;
    if resolved_window_start is null or resolved_window_end is null
      or resolved_window_start < 0 or resolved_window_end > 1440
      or resolved_window_start >= resolved_window_end then
      raise exception using errcode = '22023',
        message = 'Faixa de horas do Story inválida (minutos do dia, início antes do fim).';
    end if;
    if resolved_window_end - resolved_window_start < resolved_posts_per_day then
      raise exception using errcode = '22023',
        message = 'A faixa de horas é curta demais para a quantidade de Stories por dia.';
    end if;
  else
    -- Reel posta o dia inteiro: a faixa e ignorada.
    resolved_window_start := null;
    resolved_window_end := null;
  end if;

  if resolved_caption is not null and char_length(resolved_caption) > 2200 then
    raise exception using errcode = '22023', message = 'Legenda acima de 2.200 caracteres.';
  end if;

  select rule.* into existing_rule
  from public.continuous_posting_rules rule
  where rule.group_id = p_group_id and rule.format = p_format
  for update;

  insert into public.continuous_posting_rules (
    organization_id, group_id, format, source_type, source_group_id, rotation_mode,
    posts_per_day, window_start_minute, window_end_minute, caption, created_by, updated_by
  ) values (
    group_row.organization_id, p_group_id, p_format, 'group', resolved_source_group_id,
    resolved_rotation_mode, resolved_posts_per_day, resolved_window_start,
    resolved_window_end, resolved_caption, auth.uid(), auth.uid()
  )
  on conflict on constraint continuous_posting_rules_group_format_key do update set
    source_type = 'group',
    source_group_id = excluded.source_group_id,
    rotation_mode = excluded.rotation_mode,
    posts_per_day = excluded.posts_per_day,
    window_start_minute = excluded.window_start_minute,
    window_end_minute = excluded.window_end_minute,
    caption = excluded.caption,
    updated_by = excluded.updated_by,
    updated_at = now_ts
  returning * into saved_rule;

  -- A grade mudou com a regra ligada: os horarios guardados sao da grade antiga.
  -- Recalcula todos para o proximo horario da grade nova.
  if existing_rule.id is not null and saved_rule.enabled and (
    existing_rule.posts_per_day is distinct from saved_rule.posts_per_day
    or existing_rule.window_start_minute is distinct from saved_rule.window_start_minute
    or existing_rule.window_end_minute is distinct from saved_rule.window_end_minute
  ) then
    perform public.continuous_posting_sync_rule_states(saved_rule.id, true);
  end if;

  return public.continuous_posting_rule_json(saved_rule.id);
end;
$$;

create or replace function public.set_continuous_posting_rule_enabled(
  p_rule_id uuid,
  p_enabled boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_ts timestamptz := now();
  rule_row public.continuous_posting_rules%rowtype;
  open_items bigint;
  active_horizons bigint;
  eligible_media bigint;
  eligible_profiles bigint;
  refusal text;
begin
  if auth.uid() is null or p_enabled is null then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  select rule.* into rule_row
  from public.continuous_posting_rules rule
  where rule.id = p_rule_id
  for update;
  if not found or not public.has_organization_role(
    rule_row.organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if not p_enabled then
    -- So desliga: o que ja esta em voo termina pelo caminho normal.
    update public.continuous_posting_rules rule
    set enabled = false,
        disabled_at = case when rule.enabled then now_ts else rule.disabled_at end,
        updated_by = auth.uid(), updated_at = now_ts
    where rule.id = rule_row.id;
    return public.continuous_posting_rule_json(rule_row.id);
  end if;

  if not exists (
    select 1 from public.profile_groups grp
    where grp.id = rule_row.group_id and grp.deleted_at is null
  ) then
    raise exception using errcode = '22023', message = 'O grupo da regra foi apagado.';
  end if;

  -- A guarda de ligar.
  eligible_media := cardinality(public.continuous_posting_media_ids(
    rule_row.organization_id, rule_row.source_group_id, rule_row.format, true));

  select count(*) into eligible_profiles
  from public.profile_group_members member
  join public.instagram_profiles profile on profile.id = member.profile_id
  where member.group_id = rule_row.group_id
    and profile.organization_id = rule_row.organization_id
    and profile.deleted_at is null
    and profile.status = 'online'
    and profile.provider = 'meta_official';

  -- Fila aberta do mesmo formato que nao e desta regra, em qualquer perfil do grupo.
  select count(*) into open_items
  from public.profile_group_members member
  join public.publication_items item
    on item.organization_id = rule_row.organization_id
   and item.profile_id = member.profile_id
  where member.group_id = rule_row.group_id
    and item.archived_at is null
    and item.format = rule_row.format
    and (
      item.status in ('waiting', 'ready', 'preparing', 'publishing', 'suspended')
      or (item.status = 'failed' and item.attempt_count < 5 and item.next_attempt_at is not null)
    )
    and not exists (
      select 1 from public.continuous_posting_items link
      where link.publication_item_id = item.id and link.rule_id = rule_row.id
    );

  -- Reserva de horizonte de plano do mesmo formato: o gatilho de insert recusaria
  -- o item (23505 bulk_publication_horizon_conflict).
  select count(*) into active_horizons
  from public.profile_group_members member
  join public.bulk_publication_profile_horizons horizon
    on horizon.organization_id = rule_row.organization_id
   and horizon.profile_id = member.profile_id
  join public.bulk_publication_plans plan on plan.id = horizon.plan_id
  where member.group_id = rule_row.group_id
    and horizon.status = 'active'
    and horizon.reserved_through > now_ts
    and plan.format = rule_row.format;

  refusal := case
    when eligible_media = 0 then 'A origem não tem mídia pronta para este formato.'
    when eligible_profiles = 0 then 'O grupo não tem perfil online da API oficial da Meta.'
    when open_items > 0 then 'O grupo ainda tem fila aberta deste formato. Cancele ou espere terminar antes de ligar.'
    when active_horizons > 0 then 'O grupo ainda tem plano em massa ativo deste formato. Cancele o plano antes de ligar.'
  end;
  if refusal is not null then
    raise exception using errcode = 'P0001', message = refusal,
      detail = jsonb_build_object(
        'openItems', open_items,
        'activeHorizons', active_horizons,
        'eligibleMedia', eligible_media,
        'eligibleProfiles', eligible_profiles
      )::text;
  end if;

  -- Lote do dia que ficou com o disjuntor pausado: solta a ligacao, e o proximo
  -- post cria um lote novo (o antigo e os itens dele ficam como estao).
  delete from public.continuous_posting_batches day_batch
  where day_batch.rule_id = rule_row.id
    and exists (
      select 1 from public.publication_batch_circuit_breakers breaker
      where breaker.batch_id = day_batch.batch_id and breaker.paused_at is not null
    );

  update public.continuous_posting_rules rule
  set enabled = true,
      enabled_at = case when rule.enabled and rule.paused_at is null then coalesce(rule.enabled_at, now_ts) else now_ts end,
      enabled_by = auth.uid(),
      disabled_at = null,
      paused_at = null,
      pause_reason = null,
      updated_by = auth.uid(),
      updated_at = now_ts
  where rule.id = rule_row.id;

  -- Recalcula o proximo horario de todos os perfis a partir de agora.
  perform public.continuous_posting_sync_rule_states(rule_row.id, true);

  return public.continuous_posting_rule_json(rule_row.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Avisos: listar e limpar
-- ---------------------------------------------------------------------------

-- Junta os avisos sem item (continuous_posting_notices) com os itens da regra que
-- terminaram sem postar (lateral + publication_items por PK). So nao limpos, mais
-- recente primeiro. Os itens sao lidos nos ultimos 7 dias de horarios, para a
-- leitura nao crescer com o historico inteiro.
create or replace function public.get_continuous_posting_notices(
  p_organization_id uuid,
  p_group_id uuid default null,
  p_limit integer default 200
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  resolved_limit integer := greatest(1, least(coalesce(p_limit, 200), 1000));
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  return coalesce((
    with notice_rows as (
      select notice.id, 'notice'::text as source, null::uuid as item_id, notice.rule_id,
        notice.group_id, coalesce(grp.name, notice.group_name_snapshot) as group_name,
        notice.profile_id, coalesce(profile.username, notice.username_snapshot) as username,
        notice.format::text as format, notice.kind, notice.slot_at, notice.delay_seconds,
        notice.skipped_count, notice.resting_until, notice.error_code, notice.error_message,
        notice.created_at
      from public.continuous_posting_notices notice
      left join public.profile_groups grp on grp.id = notice.group_id
      left join public.instagram_profiles profile on profile.id = notice.profile_id
      where notice.organization_id = p_organization_id
        and notice.cleared_at is null
        and (p_group_id is null or notice.group_id = p_group_id)
      order by notice.created_at desc, notice.id
      limit resolved_limit
    ), item_rows as (
      select link.publication_item_id as id, 'item'::text as source,
        link.publication_item_id as item_id, link.rule_id, rule.group_id, grp.name as group_name,
        link.profile_id, profile.username, item.format::text as format,
        case
          when item.last_error_code = 'meta_profile_disconnected' then 'profile_disconnected'
          when item.last_error_code = 'publication_past_due' then 'post_expired'
          when item.status = 'failed' then 'post_failed'
          else 'post_cancelled'
        end as kind,
        link.slot_at, null::integer as delay_seconds, 1 as skipped_count,
        null::timestamptz as resting_until, item.last_error_code as error_code,
        item.last_error_message as error_message,
        coalesce(item.cancelled_at, item.updated_at) as created_at
      from public.continuous_posting_items link
      join public.publication_items item on item.id = link.publication_item_id
      join public.continuous_posting_rules rule on rule.id = link.rule_id
      left join public.profile_groups grp on grp.id = rule.group_id
      left join public.instagram_profiles profile on profile.id = link.profile_id
      where link.organization_id = p_organization_id
        and link.notice_cleared_at is null
        and link.slot_at >= now() - interval '7 days'
        and (
          item.status in ('ignored', 'cancelled')
          or (item.status = 'failed' and not (item.attempt_count < 5 and item.next_attempt_at is not null))
        )
        and (p_group_id is null or rule.group_id = p_group_id)
      order by coalesce(item.cancelled_at, item.updated_at) desc, link.publication_item_id
      limit resolved_limit
    ), merged as (
      select * from notice_rows
      union all
      select * from item_rows
    ), page as (
      select * from merged
      order by merged.created_at desc, merged.id
      limit resolved_limit
    )
    select jsonb_agg(jsonb_build_object(
      'id', page.id,
      'source', page.source,
      'itemId', page.item_id,
      'ruleId', page.rule_id,
      'groupId', page.group_id,
      'groupName', page.group_name,
      'profileId', page.profile_id,
      'username', page.username,
      'format', page.format,
      'kind', page.kind,
      'slotAt', page.slot_at,
      'delaySeconds', page.delay_seconds,
      'skippedCount', page.skipped_count,
      'restingUntil', page.resting_until,
      'errorCode', page.error_code,
      'errorMessage', page.error_message,
      'createdAt', page.created_at
    ) order by page.created_at desc, page.id)
    from page
  ), '[]'::jsonb);
end;
$$;

-- Limpar so tira o aviso da tela; nao recria nem reabre post nenhum.
create or replace function public.clear_continuous_posting_notices(
  p_notice_ids uuid[],
  p_item_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  now_ts timestamptz := now();
  notice_ids uuid[] := coalesce(p_notice_ids, '{}'::uuid[]);
  item_ids uuid[] := coalesce(p_item_ids, '{}'::uuid[]);
  cleared_notices integer := 0;
  cleared_items integer := 0;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if cardinality(notice_ids) + cardinality(item_ids) not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Lista de avisos inválida.';
  end if;
  if exists (
    select 1 from public.continuous_posting_notices notice
    where notice.id = any(notice_ids)
      and not public.has_organization_role(notice.organization_id, array['admin', 'operator']::public.organization_role[])
  ) or exists (
    select 1 from public.continuous_posting_items link
    where link.publication_item_id = any(item_ids)
      and not public.has_organization_role(link.organization_id, array['admin', 'operator']::public.organization_role[])
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  update public.continuous_posting_notices notice
  set cleared_at = now_ts, cleared_by = auth.uid()
  where notice.id = any(notice_ids)
    and notice.cleared_at is null;
  get diagnostics cleared_notices = row_count;

  update public.continuous_posting_items link
  set notice_cleared_at = now_ts, notice_cleared_by = auth.uid()
  where link.publication_item_id = any(item_ids)
    and link.notice_cleared_at is null;
  get diagnostics cleared_items = row_count;

  return cleared_notices + cleared_items;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Permissoes das funcoes
-- ---------------------------------------------------------------------------

-- Internas: so o service_role (as RPCs `security definer` as chamam como dono).
revoke all on function public.continuous_posting_media_ids(uuid, uuid, public.publication_format, boolean)
  from public, anon, authenticated;
revoke all on function public.continuous_posting_sync_rule_states(uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.continuous_posting_claim_due(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.continuous_posting_rule_json(uuid)
  from public, anon, authenticated;
revoke all on function public.claim_continuous_posting_items(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.continuous_posting_media_ids(uuid, uuid, public.publication_format, boolean)
  to service_role;
grant execute on function public.continuous_posting_sync_rule_states(uuid, boolean)
  to service_role;
grant execute on function public.continuous_posting_claim_due(text, integer, integer)
  to service_role;
grant execute on function public.continuous_posting_rule_json(uuid)
  to service_role;
grant execute on function public.claim_continuous_posting_items(text, integer, integer)
  to service_role;

-- A tela. Licao da 433: sem grant explicito o painel recebe 42501 e o
-- service_role esconde.
revoke all on function public.continuous_posting_next_slot(public.publication_format, integer, integer, integer, text, uuid, timestamptz)
  from public, anon;
revoke all on function public.continuous_posting_walk_slots(public.publication_format, integer, integer, integer, text, uuid, timestamptz, timestamptz)
  from public, anon;
revoke all on function public.get_continuous_posting_rules(uuid) from public, anon;
revoke all on function public.upsert_continuous_posting_rule(uuid, public.publication_format, uuid, text, integer, integer, integer, text)
  from public, anon;
revoke all on function public.set_continuous_posting_rule_enabled(uuid, boolean) from public, anon;
revoke all on function public.get_continuous_posting_notices(uuid, uuid, integer) from public, anon;
revoke all on function public.clear_continuous_posting_notices(uuid[], uuid[]) from public, anon;

grant execute on function public.continuous_posting_next_slot(public.publication_format, integer, integer, integer, text, uuid, timestamptz)
  to authenticated, service_role;
grant execute on function public.continuous_posting_walk_slots(public.publication_format, integer, integer, integer, text, uuid, timestamptz, timestamptz)
  to authenticated, service_role;
grant execute on function public.get_continuous_posting_rules(uuid) to authenticated, service_role;
grant execute on function public.upsert_continuous_posting_rule(uuid, public.publication_format, uuid, text, integer, integer, integer, text)
  to authenticated, service_role;
grant execute on function public.set_continuous_posting_rule_enabled(uuid, boolean) to authenticated, service_role;
grant execute on function public.get_continuous_posting_notices(uuid, uuid, integer) to authenticated, service_role;
grant execute on function public.clear_continuous_posting_notices(uuid[], uuid[]) to authenticated, service_role;

notify pgrst, 'reload schema';
