-- Tela de Recuperacao (Instagram) — a regua.
--
-- Plano: plans/plano-tela-recuperacao-instagram-2026-08-31.md
-- Schema: 347_recovery_schema.sql
--
-- A REGRA QUE MANDA NA FORMA DESTE ARQUIVO: o statement_timeout do papel do
-- PostgREST e de ~8s, e ele limita UM statement de topo. Um `for` em plpgsql
-- percorrendo doze grupos gasta o mesmo orcamento que um statement gigante —
-- foi a licao da migration 324 ("a unica forma de fazer mais trabalho do que
-- cabe em 8s e dividir em varias chamadas separadas"). Por isso:
--
--   compute_recovery_analysis_group  = UM grupo, UM statement, tudo ou nada
--   process_recovery_analysis_chunk  = UM grupo por chamada, progresso duravel
--   o laco real                      = fica no worker/rota, entre chamadas HTTP
--
-- E cada grupo roda dentro de um bloco de excecao que grava status='failed'.
-- Sem ele, um grupo que estoura o timeout reverte tudo, nunca ganha linha em
-- recovery_group_stats, e o chunk seguinte tenta o mesmo grupo para sempre —
-- que e literalmente o incidente de 29/08 reencenado.
--
-- POPULACAO DAS ESTATISTICAS: quando median_includes_recovery esta ligado (o
-- default), M, MR, o pico e as contagens de julgaveis/parados sao calculados
-- sobre "membros do grupo UNIAO membros da esteira do grupo". Os candidatos
-- saem SO dos membros do grupo. Ver o cabecalho da 347 para o porque (a
-- catraca da mediana).

-- ---------------------------------------------------------------------------
-- 1. Abertura da execucao
-- ---------------------------------------------------------------------------

create or replace function public.begin_recovery_analysis_run(
  p_organization_id uuid,
  p_trigger_source text default 'manual',
  -- Os defaults abaixo SAO a regua. Nao existe tabela de configuracao: cada
  -- execucao copia estes valores para a propria linha, entao mudar um default
  -- aqui nao reescreve o passado.
  p_window_days integer default 30,
  p_discard_recent_days integer default 1,
  p_min_posts_judgeable integer default 60,
  p_recent_window_posts integer default 60,
  p_never_started_ratio numeric default 0.25,
  p_never_started_ratio_alt numeric default 0.40,
  p_collapsed_ratio numeric default 0.25,
  p_health_gate_ratio numeric default 0.60,
  -- Guarda MATEMATICA, nao politica: com 2 julgaveis o percentile_cont faz a
  -- media dos dois e um deles esta sempre abaixo de M, entao metade do grupo
  -- viraria candidata. Quem decide quais grupos entram e o toggle em /grupos.
  p_min_judgeable_profiles integer default 5,
  -- Um dia com 2 perfis postando e um viral fixaria um pico que trava o
  -- Filtro 2 do grupo pela janela inteira. O dia continua no sparkline.
  p_min_profiles_per_day integer default 3,
  -- DEFAULT_RANGE_DAYS = 4 em lib/integrations/zernio-analytics.ts: cada sync
  -- regrava so os ultimos 4 dias, e a fila de refresh pausa sob pressao de
  -- publicacao. A frescura e POR PERFIL. Uma cauda de dias faltando derruba
  -- vs_recente e fabrica um "desabou" que nao existe.
  p_max_staleness_days integer default 2,
  p_median_includes_recovery boolean default true,
  p_peak_from_last_milestone boolean default true,
  -- Janela explicita: existe para o teste de aceitacao poder reproduzir a
  -- analise de 25 a 31/08 macha com macha. Fora disso, deixe nulo.
  p_window_start date default null,
  p_window_end date default null
) returns public.recovery_analysis_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.recovery_analysis_runs%rowtype;
  v_latest date;
  v_start date;
  v_end date;
  v_days integer;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.has_organization_role(
           p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Acao nao permitida.';
  end if;

  if p_trigger_source not in ('cron', 'manual', 'backfill') then
    raise exception using errcode = '22023', message = 'Origem de execucao invalida.';
  end if;

  -- Idempotencia, mesma defesa da migration 323: o cron e o botao "Recalcular"
  -- competindo nao podem abrir duas execucoes vivas para a mesma organizacao.
  select * into v_run
    from public.recovery_analysis_runs
   where organization_id = p_organization_id
     and status in ('pending', 'running')
   order by created_at desc
   limit 1;
  if found then
    return v_run;
  end if;

  -- A janela sai dos DADOS, nao do relogio: se a coleta parou ha tres dias, a
  -- tela precisa dizer isso em vez de analisar um vazio recente.
  select max(metric_date) into v_latest
    from public.profile_analytics_daily_metrics
   where organization_id = p_organization_id
     and coverage_status in ('complete', 'partial');

  if v_latest is null then
    raise exception using errcode = 'P0002',
      message = 'Sem metricas diarias para esta organizacao.';
  end if;

  v_end := coalesce(p_window_end, v_latest - p_discard_recent_days);
  v_start := coalesce(p_window_start, v_end - (p_window_days - 1));
  v_days := case
    when p_window_start is null and p_window_end is null then p_window_days
    else (v_end - v_start) + 1
  end;

  insert into public.recovery_analysis_runs (
    organization_id, trigger_source, requested_by, status,
    window_days, discard_recent_days, min_posts_judgeable, recent_window_posts,
    never_started_ratio, never_started_ratio_alt, collapsed_ratio, health_gate_ratio,
    min_judgeable_profiles, min_profiles_per_day, max_staleness_days,
    median_includes_recovery, peak_from_last_milestone,
    latest_metric_date, window_start, window_end, groups_total
  ) values (
    p_organization_id, p_trigger_source, auth.uid(), 'pending',
    v_days, p_discard_recent_days, p_min_posts_judgeable, p_recent_window_posts,
    p_never_started_ratio, p_never_started_ratio_alt, p_collapsed_ratio, p_health_gate_ratio,
    p_min_judgeable_profiles, p_min_profiles_per_day, p_max_staleness_days,
    p_median_includes_recovery, p_peak_from_last_milestone,
    v_latest, v_start, v_end,
    (select count(*)::integer from public.profile_groups g
      where g.organization_id = p_organization_id
        and g.deleted_at is null
        and g.recovery_enabled
        and g.recovery_source_group_id is null)
  ) returning * into v_run;

  return v_run;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. A regua, em um unico statement
-- ---------------------------------------------------------------------------

create or replace function public.compute_recovery_analysis_group(
  p_run_id uuid,
  p_group_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.recovery_analysis_runs%rowtype;
  v_peak_from date;
begin
  select * into v_run from public.recovery_analysis_runs where id = p_run_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Execucao nao encontrada.';
  end if;

  -- De onde o pico passa a ser contado. Cada leva de midia tem seu proprio
  -- teto: comparar a midia de hoje com o pico da leva anterior compara coisas
  -- diferentes, e um dia excepcional de tres semanas atras manteria
  -- MR/pico < 0,60 para sempre, desligando o Filtro 2 do grupo em definitivo.
  v_peak_from := v_run.window_start;
  if v_run.peak_from_last_milestone then
    select coalesce(greatest(v_run.window_start, max(m.happened_on)), v_run.window_start)
      into v_peak_from
      from public.recovery_media_milestones m
     where m.organization_id = v_run.organization_id
       and m.group_id = p_group_id
       and m.happened_on between v_run.window_start and v_run.window_end;
  end if;

  with member as (
    -- Populacao ESTATISTICA: o grupo, mais a esteira dele quando o desvio
    -- consciente esta ligado. Perfil apagado sai; perfil sem grupo nunca entra
    -- (a regua e por grupo, e nao existe grupo "sem grupo").
    select distinct gm.profile_id
      from public.profile_group_members gm
      join public.instagram_profiles p
        on p.id = gm.profile_id
       and p.organization_id = gm.organization_id
       and p.deleted_at is null
     where gm.organization_id = v_run.organization_id
       and (
         gm.group_id = p_group_id
         or (v_run.median_includes_recovery and exists (
              select 1 from public.profile_groups rg
               where rg.id = gm.group_id
                 and rg.organization_id = v_run.organization_id
                 and rg.deleted_at is null
                 and rg.recovery_source_group_id = p_group_id))
       )
  ),

  candidate_pool as (
    -- So membros do proprio grupo podem virar candidatos. A esteira entra na
    -- conta da mediana, nunca na lista de acusados.
    select gm.profile_id
      from public.profile_group_members gm
      join public.instagram_profiles p
        on p.id = gm.profile_id
       and p.organization_id = gm.organization_id
       and p.deleted_at is null
     where gm.organization_id = v_run.organization_id
       and gm.group_id = p_group_id
  ),

  daily as (
    -- (1) o dia mais recente ja saiu por window_end;
    -- (2) posts = 0 sai pelo HAVING: dia sem postagem nao e dia ruim, e dia
    --     que nao existe — e dividir por ele estoura;
    -- (3) o group by colapsa `provider`: a PK inclui provider, e um perfil que
    --     migrou de meta_official para zernio tem DUAS linhas no mesmo
    --     metric_date. Somar sem colapsar contaria o dia duas vezes E tiraria
    --     a ordem total da janela movel dos 60 posts la embaixo.
    select m.profile_id,
           m.metric_date,
           sum(m.posts)::bigint as posts,
           sum(m.views)::bigint as views
      from public.profile_analytics_daily_metrics m
      join member on member.profile_id = m.profile_id
     where m.organization_id = v_run.organization_id
       and m.coverage_status in ('complete', 'partial')
       and m.metric_date between v_run.window_start and v_run.window_end
     group by m.profile_id, m.metric_date
    having sum(m.posts) > 0
  ),

  profile_tot as (
    select d.profile_id,
           sum(d.posts)::bigint as posts_total,
           sum(d.views)::bigint as views_total,
           max(d.views::numeric / d.posts) as best_day_vs,
           max(d.metric_date) as last_active_date
      from daily d
     group by d.profile_id
  ),

  judgeable as (
    select t.profile_id, t.posts_total, t.views_total, t.best_day_vs, t.last_active_date,
           t.views_total::numeric / t.posts_total as vs
      from profile_tot t
     where t.posts_total >= v_run.min_posts_judgeable
  ),

  best_day_dt as (
    -- Empate no melhor dia desempata pela data mais recente, para o veredito
    -- nao variar entre execucoes sem motivo.
    select distinct on (d.profile_id) d.profile_id, d.metric_date as best_day_date
      from daily d
      join judgeable j on j.profile_id = d.profile_id
     order by d.profile_id, (d.views::numeric / d.posts) desc, d.metric_date desc
  ),

  recent_mark as (
    -- Janela recente: soma de tras para frente ate acumular N posts. O frame
    -- termina em `1 preceding` DE PROPOSITO — assim o dia que cruza os 60
    -- posts entra inteiro. Com `current row` ele ficaria de fora e perfis de
    -- poucos posts por dia perderiam a ultima leva.
    select d.profile_id, d.metric_date, d.posts, d.views,
           coalesce(sum(d.posts) over (
             partition by d.profile_id
             order by d.metric_date desc
             rows between unbounded preceding and 1 preceding
           ), 0) as posts_before
      from daily d
      join judgeable j on j.profile_id = d.profile_id
  ),

  recent as (
    select r.profile_id,
           sum(r.posts)::bigint as recent_posts,
           sum(r.views)::bigint as recent_views,
           min(r.metric_date) as recent_from_date,
           max(r.metric_date) as recent_to_date
      from recent_mark r
     where r.posts_before < v_run.recent_window_posts
     group by r.profile_id
  ),

  scored as (
    select j.profile_id, j.posts_total, j.views_total, j.vs, j.best_day_vs,
           j.last_active_date, b.best_day_date,
           rc.recent_posts, rc.recent_views, rc.recent_from_date, rc.recent_to_date,
           rc.recent_views::numeric / nullif(rc.recent_posts, 0) as recent_vs,
           (v_run.window_end - j.last_active_date)::integer as stale_days
      from judgeable j
      left join recent rc on rc.profile_id = j.profile_id
      left join best_day_dt b on b.profile_id = j.profile_id
  ),

  medians as (
    -- Mediana, nunca media: dois perfis virais fazem 17% de todas as views.
    -- percentile_cont interpola, entao com contagem par o valor pode nao
    -- existir na amostra — e o comportamento desejado.
    select count(*)::integer as judgeable_profiles,
           (percentile_cont(0.5) within group (order by s.vs::double precision))::numeric as median_vs,
           (percentile_cont(0.5) within group (order by s.recent_vs::double precision))::numeric as median_recent_vs
      from scored s
  ),

  daily_median as (
    select d.metric_date,
           (percentile_cont(0.5) within group (
              order by (d.views::numeric / d.posts)::double precision))::numeric as daily_median_vs,
           count(*)::integer as profiles_with_posts
      from daily d
     group by d.metric_date
  ),

  peak as (
    select max(dm.daily_median_vs) as peak_value
      from daily_median dm
     where dm.profiles_with_posts >= v_run.min_profiles_per_day
       and dm.metric_date >= v_peak_from
  ),

  gate as (
    select md.judgeable_profiles, md.median_vs, md.median_recent_vs, pk.peak_value,
           (md.judgeable_profiles >= v_run.min_judgeable_profiles
             and coalesce(md.median_vs, 0) > 0) as base_ok,
           -- MR > 0 e pico > 0 sao obrigatorios: sem eles,
           -- `MR >= 0 * 0,60` e sempre verdadeiro e o portao de saude ABRIRIA
           -- justamente no grupo morto, que e o oposto do que ele existe para
           -- fazer.
           (md.judgeable_profiles >= v_run.min_judgeable_profiles
             and coalesce(pk.peak_value, 0) > 0
             and coalesce(md.median_recent_vs, 0) > 0
             and md.median_recent_vs >= pk.peak_value * v_run.health_gate_ratio) as health_gate_passed
      from medians md cross join peak pk
  ),

  classified as (
    select s.profile_id, s.posts_total, s.views_total, s.vs, s.best_day_vs, s.best_day_date,
           s.recent_posts, s.recent_views, s.recent_vs, s.recent_from_date, s.recent_to_date,
           s.last_active_date, s.stale_days,
           g.median_vs, g.median_recent_vs,
           case
             -- Filtro 1, emitido no limiar FROUXO e etiquetado por severidade
             -- mais abaixo: e o que permite a tela oferecer 25% e 40% lado a
             -- lado sem duas execucoes. O `best_day_vs < median_vs` e o veto
             -- vitalicio — a peca que sustenta a regua quando a midia queima.
             when s.best_day_vs < g.median_vs
                  and s.vs < g.median_vs * v_run.never_started_ratio_alt
               then 'never_started'
             -- Filtro 2: so com o portao de saude aberto e sem coleta atrasada.
             when g.health_gate_passed
                  and s.best_day_vs >= g.median_vs
                  and s.recent_vs is not null
                  and s.recent_vs < g.median_recent_vs * v_run.collapsed_ratio
                  and coalesce(s.stale_days, 999) <= v_run.max_staleness_days
               then 'collapsed'
             else null
           end as reason
      from scored s
      cross join gate g
     where g.base_ok
       and exists (select 1 from candidate_pool cp where cp.profile_id = s.profile_id)
  ),

  previous_run as (
    select r.id
      from public.recovery_analysis_runs r
     where r.organization_id = v_run.organization_id
       and r.id <> p_run_id
       and r.status in ('completed', 'completed_with_errors')
     order by r.created_at desc
     limit 1
  ),

  inserted as (
    insert into public.recovery_candidates (
      run_id, organization_id, group_id, profile_id, reason, severity,
      posts_total, views_total, vs, best_day_vs, best_day_date,
      recent_posts, recent_views, recent_vs, recent_from_date, recent_to_date,
      vs_index, best_day_index, recent_index, last_active_date, stale_days,
      already_in_recovery, new_since_previous
    )
    select
      p_run_id, v_run.organization_id, p_group_id, c.profile_id, c.reason,
      case
        when c.reason = 'never_started'
             and c.vs < c.median_vs * v_run.never_started_ratio then 'severe'
        when c.reason = 'never_started' then 'moderate'
        else 'severe'
      end,
      c.posts_total, c.views_total, c.vs, c.best_day_vs, c.best_day_date,
      c.recent_posts, c.recent_views, c.recent_vs, c.recent_from_date, c.recent_to_date,
      c.vs / nullif(c.median_vs, 0),
      c.best_day_vs / nullif(c.median_vs, 0),
      c.recent_vs / nullif(c.median_recent_vs, 0),
      c.last_active_date, c.stale_days,
      exists (select 1 from public.recovery_cohort_members cm
               where cm.organization_id = v_run.organization_id
                 and cm.profile_id = c.profile_id
                 and cm.status = 'active'),
      -- Na primeira execucao ninguem e "novo": sem execucao anterior para
      -- comparar, marcar tudo como novo seria ruido, nao informacao.
      (exists (select 1 from previous_run)
        and not exists (select 1 from public.recovery_candidates pc
                         where pc.run_id = (select id from previous_run)
                           and pc.profile_id = c.profile_id))
      from classified c
     where c.reason is not null
    on conflict (run_id, profile_id) do nothing
    returning reason
  )

  insert into public.recovery_group_stats (
    run_id, organization_id, group_id, status,
    profiles_total, profiles_with_metrics, profiles_idle, judgeable_profiles,
    posts_total, views_total,
    median_vs, median_recent_vs, peak_daily_median, peak_from_date,
    health_ratio, health_gate_passed,
    never_started_cut, never_started_cut_alt, collapsed_cut,
    candidates_never_started, candidates_collapsed, last_metric_date, daily_median_series
  )
  select
    p_run_id, v_run.organization_id, p_group_id,
    case
      when (select count(*) from candidate_pool) = 0 then 'no_members'
      when g.judgeable_profiles = 0 then 'no_metrics'
      when g.judgeable_profiles < v_run.min_judgeable_profiles then 'insufficient_judgeable'
      when coalesce(g.median_vs, 0) <= 0 then 'degenerate_median'
      when not g.health_gate_passed then 'gate_blocked'
      else 'ok'
    end,
    (select count(*)::integer from member),
    (select count(*)::integer from profile_tot),
    -- Membro sem NENHUM dia com post na janela. Some da regua por construcao;
    -- o numero existe para a tela nao deixar "cade os outros" sem resposta.
    (select count(*)::integer from member m
      where not exists (select 1 from profile_tot t where t.profile_id = m.profile_id)),
    g.judgeable_profiles,
    coalesce((select sum(posts_total) from profile_tot), 0),
    coalesce((select sum(views_total) from profile_tot), 0),
    g.median_vs, g.median_recent_vs, g.peak_value, v_peak_from,
    g.median_recent_vs / nullif(g.peak_value, 0),
    g.health_gate_passed,
    g.median_vs * v_run.never_started_ratio,
    g.median_vs * v_run.never_started_ratio_alt,
    g.median_recent_vs * v_run.collapsed_ratio,
    (select count(*)::integer from inserted where reason = 'never_started'),
    (select count(*)::integer from inserted where reason = 'collapsed'),
    (select max(last_active_date) from profile_tot),
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'd', dm.metric_date,
               'm', round(dm.daily_median_vs, 2),
               'n', dm.profiles_with_posts)
             order by dm.metric_date)
        from daily_median dm), '[]'::jsonb)
  -- `gate` e agregacao sem group by: sempre produz UMA linha, mesmo com zero
  -- entrada. E o que garante que grupo vazio ou sem metrica AINDA ganhe linha
  -- em group_stats — sem isso o conjunto de "grupos pendentes" nunca esvazia e
  -- o laco de chunks roda para sempre.
  from gate g
  on conflict (run_id, group_id) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. O laco, fatiado entre chamadas
