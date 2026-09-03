-- O cabecalho dizia 43 elegiveis e a lista vinha vazia.
--
-- A migration 363 tirou o perfil apagado da LISTA, mas deixou as CONTAGENS
-- lendo `recovery_candidates` cru. O resultado, medido em producao em
-- 03/09/2026 depois de o operador excluir os perfis marcados:
--
--   candidatos no snapshot .......... 49  (os 49 ja apagados)
--   cabecalho dizia ................. 43 a 25% / 49 a 40%
--   cartoes diziam .................. BIEL N1 12 N2 27 · LAURINHA N1 4
--   a lista mostrava ................  0
--
-- No comentario da 363 eu chamei essa diferenca de "consequencia aceita",
-- imaginando um cartao dizendo 13 e uma lista mostrando 11. Estava errado: no
-- limite ela vira 43 contra 0, que nao e uma pequena defasagem, e uma tela que
-- se contradiz. Numero de cabecalho que ninguem consegue clicar nao e um
-- numero, e um bug.
--
-- A REGRA QUE FICA, e que separa os dois tipos de numero desta tela:
--
--   MEDIDA (fica no snapshot, nunca muda): julgaveis, mediana, recente, pico,
--     saude, limiares, serie do sparkline. Descrevem o que a regua VIU no dia
--     da analise. Reescrever isso seria apagar o passado — e o pico e a mediana
--     sao justamente o que a proxima rodada precisa comparar.
--
--   ACAO (conta ao vivo): quantos perfis estao elegiveis agora. E uma promessa
--     de que existe algo para clicar, entao tem de valer AGORA. Perfil apagado
--     nao esta elegivel para nada.
--
-- Por isso as contagens passam a exigir `deleted_at is null`, exatamente como a
-- lista. `candidates_total` e as demais colunas de `recovery_group_stats`
-- continuam intactas: elas sao o registro da execucao, nao a leitura da tela.
--
-- SEGUNDO ITEM, mesma classe. `list_recovery_candidates` devolvia
-- `already_in_recovery` da coluna do snapshot, congelada no instante da
-- analise. Esse campo decide se a caixinha da linha fica clicavel — ou seja, e
-- campo de ACAO lido de fonte de MEDIDA. Depois de mandar perfis para a
-- esteira, recarregar a tela os traria de volta selecionaveis em Elegiveis.
-- Passa a ser calculado ao vivo com a mesma definicao que a analise usa:
-- existe um membro ATIVO da coorte para aquele perfil.

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
  -- Fonte unica das contagens, e a MESMA que a lista usa: candidato cujo perfil
  -- ainda existe. Contar aqui e barato — o snapshot de uma execucao tem
  -- centenas de linhas e o join e por chave primaria.
  candidate as (
    select c.*
      from public.recovery_candidates c
      join public.instagram_profiles p on p.id = c.profile_id
     where c.run_id = (select id from run)
       and p.deleted_at is null
  ),
  totals as (
    select
      count(*) filter (where reason = 'never_started' and severity = 'severe')::integer as never_started_25,
      count(*) filter (where reason = 'never_started')::integer as never_started_40,
      count(*) filter (where reason = 'collapsed')::integer as collapsed,
      count(*) filter (where new_since_previous)::integer as new_since_previous,
      -- Quantos a regua marcou NA RODADA, sem descontar quem saiu depois. A
      -- tela precisa dos dois numeros para nao deixar um zero sem explicacao:
      -- "a regua marcou 49 e todos ja sairam" e uma frase util; "0 elegiveis"
      -- sozinho parece defeito.
      (select count(*)::integer from public.recovery_candidates c
        where c.run_id = (select id from run)) as marked_in_run
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
      -- As tres contagens do cartao saem da mesma CTE que a lista respeita.
      (select count(*)::integer from candidate c
        where c.group_id = s.group_id
          and c.reason = 'never_started' and c.severity = 'severe') as never_started_25,
      (select count(*)::integer from candidate c
        where c.group_id = s.group_id
          and c.reason = 'never_started') as never_started_40,
      (select count(*)::integer from candidate c
        where c.group_id = s.group_id
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
        'newSincePrevious', new_since_previous,
        'markedInRun', marked_in_run,
        -- Quantos sairam entre a analise e agora (exclusao, na pratica).
        'goneSinceRun', marked_in_run - (never_started_40 + collapsed))
      from totals),
    'groups', (select coalesce(jsonb_agg(to_jsonb(x) order by x.group_name), '[]'::jsonb) from grp x)
  );
$$;

-- ---------------------------------------------------------------------------
-- already_in_recovery ao vivo
-- ---------------------------------------------------------------------------

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
    select
      c.*,
      p.username, p.display_name, p.profile_picture_url, g.name as group_name,
      -- Ao vivo, e nao a coluna do snapshot: este campo decide se a linha e
      -- clicavel, entao tem de descrever o agora. Mesma definicao da analise.
      exists (select 1 from public.recovery_cohort_members cm
               where cm.organization_id = c.organization_id
                 and cm.profile_id = c.profile_id
                 and cm.status = 'active') as in_recovery_now
      from public.recovery_candidates c
      join public.instagram_profiles p on p.id = c.profile_id
      join public.profile_groups g on g.id = c.group_id
     where c.run_id = p_run_id
       and (p_group_id is null or c.group_id = p_group_id)
       -- Perfil excluido sai da lista. O snapshot continua guardando a linha.
       and p.deleted_at is null
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
    r.last_active_date, r.stale_days, r.in_recovery_now, r.new_since_previous,
    (select count(*) from rows_found) > (select value from page_limit)
  from rows_found r
  order by
    case when r.reason = 'collapsed' then r.recent_index else r.vs_index end nulls last,
    r.profile_id
  limit (select value from page_limit);
$$;

revoke all on function public.get_recovery_overview(uuid, uuid) from public, anon;
grant execute on function public.get_recovery_overview(uuid, uuid) to authenticated, service_role;

revoke all on function public.list_recovery_candidates(uuid, uuid, integer) from public, anon;
grant execute on function public.list_recovery_candidates(uuid, uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
