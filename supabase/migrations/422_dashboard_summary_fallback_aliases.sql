-- Conserta o ramo de snapshot do recalculo do resumo da dashboard.
--
-- O ERRO, meu, introduzido na migration 421: em plpgsql, `select ... into
-- <record>` batiza os campos do record pelo NOME DA COLUNA DE SAIDA. O ramo
-- `if usa_current` trazia os apelidos (`as seguidores`, `as variacao`, ...); o
-- ramo `else` foi escrito sem eles, entao as colunas saiam chamadas `coalesce`
-- e `count`, e a primeira leitura de `estado.seguidores` estourava:
--
--   record "estado" has no field "seguidores"
--
-- Efeito medido em 07/09/2026, logo depois de aplicar a 421: a organizacao
-- Pomodoro (que le de `profile_analytics_current`, ramo do `if`) recalculava e
-- lia normal -- resumo em 56 ms, bootstrap em 244 ms, contra o timeout de antes.
-- As outras duas, "Vini farmando cash" e "FARM", que ainda leem por snapshot
-- (`dashboard_current_state_reads_enabled` = false), falhavam as duas: no
-- recalculo e na leitura, porque a leitura chama o recalculo quando nao acha
-- linha.
--
-- A correcao e so nomear as colunas do `else` igual as do `if`. Nenhuma
-- mudanca de calculo, de assinatura ou de contrato.
--
-- NAO HA `notify pgrst, 'reload schema'` NO FIM, MAS NAO SE ENGANE: O RELOAD
-- ACONTECE ASSIM MESMO.
--
-- Foi verificado no banco em 07/09/2026, e o resultado contraria o que este
-- comentario dizia na primeira versao. O projeto tem o event trigger
-- `pgrst_ddl_watch` em `ddl_command_end` (habilitado), entao QUALQUER DDL --
-- inclusive um `create or replace function` que so troca o corpo -- ja dispara
-- o reload sozinho. Omitir a linha do `notify` nao evita risco nenhum; so evita
-- pedir a recarga duas vezes.
--
-- POR QUE ISSO IMPORTA: em 07/09/2026 a API inteira ficou fora por 33 min 47 s
-- com PGRST002 em laco, e so voltou com restart do projeto. O reload de schema
-- e o mecanismo envolvido -- ver docs/fila-de-publicacao-mapa-de-controles.md,
-- secao "O agravante: o cache de schema nao tem conexao reservada", ja medido
-- no incidente de 02/09/2026.
--
-- DUAS HIPOTESES QUE ESTA MIGRATION AFIRMOU E QUE A MEDICAO DERRUBOU. Ficam
-- escritas porque o proximo leitor vai ter as mesmas ideias:
--
--   "os publicadores simultaneos encheram o pool e o reload nao achou conexao"
--   -> NAO SE SUSTENTA. Medido ligando publicador a publicador, com 45 s de
--      acomodacao: 1, 2 e 3 publicadores dao a MESMA contagem de conexoes
--      `authenticator` (25). E o mecanismo explica: o worker fala HTTP com o
--      PostgREST; quem abre conexao com o Postgres e o PostgREST, no pool
--      dele. Somar cliente HTTP soma pressao de requisicao, nao conexao.
--
--   "o schema e grande demais para introspectar dentro do statement_timeout"
--   -> NAO SE SUSTENTA. A introspecao das 448 funcoes custa 54 ms.
--
-- E A ORDEM DOS FATOS DESMENTE A CAUSALIDADE MAIS OBVIA. A publicacao parou as
-- 12:09:36.218Z (ultimo registro em publication_item_events; o proximo e as
-- 12:43:23.673Z). A 421 so foi aplicada as ~12:11-12:12Z -- datado pelos mtimes
-- dos arquivos da sessao, porque `supabase_migrations.schema_migrations` nao
-- guarda carimbo e `track_commit_timestamp` esta OFF. **A parada veio ANTES do
-- reload**, entao o reload nao a causou. O que o reload fez, ou nao fez, na
-- janela seguinte continua nao determinado: entre a queda e a aplicacao limpa
-- desta 422 mudaram DUAS variaveis (pool 41 -> 25 e statement_timeout 8s ->
-- 30s), e separar as duas exigiria provocar outra queda de proposito. Fica como
-- nao determinado de proposito -- eleger uma engana quem ler depois.
--
-- A CONSEQUENCIA PRATICA, essa sim firme, para quem aplicar qualquer migration
-- aqui: olhe o pool ANTES. Nao existe migration "leve" neste projeto enquanto o
-- `pgrst_ddl_watch` estiver ligado:
--
--   select count(*) filter (where state='active'), count(*)
--   from pg_stat_activity where usename='authenticator';

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
  -- O join com `instagram_profiles` vale para os DOIS ramos: sem ele, linha de
  -- perfil ja apagado entrava na soma. A migration 383 corrigiu isso dentro do
  -- bootstrap e deixou o resumo para tras; aqui os dois contam o mesmo conjunto.
  --
  -- Os apelidos abaixo NAO SAO COSMETICOS: sao o nome pelo qual o record vai ser
  -- lido no `insert`. Foi a falta deles neste ramo que quebrou a 421.
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
      coalesce(sum(ultimo.followers_count), 0)::bigint as seguidores,
      coalesce(sum(ultimo.followers_delta), 0)::bigint as variacao,
      coalesce(sum(ultimo.views), 0)::bigint as views,
      coalesce(sum(ultimo.reach), 0)::bigint as alcance,
      coalesce(sum(ultimo.total_interactions), 0)::bigint as interacoes,
      count(*) filter (where ultimo.sync_status::text in ('synced', 'partial'))::integer as disponiveis,
      count(*) filter (where ultimo.sync_status::text in ('unavailable_plan', 'permission_missing', 'failed', 'not_configured'))::integer as indisponiveis
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