-- ---------------------------------------------------------------------------

create or replace function public.process_recovery_analysis_chunk(
  p_run_id uuid,
  p_group_limit integer default 1
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.recovery_analysis_runs%rowtype;
  v_group_id uuid;
  v_processed integer := 0;
  v_failed integer := 0;
  v_remaining integer;
begin
  select * into v_run from public.recovery_analysis_runs where id = p_run_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Execucao nao encontrada.';
  end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.has_organization_role(
           v_run.organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Acao nao permitida.';
  end if;
  if v_run.status not in ('pending', 'running') then
    return jsonb_build_object(
      'runId', p_run_id, 'status', v_run.status,
      'processed', 0, 'failed', 0, 'remaining', 0);
  end if;

  update public.recovery_analysis_runs
     set status = 'running',
         started_at = coalesce(started_at, timezone('utc', now()))
   where id = p_run_id
  returning * into v_run;

  for v_group_id in
    select g.id
      from public.profile_groups g
     where g.organization_id = v_run.organization_id
       and g.deleted_at is null
       and g.recovery_enabled
       -- A esteira nao e analisada como grupo de origem: ela e a coorte em
       -- observacao, nao um conjunto de candidatos.
       and g.recovery_source_group_id is null
       and not exists (select 1 from public.recovery_group_stats s
                        where s.run_id = p_run_id and s.group_id = g.id)
     order by g.id
     limit greatest(1, least(coalesce(p_group_limit, 1), 3))
  loop
    begin
      perform public.compute_recovery_analysis_group(p_run_id, v_group_id);
      v_processed := v_processed + 1;
    exception when others then
      -- SEM este bloco, um grupo que estoura o statement_timeout reverte tudo,
      -- nunca ganha linha em group_stats, e o chunk seguinte tenta o mesmo
      -- grupo para sempre. E o incidente de 29/08 reencenado.
      insert into public.recovery_group_stats (
        run_id, organization_id, group_id, status, error_message)
      values (p_run_id, v_run.organization_id, v_group_id, 'failed', left(sqlerrm, 1200))
      on conflict (run_id, group_id) do nothing;
      v_failed := v_failed + 1;
    end;
  end loop;

  select count(*)::integer into v_remaining
    from public.profile_groups g
   where g.organization_id = v_run.organization_id
     and g.deleted_at is null
     and g.recovery_enabled
     and g.recovery_source_group_id is null
     and not exists (select 1 from public.recovery_group_stats s
                      where s.run_id = p_run_id and s.group_id = g.id);

  update public.recovery_analysis_runs r
     set groups_processed = r.groups_processed + v_processed,
         groups_failed = r.groups_failed + v_failed,
         candidates_total = (select count(*)::integer
                               from public.recovery_candidates c
                              where c.run_id = p_run_id),
         status = case
           when v_remaining > 0 then 'running'
           when r.groups_failed + v_failed > 0 then 'completed_with_errors'
           else 'completed'
         end,
         finished_at = case when v_remaining > 0 then null else timezone('utc', now()) end
   where r.id = p_run_id;

  return jsonb_build_object(
    'runId', p_run_id,
    'processed', v_processed,
    'failed', v_failed,
    'remaining', v_remaining,
    'status', case when v_remaining > 0 then 'running' else 'completed' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Poda
-- ---------------------------------------------------------------------------

create or replace function public.prune_recovery_analysis_runs(
  p_organization_id uuid,
  p_keep_runs integer default 90,
  p_max_delete integer default 5
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.has_organization_role(
           p_organization_id, array['admin']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Acao nao permitida.';
  end if;

  -- No maximo p_max_delete por chamada: apagar noventa execucoes com centenas
  -- de candidatos cada num unico statement e o mesmo erro de manutencao de
  -- indice que travou a migration 323.
  with excedente as (
    select r.id
      from (
        select id, row_number() over (order by created_at desc) as posicao
          from public.recovery_analysis_runs
         where organization_id = p_organization_id
           and status in ('completed', 'completed_with_errors', 'failed')
      ) r
     where r.posicao > greatest(p_keep_runs, 1)
     order by r.posicao desc
     limit greatest(p_max_delete, 1)
  )
  delete from public.recovery_analysis_runs d
   using excedente e
   where d.id = e.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.begin_recovery_analysis_run(
  uuid, text, integer, integer, integer, integer, numeric, numeric, numeric, numeric,
  integer, integer, integer, boolean, boolean, date, date) from public, anon;
revoke all on function public.compute_recovery_analysis_group(uuid, uuid) from public, anon, authenticated;
revoke all on function public.process_recovery_analysis_chunk(uuid, integer) from public, anon;
revoke all on function public.prune_recovery_analysis_runs(uuid, integer, integer) from public, anon;

grant execute on function public.begin_recovery_analysis_run(
  uuid, text, integer, integer, integer, integer, numeric, numeric, numeric, numeric,
  integer, integer, integer, boolean, boolean, date, date) to authenticated, service_role;
-- compute_* nao e chamada direto: so pelo chunk, que serializa com `for update`
-- na linha da execucao.
grant execute on function public.compute_recovery_analysis_group(uuid, uuid) to service_role;
grant execute on function public.process_recovery_analysis_chunk(uuid, integer) to authenticated, service_role;
grant execute on function public.prune_recovery_analysis_runs(uuid, integer, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
