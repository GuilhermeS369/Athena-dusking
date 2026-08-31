-- Tela de Recuperacao (Instagram) — a esteira e o acompanhamento.
--
-- Plano: plans/plano-tela-recuperacao-instagram-2026-08-31.md
-- Schema: 347_recovery_schema.sql   Regua: 348_recovery_compute.sql
--
-- SOBRE `security definer` NESTE ARQUIVO. Mandar um perfil para a esteira sao
-- tres escritas — achar/criar o grupo "<origem> rec", mover os membros, gravar
-- a coorte com o baseline — e CADA chamada PostgREST e a propria transacao.
-- Encadear tres `.rpc()` na rota deixaria estados meio-feitos possiveis (perfil
-- movido sem linha de coorte, ou grupo criado e nada movido). Por isso e uma
-- funcao so.
--
-- Ela nao pode ser `security invoker` porque as tabelas de coorte nao tem
-- politica de escrita para `authenticated` de proposito (a tela nao fabrica
-- veredito). Entao e `definer` — e a armadilha conhecida disso e que a
-- checagem de papel de `move_profile_group_members` (que e `invoker`, migration
-- 322) EVAPORA quando ela roda dentro de uma funcao `definer`. A defesa e a
-- checagem explicita de `has_organization_role` no topo de cada funcao aqui.
-- Nao remova.
--
-- `auth.uid()` le GUC de sessao (`request.jwt.claim.sub`), entao ela sobrevive
-- ao `definer`: `added_by` e `entered_by` continuam sendo o operador real, nao
-- o dono da funcao.

-- ---------------------------------------------------------------------------
-- 1. Entrar na esteira
-- ---------------------------------------------------------------------------

