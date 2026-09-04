-- Recuperacao passa a julgar somente perfis que conseguem publicar.
--
-- O QUE ESTAVA ERRADO. `candidate_pool` reunia todos os membros do grupo,
-- filtrando apenas `deleted_at`. A analise entao acusava queda de desempenho em
-- perfis que simplesmente NAO PODEM publicar -- desde 04/09/2026 sao 3.190,
-- parados em `reauthorization_required` esperando a reconexao pela API da Meta
-- (migration 374).
--
-- POR QUE ISSO IMPORTA AGORA, E NAO DEPOIS. `recovery-analysis-dispatch` roda
-- todo dia as 09:20 pelo cron da Vercel. Na primeira execucao depois da
-- transicao, a frota inteira apareceria como candidata: o diagnostico estaria
-- tecnicamente certo (elas pararam de postar) e operacionalmente inutil, porque
-- a causa nao e conteudo nem audiencia -- e credencial. Mandar essas contas
-- para uma coorte de recuperacao trocaria a estrategia de postagem delas para
-- resolver um problema que so a reconexao resolve.
--
-- A REGRA QUE FICA: recuperacao diagnostica desempenho, e desempenho so existe
-- para quem publica. Perfil fora de `online` sai da analise -- volta sozinho
-- assim que reconectar, porque `connect_meta_instagram_profile` (migration 373)
-- devolve o status para online.
--
-- A mediana do grupo tambem melhora: ela deixa de ser puxada para baixo por
-- contas impedidas, o que antes escondia quedas reais entre as que publicam.
--
-- O corpo abaixo e o da migration 348, com a unica alteracao marcada em
-- `candidate_pool`.

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
       -- So entra na analise quem consegue publicar. Um perfil parado nao
       -- "caiu": ele esta impedido, e o conserto e reconectar, nao mandar para
       -- uma coorte de recuperacao. Ver o cabecalho desta migration.
       and p.status = 'online'
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

notify pgrst, 'reload schema';
