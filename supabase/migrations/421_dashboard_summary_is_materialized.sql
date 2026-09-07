-- O resumo da dashboard para de ser recalculado a cada leitura.
--
-- O SINTOMA: a dashboard abria vazia. Nao por falta de dado -- a organizacao
-- Pomodoro tem 15.783 linhas diarias e 2.161 linhas de estado corrente -- mas
-- porque as duas consultas que alimentam a tela nao terminavam:
--
--   get_dashboard_bootstrap_v2 ......... canceling statement due to statement timeout
--   get_dashboard_analytics_summary .... canceling statement due to statement timeout (8,4 s ate o corte)
--
-- E SAO A MESMA CONSULTA. A primeira linha util de `get_dashboard_bootstrap_v2`
-- (migration 383) e `select * into summary_row from get_dashboard_analytics_summary(...)`.
-- O V2 herda inteiro o custo do V1, entao "cair para o V1 quando o V2 falha"
-- nunca foi um plano B: os dois caem pelo mesmo motivo, no mesmo lugar.
--
-- ONDE O TEMPO IA. Medido em 07/09/2026 na organizacao Pomodoro:
--
--   publication_items da organizacao ............. 541.417 linhas
--     destas, fora de ('removed','cancelled','ignored')  265.798
--   contagem simples sobre esse recorte .......... ~3,1 a 3,9 s por passada
--
-- O corpo antigo materializava `publication_rows as (select * from ...)` -- TODAS
-- as colunas, incluindo `caption` -- e referenciava esse CTE CINCO vezes: total
-- de posts, agendados, proxima data, publicados e o count geral. Cinco varreduras
-- de 265 mil linhas para produzir cinco inteiros e um timestamp. Isso e
-- O(tamanho da fila) por abertura de tela, e a fila cresce todo dia.
--
-- O segundo desperdicio, menor mas gratuito: `latest_snapshots` faz um
-- `distinct on (profile_id)` sobre `profile_analytics_snapshots` e o resultado e
-- descartado pelo `union all` quando a organizacao le de `profile_analytics_current`
-- -- que e o caso da Pomodoro (`dashboard_current_state_reads_enabled` = true).
-- O ramo morto era calculado assim mesmo, porque o filtro so age depois.
--
-- A TROCA e a mesma da migration 418, pelo mesmo motivo e com o mesmo preco: a
-- agregacao sai do caminho da requisicao, roda uma vez por organizacao por ciclo
-- e grava dezenove numeros. A tela le uma linha. O custo da leitura deixa de
-- depender do tamanho da fila.
--
-- O PRECO, dito com clareza: o numero na tela tem a idade do ultimo calculo, e
-- `computed_at` diz qual e. Para uma organizacao com 541 mil publicacoes, um
-- resumo de um minuto atras nao muda decisao nenhuma.
--
-- QUEM RECALCULA: o cron da Vercel via /api/internal/dashboard-summary-refresh.
-- Se nao houver linha nenhuma (organizacao nova, ou primeiro deploy), a propria
-- leitura manda calcular uma vez -- e por isso `get_dashboard_bootstrap_v2` e
-- recriada aqui SEM `stable`: uma funcao nao-volatil nao pode disparar a escrita
-- que a auto-cura precisa fazer. O corpo dela nao muda em mais nada.

-- ---------------------------------------------------------------------------
-- 1. Onde o resultado mora
-- ---------------------------------------------------------------------------

create table if not exists public.dashboard_summary_totals (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  connections_total integer not null default 0,
  connections_healthy integer not null default 0,
  connections_attention integer not null default 0,
  operational_profiles integer not null default 0,
  scheduled_total integer not null default 0,
  next_scheduled_at timestamptz,
  failed_publications integer not null default 0,
  profiles_needing_reauth integer not null default 0,
  total_posts integer not null default 0,
  published_total integer not null default 0,
  followers_total bigint not null default 0,
  followers_delta bigint not null default 0,
  views_total bigint not null default 0,
  reach_total bigint not null default 0,
  interactions_total bigint not null default 0,
  analytics_available_profiles integer not null default 0,
  analytics_unavailable_profiles integer not null default 0,
  ready_assets integer not null default 0,
  groups_total integer not null default 0,
  state_source text not null default 'current',
  computed_at timestamptz not null default timezone('utc', now()),
  duration_ms integer not null default 0
);