create or replace function public.enter_recovery_cohort(
  p_organization_id uuid,
  p_source_group_id uuid,
  p_profile_ids uuid[],
  p_run_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.profile_groups%rowtype;
  v_recovery public.profile_groups%rowtype;
  v_created boolean := false;
  v_name text;
  v_actor uuid;
  v_run_id uuid;
  v_moved uuid[];
  v_member_ids uuid[];
  v_today date := (timezone('America/Sao_Paulo', now()))::date;
begin
  if not public.has_organization_role(
       p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Acao nao permitida.';
  end if;
  if coalesce(array_length(p_profile_ids, 1), 0) = 0 then
    raise exception using errcode = '22023', message = 'Informe ao menos um perfil.';
  end if;
  if array_length(p_profile_ids, 1) > 500 then
    raise exception using errcode = '22023',
      message = 'No maximo 500 perfis por operacao.';
  end if;

  select * into v_source
    from public.profile_groups
   where id = p_source_group_id
     and organization_id = p_organization_id
     and deleted_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'Grupo de origem nao encontrado.';
  end if;
  if v_source.recovery_source_group_id is not null then
    raise exception using errcode = '22023',
      message = 'Uma esteira de recuperacao nao pode ter esteira propria.';
  end if;

  v_actor := coalesce(auth.uid(), v_source.created_by);

  -- A esteira e achada pelo PONTEIRO, nunca pelo nome: o operador pode
  -- renomear o grupo e o vinculo tem de sobreviver a isso.
  select * into v_recovery
    from public.profile_groups
   where organization_id = p_organization_id
     and recovery_source_group_id = p_source_group_id
     and deleted_at is null;

  if not found then
    -- `name` tem check de 2 a 120 caracteres (migration 002). Sem o truncamento
    -- em 116, uma origem de nome longo faria a operacao inteira falhar por
    -- violacao de check, depois de ja ter passado por todas as validacoes.
    v_name := left(v_source.name, 116) || ' rec';

    -- Adota um grupo que ja tenha o nome da esteira mas nao o ponteiro (caso de
    -- quem criou o "X rec" a mao antes desta tela existir).
    select * into v_recovery
      from public.profile_groups
     where organization_id = p_organization_id
       and deleted_at is null
       and name = v_name
       and recovery_source_group_id is null
     limit 1;

    if found then
      update public.profile_groups
         set recovery_source_group_id = p_source_group_id
       where id = v_recovery.id
      returning * into v_recovery;
    else
      -- Herda consumption_mode e default_caption da origem para a esteira ja
      -- nascer utilizavel na postagem em massa. Se a leva reprocessada for
      -- reaproveitada em varias contas, o operador troca para 'reusable'.
      insert into public.profile_groups (
        organization_id, name, description, consumption_mode, default_caption,
        created_by, recovery_source_group_id)
      values (
        p_organization_id, v_name,
        left('Esteira de recuperacao de ' || v_source.name, 500),
        v_source.consumption_mode, v_source.default_caption,
        v_actor, p_source_group_id)
      returning * into v_recovery;
      v_created := true;
    end if;
  end if;

  -- Baseline: o candidato da execucao informada, ou da ultima concluida.
  v_run_id := coalesce(p_run_id, (
    select r.id from public.recovery_analysis_runs r
     where r.organization_id = p_organization_id
       and r.status in ('completed', 'completed_with_errors')
     order by r.created_at desc
     limit 1));

  -- So move quem realmente esta na origem AGORA. Outro operador pode ter movido
  -- o perfil entre a tela listar e o clique — a rota tem de mostrar os
  -- ignorados em vez de reportar sucesso generico.
  select coalesce(array_agg(gm.profile_id order by gm.profile_id), '{}'::uuid[])
    into v_moved
    from public.profile_group_members gm
   where gm.organization_id = p_organization_id
     and gm.group_id = p_source_group_id
     and gm.profile_id = any(p_profile_ids);

  if coalesce(array_length(v_moved, 1), 0) = 0 then
    return jsonb_build_object(
      'recoveryGroupId', v_recovery.id,
      'recoveryGroupName', v_recovery.name,
      'created', v_created,
      'movedProfileIds', '[]'::jsonb,
      'skippedProfileIds', to_jsonb(p_profile_ids),
      'cohortMemberIds', '[]'::jsonb);
  end if;

  perform public.move_profile_group_members(p_source_group_id, v_recovery.id, v_moved);

  with base as (
    select
      p.id as profile_id,
      p.username,
      c.reason,
      c.posts_total,
      c.vs,
      c.best_day_vs,
      c.recent_vs,
      -- Para o Nivel 2 a razao que importa e vs_recente/MR, nao vs/M: e a razao
      -- pela qual ele entrou, e mostrar a outra faria o perfil parecer melhor
      -- do que estava.
      case when c.reason = 'collapsed' then c.recent_index else c.vs_index end as ratio,
      gs.median_vs,
      gs.median_recent_vs
    from unnest(v_moved) as m(profile_id)
    join public.instagram_profiles p on p.id = m.profile_id
    left join public.recovery_candidates c
      on c.run_id = v_run_id and c.profile_id = m.profile_id
    left join public.recovery_group_stats gs
      on gs.run_id = v_run_id and gs.group_id = p_source_group_id
  ),
  ins as (
    insert into public.recovery_cohort_members (
      organization_id, profile_id, username_at_entry,
      source_group_id, recovery_group_id,
      entered_on, measurement_start_on, entered_by, entry_run_id, entry_reason,
      baseline_posts_total, baseline_vs, baseline_best_day_vs, baseline_recent_vs,
      baseline_ratio, baseline_group_median_vs, baseline_group_median_recent_vs)
    select
      p_organization_id, b.profile_id, b.username,
      p_source_group_id, v_recovery.id,
      v_today,
      -- A medicao comeca no dia seguinte: entre entrar na esteira e o primeiro
      -- post com midia nova, a fila antiga ainda publica midia velha. O
      -- operador pode empurrar esta data para o marco de troca de midia.
      v_today + 1,
      v_actor, v_run_id, coalesce(b.reason, 'manual'),
      b.posts_total, b.vs, b.best_day_vs, b.recent_vs,
      b.ratio, b.median_vs, b.median_recent_vs
    from base b
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_member_ids from ins;

  return jsonb_build_object(
    'recoveryGroupId', v_recovery.id,
    'recoveryGroupName', v_recovery.name,
    'created', v_created,
    'runId', v_run_id,
    'movedProfileIds', to_jsonb(v_moved),
    'skippedProfileIds', to_jsonb(
      array(select unnest(p_profile_ids) except select unnest(v_moved))),
    'cohortMemberIds', to_jsonb(v_member_ids));
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Sair da esteira
-- ---------------------------------------------------------------------------

create or replace function public.return_from_recovery_cohort(
  p_organization_id uuid,
  p_cohort_member_ids uuid[],
  p_decision text default 'manual',
  p_note text default null,
  p_target_group_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pair record;
  v_moved uuid[] := '{}'::uuid[];
  v_returned uuid[] := '{}'::uuid[];
begin
  if not public.has_organization_role(
       p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Acao nao permitida.';
  end if;
  if coalesce(array_length(p_cohort_member_ids, 1), 0) = 0 then
    raise exception using errcode = '22023', message = 'Informe ao menos um membro.';
  end if;
  if p_decision not in ('recovered', 'partial', 'not_recovered', 'manual') then
    raise exception using errcode = '22023', message = 'Decisao invalida.';
  end if;

  -- Move em blocos por (esteira -> destino). O destino padrao e o grupo de
  -- origem; se ele foi apagado, exigir destino explicito e melhor do que
  -- falhar de um jeito obscuro la dentro do move.
  for v_pair in
    select cm.recovery_group_id,
           coalesce(p_target_group_id, g.id) as target_group_id,
           array_agg(cm.profile_id) as profile_ids
      from public.recovery_cohort_members cm
      left join public.profile_groups g
        on g.id = cm.source_group_id and g.deleted_at is null
     where cm.organization_id = p_organization_id
       and cm.id = any(p_cohort_member_ids)
       and cm.status = 'active'
       and cm.recovery_group_id is not null
     group by cm.recovery_group_id, coalesce(p_target_group_id, g.id)
  loop
    if v_pair.target_group_id is null then
      raise exception using errcode = '22023',
        message = 'O grupo de origem foi apagado; informe um grupo de destino.';
    end if;
    perform public.move_profile_group_members(
      v_pair.recovery_group_id, v_pair.target_group_id, v_pair.profile_ids);
    v_moved := v_moved || v_pair.profile_ids;
  end loop;

  update public.recovery_cohort_members cm
     set status = 'returned',
         exit_at = timezone('utc', now()),
         exit_decision = p_decision,
         exit_by = auth.uid(),
         exit_note = left(p_note, 500),
         -- O indice da ultima observacao: e o numero que o operador viu na tela
         -- quando decidiu, e o que a aba Historico precisa mostrar depois.
         exit_index = (
           select o.recovery_index
             from public.recovery_cohort_observations o
            where o.cohort_member_id = cm.id
            order by o.observed_on desc
            limit 1)
   where cm.organization_id = p_organization_id
     and cm.id = any(p_cohort_member_ids)
     and cm.status = 'active';

  select coalesce(array_agg(id), '{}'::uuid[]) into v_returned
    from public.recovery_cohort_members
   where organization_id = p_organization_id
     and id = any(p_cohort_member_ids)
     and status = 'returned';

  return jsonb_build_object(
    'returnedMemberIds', to_jsonb(v_returned),
    'movedProfileIds', to_jsonb(v_moved));
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Exclusao vira registro
-- ---------------------------------------------------------------------------

-- Chamada quando o operador exclui perfis pela tela de Recuperacao — inclusive
-- direto da aba Elegiveis, sem passar pela esteira. Sem isto, o Historico
-- contaria so os perfis que sobreviveram, perdendo justamente os casos em que a
-- recuperacao falhou (ou nem foi tentada), que sao os que precisam ser
-- lembrados na proxima rodada.
create or replace function public.record_recovery_cohort_deletion(
  p_organization_id uuid,
  p_profile_ids uuid[],
  p_run_id uuid default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_today date := (timezone('America/Sao_Paulo', now()))::date;
  v_actor uuid := auth.uid();
  v_count integer := 0;
  v_inserted integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.has_organization_role(
           p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Acao nao permitida.';
  end if;
  if coalesce(array_length(p_profile_ids, 1), 0) = 0 then
    return 0;
  end if;

  -- Quem ja estava na esteira: fecha a passagem existente, preservando o
  -- baseline e a data de entrada reais.
  update public.recovery_cohort_members cm
     set status = 'removed',
         exit_at = v_now,
         exit_decision = 'deleted',
         exit_by = v_actor,
         exit_index = (
           select o.recovery_index
             from public.recovery_cohort_observations o
            where o.cohort_member_id = cm.id
            order by o.observed_on desc
            limit 1)
   where cm.organization_id = p_organization_id
     and cm.profile_id = any(p_profile_ids)
     and cm.status = 'active';
  get diagnostics v_count = row_count;

  -- Quem nunca entrou: uma linha de auditoria com entrada e saida no mesmo
  -- instante. `recovery_group_id` fica nulo — nao houve esteira.
  insert into public.recovery_cohort_members (
    organization_id, profile_id, username_at_entry, source_group_id, recovery_group_id,
    entered_on, measurement_start_on, entered_by, entry_run_id, entry_reason,
    baseline_posts_total, baseline_vs, baseline_best_day_vs, baseline_recent_vs, baseline_ratio,
    status, exit_at, exit_decision, exit_by)
  select
    p_organization_id, p.id, p.username, gm.group_id, null,
    v_today, v_today, v_actor, p_run_id, 'direct_delete',
    c.posts_total, c.vs, c.best_day_vs, c.recent_vs,
    case when c.reason = 'collapsed' then c.recent_index else c.vs_index end,
    'removed', v_now, 'deleted', v_actor
  from unnest(p_profile_ids) as t(profile_id)
  join public.instagram_profiles p on p.id = t.profile_id
  join public.profile_group_members gm
    on gm.profile_id = p.id and gm.organization_id = p_organization_id
  left join public.recovery_candidates c
    on c.profile_id = p.id
   and c.run_id = coalesce(p_run_id, (
         select r.id from public.recovery_analysis_runs r
          where r.organization_id = p_organization_id
            and r.status in ('completed', 'completed_with_errors')
          order by r.created_at desc limit 1))
  where not exists (
    select 1 from public.recovery_cohort_members prev
     where prev.organization_id = p_organization_id
       and prev.profile_id = p.id
       and prev.exit_at >= v_now - interval '1 minute');
  get diagnostics v_inserted = row_count;

  return v_count + v_inserted;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Observacao diaria da coorte
-- ---------------------------------------------------------------------------

create or replace function public.refresh_recovery_cohort_observations(
  p_organization_id uuid,
  p_run_id uuid default null,
  -- O veredito reusa a propria regua que condenou o perfil: acima do corte
  -- aberto ele esta recuperado, entre os dois cortes esta parcial, abaixo do
  -- corte apertado nao recuperou. Entrada e saida ficam simetricas.
  p_recovered_index numeric default 0.40,
  p_partial_index numeric default 0.25,
  -- Antes disso o veredito e "aguardando volume". Mentir cedo e pior do que
  -- esperar: a taxa de zerados existe justamente para dar sinal nesse periodo.
  p_min_posts integer default 30,
  p_min_origin_profiles integer default 5
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_latest date;
  v_window_end date;
  v_today date := (timezone('America/Sao_Paulo', now()))::date;
  v_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.has_organization_role(
           p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Acao nao permitida.';
  end if;

  select max(metric_date) into v_latest
    from public.profile_analytics_daily_metrics
   where organization_id = p_organization_id
     and coverage_status in ('complete', 'partial');
  if v_latest is null then
    return 0;
  end if;
  -- Mesmo descarte do dia parcial que a regua faz.
  v_window_end := v_latest - 1;

  with cohort as (
    select cm.id, cm.profile_id, cm.source_group_id, cm.measurement_start_on
      from public.recovery_cohort_members cm
     where cm.organization_id = p_organization_id
       and cm.status = 'active'
  ),

  -- Colapsa provider antes de qualquer conta, pela mesma razao da regua: a PK
  -- inclui provider e um perfil que migrou tem duas linhas no mesmo dia.
  daily as (
    select m.profile_id, m.metric_date,
           sum(m.posts)::bigint as posts,
           sum(m.views)::bigint as views
      from public.profile_analytics_daily_metrics m
     where m.organization_id = p_organization_id
       and m.coverage_status in ('complete', 'partial')
       and m.metric_date <= v_window_end
     group by m.profile_id, m.metric_date
    having sum(m.posts) > 0
  ),

  -- CHAVE DE DESEMPENHO: a mediana de origem e por (grupo, dia de corte), nao
  -- por membro. Sessenta membros da mesma leva compartilham o mesmo par, entao
  -- e um calculo em vez de sessenta. Sem isto o statement le
  -- 60 x 500 perfis x 30 dias e mora no timeout.
  keys as (
    select distinct source_group_id, measurement_start_on from cohort
  ),
  origin_profile as (
    select k.source_group_id, k.measurement_start_on, d.profile_id,
           sum(d.posts)::bigint as posts,
           sum(d.views)::bigint as views
      from keys k
      join public.profile_group_members gm
        on gm.organization_id = p_organization_id
       and gm.group_id = k.source_group_id
      join public.instagram_profiles p
        on p.id = gm.profile_id and p.deleted_at is null
      join daily d
        on d.profile_id = gm.profile_id
       and d.metric_date >= k.measurement_start_on
     group by k.source_group_id, k.measurement_start_on, d.profile_id
  ),
  origin_median as (
    select op.source_group_id, op.measurement_start_on,
           (percentile_cont(0.5) within group (
              order by (op.views::numeric / op.posts)::double precision))::numeric as origin_median_vs,
           count(*)::integer as origin_profiles
      from origin_profile op
     -- Um perfil da origem com 1 post no periodo nao deve mover a mediana.
     where op.posts >= 10
     group by op.source_group_id, op.measurement_start_on
  ),

  since as (
    select c.id as cohort_member_id,
           coalesce(sum(d.posts), 0)::bigint as posts_since,
           coalesce(sum(d.views), 0)::bigint as views_since,
           count(d.metric_date)::integer as days_since,
           max(d.metric_date) as last_metric_date
      from cohort c
      left join daily d
        on d.profile_id = c.profile_id
       and d.metric_date >= c.measurement_start_on
     group by c.id
  ),

  zeros as (
    -- Dois filtros que parecem detalhe e nao sao:
    --   sync_status = 'synced' — views = 0 de post ainda nao coletado significa
    --   "nao sei", nao "zerou";
    --   maturacao de 24h — post recem-publicado tem 0 view por definicao.
    select c.id as cohort_member_id,
           count(*)::integer as measured_posts,
           count(*) filter (where s.views = 0)::integer as zero_view_posts
      from cohort c
      join public.profile_post_analytics_snapshots s
        on s.organization_id = p_organization_id
       and s.profile_id = c.profile_id
       and s.deleted_at is null
       and s.sync_status = 'synced'
       and s.published_at is not null
       and s.published_at >= (c.measurement_start_on::timestamp at time zone 'America/Sao_Paulo')
       and s.published_at <= timezone('utc', now()) - interval '24 hours'
     group by c.id
  )

  insert into public.recovery_cohort_observations (
    cohort_member_id, observed_on, organization_id, run_id,
    posts_since, views_since, vs_since, days_since,
    origin_median_vs, origin_profiles, recovery_index, verdict,
    measured_posts, zero_view_posts, zero_view_rate, stale_days)
  select
    c.id, v_today, p_organization_id, p_run_id,
    sn.posts_since, sn.views_since,
    sn.views_since::numeric / nullif(sn.posts_since, 0),
    sn.days_since,
    om.origin_median_vs, coalesce(om.origin_profiles, 0),
    (sn.views_since::numeric / nullif(sn.posts_since, 0))
      / nullif(om.origin_median_vs, 0),
    case
      when coalesce(sn.posts_since, 0) = 0 then 'no_data'
      when om.origin_median_vs is null
        or coalesce(om.origin_profiles, 0) < p_min_origin_profiles then 'no_reference'
      when sn.posts_since < p_min_posts then 'short_sample'
      when (sn.views_since::numeric / sn.posts_since) / om.origin_median_vs
             >= p_recovered_index then 'recovered'
      when (sn.views_since::numeric / sn.posts_since) / om.origin_median_vs
             >= p_partial_index then 'partial'
      else 'not_recovered'
    end,
    coalesce(z.measured_posts, 0), coalesce(z.zero_view_posts, 0),
    z.zero_view_posts::numeric / nullif(z.measured_posts, 0),
    (v_latest - sn.last_metric_date)::integer
  from cohort c
  join since sn on sn.cohort_member_id = c.id
  left join origin_median om
    on om.source_group_id = c.source_group_id
   and om.measurement_start_on = c.measurement_start_on
  left join zeros z on z.cohort_member_id = c.id
  on conflict (cohort_member_id, observed_on) do update set
    run_id = excluded.run_id,
    posts_since = excluded.posts_since,
    views_since = excluded.views_since,
    vs_since = excluded.vs_since,
    days_since = excluded.days_since,
    origin_median_vs = excluded.origin_median_vs,
    origin_profiles = excluded.origin_profiles,
    recovery_index = excluded.recovery_index,
    verdict = excluded.verdict,
    measured_posts = excluded.measured_posts,
    zero_view_posts = excluded.zero_view_posts,
    zero_view_rate = excluded.zero_view_rate,
    stale_days = excluded.stale_days;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.enter_recovery_cohort(uuid, uuid, uuid[], uuid) from public, anon;
revoke all on function public.return_from_recovery_cohort(uuid, uuid[], text, text, uuid) from public, anon;
revoke all on function public.record_recovery_cohort_deletion(uuid, uuid[], uuid) from public, anon;
revoke all on function public.refresh_recovery_cohort_observations(
  uuid, uuid, numeric, numeric, integer, integer) from public, anon;

grant execute on function public.enter_recovery_cohort(uuid, uuid, uuid[], uuid)
  to authenticated, service_role;
grant execute on function public.return_from_recovery_cohort(uuid, uuid[], text, text, uuid)
  to authenticated, service_role;
grant execute on function public.record_recovery_cohort_deletion(uuid, uuid[], uuid)
  to authenticated, service_role;
grant execute on function public.refresh_recovery_cohort_observations(
  uuid, uuid, numeric, numeric, integer, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
