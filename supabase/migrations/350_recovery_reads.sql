-- Tela de Recuperacao (Instagram) — leitura.
--
-- Plano: plans/plano-tela-recuperacao-instagram-2026-08-31.md
--
-- Separada da 349 de proposito: a semantica da esteira muda raramente, a forma
-- da leitura muda a cada ajuste de tela.
--
-- TODAS sao `security invoker`. Elas nao escrevem nada, e as tabelas ja tem
-- politica de select por membro da organizacao — deixar a RLS fazer o escopo e
-- mais seguro do que refazer a checagem dentro de uma funcao `definer`.
--
-- TETO EXPLICITO, NUNCA CORTE SILENCIOSO. O max_rows do PostgREST (5000) vale
-- ate para RPC `returns table`, e cortar sem avisar faria a tela agir sobre um
-- conjunto diferente do que contou. Aqui o teto e do proprio SQL e vem
-- acompanhado de `has_more`, para a tela poder recusar a acao em massa e pedir
-- para refinar o filtro — mesma postura de MAX_FILTER_PROFILE_DELETE em
-- app/api/profiles/bulk-delete/route.ts.

-- ---------------------------------------------------------------------------
-- 1. Panorama: a faixa da regua e os cards de grupo, em uma resposta
-- ---------------------------------------------------------------------------