comment on column public.dashboard_summary_totals.computed_at is
  'Instante REAL do calculo. A tela pode mostra-lo: o numero exibido tem esta idade, e nao "agora".';
comment on column public.dashboard_summary_totals.duration_ms is
  'Quanto o ultimo recalculo levou. Existe para a degradacao ser visivel em vez de silenciosa: se este numero subir, a agregacao esta perdendo para o crescimento da fila.';
comment on column public.dashboard_summary_totals.state_source is
  'De onde vieram os numeros de analytics nesta rodada: "current" ou "snapshot_fallback". Sem isto, um numero que muda de patamar depois de virar a chave de rollout parece bug de coleta.';

alter table public.dashboard_summary_totals enable row level security;

drop policy if exists "membros leem o resumo da propria organizacao" on public.dashboard_summary_totals;
create policy "membros leem o resumo da propria organizacao"
  on public.dashboard_summary_totals for select to authenticated
  using (public.is_organization_member(organization_id));

-- Escrita e exclusiva da funcao abaixo, que e security definer. Nenhuma politica
-- de insert/update/delete: sem elas, `authenticated` nao escreve.
revoke all on public.dashboard_summary_totals from anon, authenticated;
grant select on public.dashboard_summary_totals to authenticated;

-- ---------------------------------------------------------------------------
-- 2. O recalculo
--
-- Uma varredura por tabela, e cada uma resolve TODAS as contagens que dependia
-- dela com `count(*) filter`. O contrario -- uma subconsulta por numero -- foi
-- exatamente o que a versao antiga fazia.
--
-- statement_timeout proprio e generoso: isto roda fora do caminho da tela, e ser
-- cortado no meio deixaria o resumo velho sem ninguem saber por que.
-- ---------------------------------------------------------------------------

create or replace function public.refresh_dashboard_summary(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
as $$
declare
  started_at timestamptz := clock_timestamp();
  agora timestamptz := timezone('utc', now());
  usa_current boolean;
  perfis record;
  fila record;
  estado record;
  ativos integer;
  grupos integer;
  elapsed integer;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  usa_current := public.dashboard_current_state_reads_enabled(p_organization_id);

  -- Perfis: uma varredura, quatro contagens.
  select
    count(*)::integer as total,
    count(*) filter (where profile.status = 'online')::integer as online,
    count(*) filter (where profile.status in ('offline', 'reauthorization_required'))::integer as atencao,
    count(*) filter (where profile.status = 'reauthorization_required')::integer as reauth
  into perfis
  from public.instagram_profiles profile
  where profile.organization_id = p_organization_id
    and profile.deleted_at is null;

  -- Fila: uma varredura, cinco numeros.
  --
  -- `vivo` reproduz o recorte que o CTE `publication_rows` fazia (tudo menos
  -- removido/cancelado/ignorado). `failed_publications` fica FORA dele de
  -- proposito, porque a versao antiga contava falha sobre a tabela inteira --
  -- na pratica da no mesmo, ja que 'failed' nao esta na lista excluida, mas o
  -- comportamento e preservado ao pe da letra em vez de "corrigido" de passagem.
  select
    count(*) filter (where recorte.vivo)::integer as total_posts,
    count(*) filter (
      where recorte.vivo
        and recorte.status in ('waiting', 'ready', 'preparing', 'publishing')
        and (recorte.execute_at is null or recorte.execute_at >= agora)
    )::integer as agendados,
    min(recorte.execute_at) filter (
      where recorte.vivo
        and recorte.status in ('waiting', 'ready', 'preparing', 'publishing')
        and recorte.execute_at >= agora
    ) as proximo,
    count(*) filter (where recorte.status = 'failed')::integer as falhas,
    count(*) filter (where recorte.vivo and recorte.status = 'published')::integer as publicados
  into fila
  from (
    select
      item.status::text as status,
      item.execute_at,
      item.status::text not in ('removed', 'cancelled', 'ignored') as vivo
    from public.publication_items item
    where item.organization_id = p_organization_id
  ) as recorte;

  -- Estado analitico. O `if` e o ponto: o ramo que a organizacao NAO usa nao e
  -- calculado. Na versao antiga os dois rodavam e o `union all` descartava um.
  --
  -- O join com `instagram_profiles` e novo no ramo de `current` e vale a pena
  -- registrar: sem ele, linha de perfil ja apagado entrava na soma. A migration
  -- 383 corrigiu isso dentro do bootstrap e deixou o resumo para tras; aqui os
  -- dois passam a contar o mesmo conjunto.
  if usa_current then
    select
      coalesce(sum(estado_atual.followers_count), 0)::bigint as seguidores,
      coalesce(sum(estado_atual.followers_delta), 0)::bigint as variacao,
      coalesce(sum(estado_atual.views), 0)::bigint as views,
      coalesce(sum(estado_atual.reach), 0)::bigint as alcance,
      coalesce(sum(estado_atual.total_interactions), 0)::bigint as interacoes,
      count(*) filter (where estado_atual.sync_status::text in ('synced', 'partial'))::integer as disponiveis,
      count(*) filter (where estado_atual.sync_status::text in ('unavailable_plan', 'permission_missing', 'failed', 'not_configured'))::integer as indisponiveis
    into estado
    from public.profile_analytics_current estado_atual
    join public.instagram_profiles profile
      on profile.id = estado_atual.profile_id
     and profile.deleted_at is null
    where estado_atual.organization_id = p_organization_id
      and estado_atual.deleted_at is null;
  else
    select
      coalesce(sum(ultimo.followers_count), 0)::bigint,
      coalesce(sum(ultimo.followers_delta), 0)::bigint,
      coalesce(sum(ultimo.views), 0)::bigint,
      coalesce(sum(ultimo.reach), 0)::bigint,
      coalesce(sum(ultimo.total_interactions), 0)::bigint,
      count(*) filter (where ultimo.sync_status::text in ('synced', 'partial'))::integer,
      count(*) filter (where ultimo.sync_status::text in ('unavailable_plan', 'permission_missing', 'failed', 'not_configured'))::integer
    into estado
    from (
      select distinct on (snapshot.profile_id)
        snapshot.followers_count, snapshot.followers_delta, snapshot.views,
        snapshot.reach, snapshot.total_interactions, snapshot.sync_status
      from public.profile_analytics_snapshots snapshot
      join public.instagram_profiles profile
        on profile.id = snapshot.profile_id
       and profile.deleted_at is null
      where snapshot.organization_id = p_organization_id
        and snapshot.deleted_at is null
      order by snapshot.profile_id, snapshot.period_end desc,
        snapshot.synced_at desc nulls last, snapshot.updated_at desc
    ) as ultimo;
  end if;

  select count(*)::integer into ativos
  from public.media_assets asset
  where asset.organization_id = p_organization_id
    and asset.status = 'ready'
    and asset.deleted_at is null;

  select count(*)::integer into grupos
  from public.profile_groups group_row
  where group_row.organization_id = p_organization_id
    and group_row.deleted_at is null;

  elapsed := greatest(extract(milliseconds from clock_timestamp() - started_at)::integer, 0);

  insert into public.dashboard_summary_totals as target (
    organization_id, connections_total, connections_healthy, connections_attention,
    operational_profiles, scheduled_total, next_scheduled_at, failed_publications,
    profiles_needing_reauth, total_posts, published_total, followers_total,
    followers_delta, views_total, reach_total, interactions_total,
    analytics_available_profiles, analytics_unavailable_profiles, ready_assets,
    groups_total, state_source, computed_at, duration_ms
  ) values (
    p_organization_id, perfis.total, perfis.online, perfis.atencao,
    perfis.online, fila.agendados, fila.proximo, fila.falhas,
    perfis.reauth, fila.total_posts, fila.publicados, estado.seguidores,
    estado.variacao, estado.views, estado.alcance, estado.interacoes,
    estado.disponiveis, estado.indisponiveis, ativos,
    grupos, case when usa_current then 'current' else 'snapshot_fallback' end, agora, elapsed
  )
  on conflict (organization_id) do update set
    connections_total = excluded.connections_total,
    connections_healthy = excluded.connections_healthy,
    connections_attention = excluded.connections_attention,
    operational_profiles = excluded.operational_profiles,
    scheduled_total = excluded.scheduled_total,
    next_scheduled_at = excluded.next_scheduled_at,
    failed_publications = excluded.failed_publications,
    profiles_needing_reauth = excluded.profiles_needing_reauth,
    total_posts = excluded.total_posts,
    published_total = excluded.published_total,
    followers_total = excluded.followers_total,
    followers_delta = excluded.followers_delta,
    views_total = excluded.views_total,
    reach_total = excluded.reach_total,
    interactions_total = excluded.interactions_total,
    analytics_available_profiles = excluded.analytics_available_profiles,
    analytics_unavailable_profiles = excluded.analytics_unavailable_profiles,
    ready_assets = excluded.ready_assets,
    groups_total = excluded.groups_total,
    state_source = excluded.state_source,
    computed_at = excluded.computed_at,
    duration_ms = excluded.duration_ms;

  return jsonb_build_object(
    'organizationId', p_organization_id,
    'stateSource', case when usa_current then 'current' else 'snapshot_fallback' end,
    'computedAt', agora,
    'durationMs', elapsed
  );
end;
$$;

revoke all on function public.refresh_dashboard_summary(uuid) from public, anon;
-- `authenticated` pode recalcular a PROPRIA organizacao: e o que permite a
-- leitura abaixo se auto-curar quando ainda nao existe linha nenhuma.
grant execute on function public.refresh_dashboard_summary(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. A leitura, agora barata
--
-- Mesma assinatura e mesmas dezenove colunas de antes. Quem chama nao muda.
-- ---------------------------------------------------------------------------

create or replace function public.get_dashboard_analytics_summary(p_organization_id uuid)
returns table (
  connections_total integer,
  connections_healthy integer,
  connections_attention integer,
  operational_profiles integer,
  scheduled_total integer,
  next_scheduled_at timestamptz,
  failed_publications integer,
  profiles_needing_reauth integer,
  total_posts integer,
  published_total integer,
  followers_total bigint,
  followers_delta bigint,
  views_total bigint,
  reach_total bigint,
  interactions_total bigint,
  analytics_available_profiles integer,
  analytics_unavailable_profiles integer,
  ready_assets integer,
  groups_total integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  totais public.dashboard_summary_totals%rowtype;
begin
  -- Nao autorizado devolve ZERO LINHAS, sem excecao. E o contrato que a versao
  -- anterior tinha (um `where` no fim do select) e que quem chama ja trata.
  if not (coalesce(auth.role(), '') = 'service_role'
          or public.is_organization_member(p_organization_id)) then
    return;
  end if;

  select * into totais from public.dashboard_summary_totals
  where dashboard_summary_totals.organization_id = p_organization_id;

  -- Primeira leitura de uma organizacao, ou primeiro deploy: calcula uma vez em
  -- vez de abrir a tela mostrando zero.
  if not found then
    perform public.refresh_dashboard_summary(p_organization_id);
    select * into totais from public.dashboard_summary_totals
    where dashboard_summary_totals.organization_id = p_organization_id;
  end if;

  return query select
    totais.connections_total,
    totais.connections_healthy,
    totais.connections_attention,
    totais.operational_profiles,
    totais.scheduled_total,
    totais.next_scheduled_at,
    totais.failed_publications,
    totais.profiles_needing_reauth,
    totais.total_posts,
    totais.published_total,
    totais.followers_total,
    totais.followers_delta,
    totais.views_total,
    totais.reach_total,
    totais.interactions_total,
    totais.analytics_available_profiles,
    totais.analytics_unavailable_profiles,
    totais.ready_assets,
    totais.groups_total;
end;
$$;

revoke all on function public.get_dashboard_analytics_summary(uuid) from public, anon;
grant execute on function public.get_dashboard_analytics_summary(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. O bootstrap deixa de ser `stable`
--
-- Unica mudanca: a volatilidade. O corpo e o da migration 383, palavra por
-- palavra. Uma funcao `stable` nao pode disparar a escrita da auto-cura acima --
-- Postgres recusa DML dentro de funcao nao-volatil -- e a primeira coisa que
-- este bootstrap faz e chamar `get_dashboard_analytics_summary`.
-- ---------------------------------------------------------------------------

create or replace function public.get_dashboard_bootstrap_v2(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  summary_row record;
  result jsonb;
begin
  if not public.is_service_role_request()
    and not public.is_organization_member(p_organization_id)
  then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  select * into summary_row
  from public.get_dashboard_analytics_summary(p_organization_id);

  with profiles as (
    select profile.id, profile.username, profile.display_name,
      profile.provider::text as provider, profile.status::text as status
    from public.instagram_profiles profile
    where profile.organization_id = p_organization_id and profile.deleted_at is null
  ), groups as (
    select group_row.id, group_row.name,
      coalesce(jsonb_agg(member.profile_id order by member.profile_id)
        filter (where member.profile_id is not null), '[]'::jsonb) as profile_ids
    from public.profile_groups group_row
    left join public.profile_group_members member
      on member.organization_id = group_row.organization_id and member.group_id = group_row.id
    where group_row.organization_id = p_organization_id and group_row.deleted_at is null
    group by group_row.id, group_row.name
  ), latest_snapshot_state as (
    select distinct on (snapshot.profile_id)
      snapshot.profile_id, snapshot.sync_status::text as sync_status,
      snapshot.synced_at, snapshot.period_end, snapshot.last_error_code
    from public.profile_analytics_snapshots snapshot
    join profiles profile on profile.id = snapshot.profile_id
    where snapshot.organization_id = p_organization_id and snapshot.deleted_at is null
    order by snapshot.profile_id, snapshot.period_end desc,
      snapshot.synced_at desc nulls last, snapshot.updated_at desc
  ), selected_state as (
    select current.profile_id, current.sync_status::text as sync_status,
      current.current_synced_at as synced_at, current.period_end, current.last_error_code
    from public.profile_analytics_current current
    join profiles profile on profile.id = current.profile_id
    where current.organization_id = p_organization_id
      and current.deleted_at is null
      and public.dashboard_current_state_reads_enabled(p_organization_id)
    union all
    select snapshot.* from latest_snapshot_state snapshot
    where not public.dashboard_current_state_reads_enabled(p_organization_id)
  ), state_counts as (
    select state.sync_status, count(*)::integer as total
    from selected_state state
    group by state.sync_status
  ), state_attention as (
    select state.*
    from selected_state state
    where state.sync_status <> 'synced'
    order by state.synced_at asc nulls first, state.profile_id
    limit 60
  )
  select jsonb_build_object(
    'generated_at', timezone('utc', now()),
    'state_source', case when public.dashboard_current_state_reads_enabled(p_organization_id) then 'current' else 'snapshot_fallback' end,
    'profiles', coalesce((select jsonb_agg(to_jsonb(profile) order by profile.username) from profiles profile), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(to_jsonb(group_row) order by group_row.name) from groups group_row), '[]'::jsonb),
    'analytics_state', coalesce((select jsonb_agg(to_jsonb(state) order by state.profile_id) from state_attention state), '[]'::jsonb),
    'analytics_state_counts', coalesce((
      select jsonb_object_agg(state_counts.sync_status, state_counts.total) from state_counts
    ), '{}'::jsonb),
    'summary', jsonb_build_object(
      'connections_total', coalesce(summary_row.connections_total, 0),
      'connections_healthy', coalesce(summary_row.connections_healthy, 0),
      'connections_attention', coalesce(summary_row.connections_attention, 0),
      'operational_profiles', coalesce(summary_row.operational_profiles, 0),
      'scheduled_total', coalesce(summary_row.scheduled_total, 0),
      'next_scheduled_at', summary_row.next_scheduled_at,
      'failed_publications', coalesce(summary_row.failed_publications, 0),
      'profiles_needing_reauth', coalesce(summary_row.profiles_needing_reauth, 0),
      'total_posts', coalesce(summary_row.total_posts, 0),
      'published_total', coalesce(summary_row.published_total, 0),
      'analytics_available_profiles', coalesce(summary_row.analytics_available_profiles, 0),
      'analytics_unavailable_profiles', coalesce(summary_row.analytics_unavailable_profiles, 0),
      'ready_assets', coalesce(summary_row.ready_assets, 0),
      'groups_total', coalesce(summary_row.groups_total, 0)
    )
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_dashboard_bootstrap_v2(uuid) from public, anon;
grant execute on function public.get_dashboard_bootstrap_v2(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