create or replace function public.get_recovery_overview(
  p_organization_id uuid,
  p_run_id uuid default null
) returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with run as (
    select r.*
      from public.recovery_analysis_runs r
     where r.organization_id = p_organization_id
       and (p_run_id is null or r.id = p_run_id)
       and (p_run_id is not null or r.status in ('completed', 'completed_with_errors'))
     order by r.created_at desc
     limit 1
  ),
  -- A execucao em andamento e mostrada a parte: a tela precisa dizer
  -- "recalculando" sem trocar o snapshot que o operador esta olhando.
  active_run as (
    select r.id, r.status, r.groups_processed, r.groups_total
      from public.recovery_analysis_runs r
     where r.organization_id = p_organization_id
       and r.status in ('pending', 'running')
     order by r.created_at desc
     limit 1
  ),
  candidate as (
    select c.* from public.recovery_candidates c
     where c.run_id = (select id from run)
  ),
  totals as (
    select
      count(*) filter (where reason = 'never_started' and severity = 'severe')::integer as never_started_25,
      count(*) filter (where reason = 'never_started')::integer as never_started_40,
      count(*) filter (where reason = 'collapsed')::integer as collapsed,
      count(*) filter (where new_since_previous)::integer as new_since_previous
    from candidate
  ),
  grp as (
    select
      s.group_id,
      g.name as group_name,
      s.status,
      s.profiles_total, s.profiles_with_metrics, s.profiles_idle, s.judgeable_profiles,
      s.median_vs, s.median_recent_vs, s.peak_daily_median, s.peak_from_date,
      s.health_ratio, s.health_gate_passed,
      s.never_started_cut, s.never_started_cut_alt, s.collapsed_cut,
      s.last_metric_date, s.daily_median_series, s.error_message,
      -- O limiar do portao e DERIVADO na leitura. Gravar `pico * 0,60` como se
      -- fosse o pico e o erro classico aqui: na analise de 31/08 o LAURINHA
      -- aparece como "13,4 contra 15,8", e 15,8 e o limiar, nao o pico (26,3).
      s.peak_daily_median * (select health_gate_ratio from run) as health_gate_threshold,
      rg.id as recovery_group_id,
      rg.name as recovery_group_name,
      (select count(*)::integer from public.recovery_cohort_members cm
        where cm.organization_id = p_organization_id
          and cm.recovery_group_id = rg.id
          and cm.status = 'active') as cohort_active,
      (select count(*)::integer from public.recovery_candidates c
        where c.run_id = s.run_id and c.group_id = s.group_id
          and c.reason = 'never_started' and c.severity = 'severe') as never_started_25,
      (select count(*)::integer from public.recovery_candidates c
        where c.run_id = s.run_id and c.group_id = s.group_id
          and c.reason = 'never_started') as never_started_40,
      (select count(*)::integer from public.recovery_candidates c
        where c.run_id = s.run_id and c.group_id = s.group_id
          and c.reason = 'collapsed') as collapsed,
      (select coalesce(jsonb_agg(jsonb_build_object(
                'id', m.id, 'happenedOn', m.happened_on,
                'mediaCount', m.media_count, 'batchKind', m.batch_kind, 'note', m.note)
              order by m.happened_on), '[]'::jsonb)
         from public.recovery_media_milestones m
        where m.organization_id = p_organization_id
          and m.group_id = s.group_id
          and m.happened_on >= (select window_start from run)) as milestones
    from public.recovery_group_stats s
    join public.profile_groups g on g.id = s.group_id
    left join public.profile_groups rg
      on rg.recovery_source_group_id = s.group_id and rg.deleted_at is null
   where s.run_id = (select id from run)
  )
  select jsonb_build_object(
    'run', (select to_jsonb(r) - 'organization_id' from run r),
    'activeRun', (select to_jsonb(a) from active_run a),
    'staleness', jsonb_build_object(
      'latestMetricDate', (select latest_metric_date from run),
      'days', (select (current_date - latest_metric_date) from run),
      -- Acima de dois dias a faixa fica ambar: e a unica coisa que impede o
      -- operador de decidir sobre um vazio quando a coleta atrasa.
      'warn', (select (current_date - latest_metric_date) > 2 from run)),
    'totals', (select jsonb_build_object(
        'neverStarted25', never_started_25,
        'neverStarted40', never_started_40,
        'collapsed', collapsed,
        'eligible25', never_started_25 + collapsed,
        'eligible40', never_started_40 + collapsed,
        'newSincePrevious', new_since_previous)
      from totals),
    'groups', (select coalesce(jsonb_agg(to_jsonb(x) order by x.group_name), '[]'::jsonb) from grp x)
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. Candidatos
-- ---------------------------------------------------------------------------

-- Sem cursor de proposito: o botao 25%/40% e filtro de CLIENTE sobre o
-- conjunto ja carregado — e o que permite girar o ajuste sem nenhuma
-- requisicao nova, comparando os dois cenarios lado a lado antes de
-- transferir. Para isso a resposta precisa trazer o superconjunto (40%) de uma
-- vez. Se `has_more` vier true, a tela recusa a acao em massa sobre "todos" e
-- pede para refinar; nao age sobre um conjunto que nao mostrou.
create or replace function public.list_recovery_candidates(
  p_run_id uuid,
  p_group_id uuid default null,
  p_limit integer default 500
) returns table (
  profile_id uuid,
  username text,
  display_name text,
  profile_picture_url text,
  group_id uuid,
  group_name text,
  reason text,
  severity text,
  posts_total bigint,
  views_total bigint,
  vs numeric,
  best_day_vs numeric,
  best_day_date date,
  recent_posts bigint,
  recent_vs numeric,
  vs_index numeric,
  best_day_index numeric,
  recent_index numeric,
  -- A razao que a tela deve mostrar na barra "% da mediana": cada nivel e
  -- julgado por uma metrica diferente, e mostrar sempre vs/M colocaria o perfil
  -- que DESABOU acima do tique dos 40%, parecendo que nao deveria estar ali.
  judged_index numeric,
  last_active_date date,
  stale_days integer,
  already_in_recovery boolean,
  new_since_previous boolean,
  has_more boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  with page_limit as (
    select greatest(1, least(coalesce(p_limit, 500), 500)) as value
  ),
  rows_found as (
    select c.*, p.username, p.display_name, p.profile_picture_url, g.name as group_name
      from public.recovery_candidates c
      join public.instagram_profiles p on p.id = c.profile_id
      join public.profile_groups g on g.id = c.group_id
     where c.run_id = p_run_id
       and (p_group_id is null or c.group_id = p_group_id)
     order by
       case when c.reason = 'collapsed' then c.recent_index else c.vs_index end nulls last,
       c.profile_id
     limit (select value from page_limit) + 1
  )
  select
    r.profile_id, r.username, r.display_name, r.profile_picture_url,
    r.group_id, r.group_name, r.reason, r.severity,
    r.posts_total, r.views_total, r.vs, r.best_day_vs, r.best_day_date,
    r.recent_posts, r.recent_vs,
    r.vs_index, r.best_day_index, r.recent_index,
    case when r.reason = 'collapsed' then r.recent_index else r.vs_index end,
    r.last_active_date, r.stale_days, r.already_in_recovery, r.new_since_previous,
    (select count(*) from rows_found) > (select value from page_limit)
  from rows_found r
  order by
    case when r.reason = 'collapsed' then r.recent_index else r.vs_index end nulls last,
    r.profile_id
  limit (select value from page_limit);
$$;

-- ---------------------------------------------------------------------------
-- 3. A esteira e o acompanhamento
-- ---------------------------------------------------------------------------

create or replace function public.get_recovery_cohort_page(
  p_organization_id uuid,
  p_recovery_group_id uuid default null,
  p_status text default 'active',
  p_limit integer default 200
) returns table (
  cohort_member_id uuid,
  profile_id uuid,
  username text,
  source_group_id uuid,
  source_group_name text,
  recovery_group_id uuid,
  recovery_group_name text,
  entered_on date,
  measurement_start_on date,
  entry_reason text,
  baseline_vs numeric,
  baseline_ratio numeric,
  status text,
  exit_at timestamptz,
  exit_decision text,
  exit_index numeric,
  exit_note text,
  observed_on date,
  posts_since bigint,
  vs_since numeric,
  origin_median_vs numeric,
  origin_profiles integer,
  recovery_index numeric,
  verdict text,
  measured_posts integer,
  zero_view_posts integer,
  zero_view_rate numeric,
  stale_days integer,
  has_more boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  with page_limit as (
    select greatest(1, least(coalesce(p_limit, 200), 500)) as value
  ),
  rows_found as (
    select
      cm.id, cm.profile_id, cm.username_at_entry,
      cm.source_group_id, sg.name as source_group_name,
      cm.recovery_group_id, rg.name as recovery_group_name,
      cm.entered_on, cm.measurement_start_on, cm.entry_reason,
      cm.baseline_vs, cm.baseline_ratio,
      cm.status, cm.exit_at, cm.exit_decision, cm.exit_index, cm.exit_note,
      cm.entered_at,
      o.observed_on, o.posts_since, o.vs_since, o.origin_median_vs, o.origin_profiles,
      o.recovery_index, o.verdict, o.measured_posts, o.zero_view_posts,
      o.zero_view_rate, o.stale_days
    from public.recovery_cohort_members cm
    left join public.profile_groups sg on sg.id = cm.source_group_id
    left join public.profile_groups rg on rg.id = cm.recovery_group_id
    -- A observacao mais recente de cada membro. Lateral com limit 1 em vez de
    -- distinct on sobre a tabela inteira: a coorte tem dezenas de linhas, a
    -- tabela de observacoes cresce um registro por membro por dia.
    left join lateral (
      select * from public.recovery_cohort_observations obs
       where obs.cohort_member_id = cm.id
       order by obs.observed_on desc
       limit 1
    ) o on true
    where cm.organization_id = p_organization_id
      and (p_recovery_group_id is null or cm.recovery_group_id = p_recovery_group_id)
      and (p_status = 'all' or cm.status = p_status)
    order by cm.entered_at desc, cm.id desc
    limit (select value from page_limit) + 1
  )
  select
    r.id, r.profile_id, r.username_at_entry,
    r.source_group_id, r.source_group_name,
    r.recovery_group_id, r.recovery_group_name,
    r.entered_on, r.measurement_start_on, r.entry_reason,
    r.baseline_vs, r.baseline_ratio,
    r.status, r.exit_at, r.exit_decision, r.exit_index, r.exit_note,
    r.observed_on, r.posts_since, r.vs_since, r.origin_median_vs, r.origin_profiles,
    r.recovery_index, r.verdict, r.measured_posts, r.zero_view_posts,
    r.zero_view_rate, r.stale_days,
    (select count(*) from rows_found) > (select value from page_limit)
  from rows_found r
  order by r.entered_at desc, r.id desc
  limit (select value from page_limit);
$$;

-- ---------------------------------------------------------------------------
-- 4. Serie do grafico de acompanhamento
-- ---------------------------------------------------------------------------

-- Mediana da coorte e mediana da origem por dia, para as duas linhas do
-- grafico. Sai das observacoes ja gravadas: nenhuma agregacao pesada no
-- caminho de renderizacao.
create or replace function public.get_recovery_cohort_series(
  p_organization_id uuid,
  p_recovery_group_id uuid,
  p_days integer default 30
) returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with obs as (
    select o.observed_on, o.vs_since, o.origin_median_vs, o.zero_view_rate
      from public.recovery_cohort_observations o
      join public.recovery_cohort_members cm on cm.id = o.cohort_member_id
     where o.organization_id = p_organization_id
       and cm.recovery_group_id = p_recovery_group_id
       and o.observed_on >= current_date - greatest(1, least(coalesce(p_days, 30), 180))
  )
  select jsonb_build_object(
    'points', coalesce((
      select jsonb_agg(jsonb_build_object(
               'd', x.observed_on,
               'cohort', round(x.cohort_median, 2),
               'origin', round(x.origin_median, 2),
               'zeroRate', round(x.zero_rate, 4),
               'n', x.members)
             order by x.observed_on)
        from (
          select observed_on,
                 (percentile_cont(0.5) within group (order by vs_since::double precision))::numeric as cohort_median,
                 (percentile_cont(0.5) within group (order by origin_median_vs::double precision))::numeric as origin_median,
                 (percentile_cont(0.5) within group (order by zero_view_rate::double precision))::numeric as zero_rate,
                 count(*)::integer as members
            from obs group by observed_on
        ) x), '[]'::jsonb),
    'milestones', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'happenedOn', m.happened_on,
               'mediaCount', m.media_count, 'batchKind', m.batch_kind, 'note', m.note)
             order by m.happened_on)
        from public.recovery_media_milestones m
       where m.organization_id = p_organization_id
         and m.group_id = p_recovery_group_id
         and m.happened_on >= current_date - greatest(1, least(coalesce(p_days, 30), 180))
      ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.get_recovery_overview(uuid, uuid) from public, anon;
revoke all on function public.list_recovery_candidates(uuid, uuid, integer) from public, anon;
revoke all on function public.get_recovery_cohort_page(uuid, uuid, text, integer) from public, anon;
revoke all on function public.get_recovery_cohort_series(uuid, uuid, integer) from public, anon;

grant execute on function public.get_recovery_overview(uuid, uuid) to authenticated, service_role;
grant execute on function public.list_recovery_candidates(uuid, uuid, integer) to authenticated, service_role;
grant execute on function public.get_recovery_cohort_page(uuid, uuid, text, integer) to authenticated, service_role;
grant execute on function public.get_recovery_cohort_series(uuid, uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
