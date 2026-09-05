-- Athena Scheduler: o histórico do perfil removido volta a aparecer.
--
-- O QUE ACONTECIA. Perfil excluído sumia da dashboard inteira — não só do
-- presente, mas do passado: os dias em que ele publicou desapareciam dos totais,
-- dos gráficos e do ranking, como se nunca tivessem existido. Numa operação que
-- perde e repõe contas o tempo todo, isso apaga parte da própria história.
--
-- O DADO NUNCA FOI PERDIDO. `soft_delete_profile_analytics` marca snapshots,
-- seguidores e estado, mas **nunca tocou em `profile_analytics_daily_metrics`**.
-- Em 05/09/2026 são 26.101 linhas diárias no banco, incluindo as dos 2.440
-- perfis removidos. O que escondia tudo era a leitura: `scoped_profiles`
-- filtrava `deleted_at is null`, e sem o perfil no escopo o join nunca
-- acontecia.
--
-- A SEPARAÇÃO QUE ESTA MIGRAÇÃO FAZ. Métrica e frota passam a ser escopos
-- diferentes, porque respondem perguntas diferentes:
--
--   * MÉTRICA (KPIs, séries, por fonte, por grupo, ranking) inclui removidos —
--     a pergunta é "quanto esta organização entregou", e quem caiu entregou;
--   * COBERTURA (`selected_profiles`, `profiles_with_metrics`,
--     `profiles_with_publications`) conta só quem está de pé — a pergunta é
--     "a coleta está dando conta da frota", e frota é presente. Misturar os dois
--     faria a fração comparar coisas diferentes, e ela poderia até passar de
--     100%;
--   * a LISTA de perfis do filtro e o indicador de capacidade não mudam: eles
--     vêm de `get_dashboard_bootstrap_v2`, que segue só com perfil vivo.
--
-- O ranking ganha `removed`, para a tela poder marcar quem não existe mais.
-- Mostrar um @ que não abre é pior do que não mostrar.

create or replace function public.get_dashboard_analytics_v2(
  p_organization_id uuid,
  p_start_date date,
  p_end_date date,
  p_profile_ids uuid[] default null,
  p_group_id uuid default null,
  p_provider text default null,
  p_metric text default 'likes',
  p_bucket text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  selected_bucket text;
  result jsonb;
begin
  if not public.is_service_role_request()
    and not public.is_organization_member(p_organization_id)
  then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if p_start_date is null or p_end_date is null
    or p_start_date > p_end_date
    or (p_end_date - p_start_date) > 365
  then
    raise exception using errcode = '22023', message = 'Período inválido; use uma janela entre 1 e 366 dias.';
  end if;

  if p_metric not in ('likes', 'comments', 'views', 'reach', 'shares', 'saves', 'interactions') then
    raise exception using errcode = '22023', message = 'Métrica inválida.';
  end if;

  if p_provider is not null and p_provider not in ('meta_official', 'zernio') then
    raise exception using errcode = '22023', message = 'Provider inválido.';
  end if;

  if p_group_id is not null and not exists (
    select 1
    from public.profile_groups as group_row
    where group_row.id = p_group_id
      and group_row.organization_id = p_organization_id
      and group_row.deleted_at is null
  ) then
    raise exception using errcode = '22023', message = 'Grupo inválido para a organização.';
  end if;

  if p_profile_ids is not null and exists (
    select 1
    from unnest(p_profile_ids) as requested(profile_id)
    where not exists (
      select 1
      from public.instagram_profiles as profile
      where profile.id = requested.profile_id
        and profile.organization_id = p_organization_id
    )
  ) then
    raise exception using errcode = '22023', message = 'Perfil inválido para a organização.';
  end if;

  selected_bucket := coalesce(
    p_bucket,
    case
      when (p_end_date - p_start_date) <= 30 then 'day'
      when (p_end_date - p_start_date) <= 179 then 'week'
      else 'month'
    end
  );

  if selected_bucket not in ('day', 'week', 'month') then
    raise exception using errcode = '22023', message = 'Bucket inválido.';
  end if;

  with scoped_profiles as materialized (
    select
      profile.id,
      profile.username,
      profile.display_name,
      profile.provider::text as provider,
      -- Perfil removido continua no escopo da MÉTRICA e sai do escopo da
      -- COBERTURA: o passado da organização inclui quem caiu, mas a fração
      -- "quantos perfis têm métrica" fala da frota de pé.
      (profile.deleted_at is null) as is_active
    from public.instagram_profiles as profile
    where profile.organization_id = p_organization_id
      and (p_profile_ids is null or profile.id = any(p_profile_ids))
      and (p_provider is null or profile.provider::text = p_provider)
      and (
        p_group_id is null
        or exists (
          select 1
          from public.profile_group_members as member
          where member.organization_id = p_organization_id
            and member.group_id = p_group_id
            and member.profile_id = profile.id
        )
      )
  ), daily as materialized (
    select
      metric.profile_id,
      profile.provider,
      metric.metric_date,
      metric.posts,
      metric.impressions,
      metric.reach,
      metric.views,
      metric.likes,
      metric.comments,
      metric.shares,
      metric.saves,
      metric.interactions,
      metric.coverage_status,
      case p_metric
        when 'likes' then metric.likes
        when 'comments' then metric.comments
        when 'views' then metric.views
        when 'reach' then metric.reach
        when 'shares' then metric.shares
        when 'saves' then metric.saves
        else metric.interactions
      end as selected_metric
    from public.profile_analytics_daily_metrics as metric
    join scoped_profiles as profile on profile.id = metric.profile_id
    where metric.organization_id = p_organization_id
      and metric.metric_date between p_start_date and p_end_date
      and metric.coverage_status in ('complete', 'partial')
  ), latest_followers as (
    select distinct on (follower.profile_id)
      follower.profile_id,
      follower.followers_count,
      follower.snapshot_date
    from public.profile_follower_daily_snapshots as follower
    join scoped_profiles as profile on profile.id = follower.profile_id
    where follower.organization_id = p_organization_id
      and follower.deleted_at is null
      and follower.snapshot_date <= p_end_date
      and follower.sync_status <> 'failed'
    order by follower.profile_id, follower.snapshot_date desc, follower.synced_at desc nulls last
  ), baseline_followers as (
    select distinct on (follower.profile_id)
      follower.profile_id,
      follower.followers_count,
      follower.snapshot_date
    from public.profile_follower_daily_snapshots as follower
    join scoped_profiles as profile on profile.id = follower.profile_id
    where follower.organization_id = p_organization_id
      and follower.deleted_at is null
      and follower.snapshot_date < p_start_date
      and follower.sync_status <> 'failed'
    order by follower.profile_id, follower.snapshot_date desc, follower.synced_at desc nulls last
  ), follower_points as (
    select
      date_trunc(selected_bucket, follower.snapshot_date::timestamp)::date as bucket_date,
      follower.profile_id,
      max(follower.followers_count) as followers_count
    from public.profile_follower_daily_snapshots as follower
    join scoped_profiles as profile on profile.id = follower.profile_id
    where follower.organization_id = p_organization_id
      and follower.deleted_at is null
      and follower.snapshot_date between p_start_date and p_end_date
      and follower.sync_status <> 'failed'
    group by date_trunc(selected_bucket, follower.snapshot_date::timestamp)::date, follower.profile_id
  ), metric_series as (
    select
      date_trunc(selected_bucket, daily.metric_date::timestamp)::date as bucket_date,
      sum(daily.selected_metric)::bigint as value
    from daily
    group by date_trunc(selected_bucket, daily.metric_date::timestamp)::date
  ), series_by_metric as (
    -- TODAS as métricas na mesma passada. São sete somas sobre a CTE `daily`,
    -- que já está materializada — custo desprezível — e é o que permite à tela
    -- trocar de métrica sem ir ao servidor de novo. A alternativa (uma chamada
    -- por métrica) faria o gráfico piscar a cada clique.
    select
      date_trunc(selected_bucket, daily.metric_date::timestamp)::date as bucket_date,
      sum(daily.likes)::bigint as likes,
      sum(daily.comments)::bigint as comments,
      sum(daily.views)::bigint as views,
      sum(daily.reach)::bigint as reach,
      sum(daily.shares)::bigint as shares,
      sum(daily.saves)::bigint as saves,
      sum(daily.interactions)::bigint as interactions
    from daily
    group by date_trunc(selected_bucket, daily.metric_date::timestamp)::date
  ), ranking as (
    select
      profile.id as profile_id,
      profile.username,
      profile.display_name,
      -- A tela precisa saber que este perfil não existe mais: sem isso o
      -- operador clica num @ que não abre e conclui que a tela está quebrada.
      (not profile.is_active) as removed,
      coalesce(sum(daily.selected_metric), 0)::bigint as value
    from scoped_profiles as profile
    left join daily on daily.profile_id = profile.id
    group by profile.id, profile.username, profile.display_name, profile.is_active
    order by value desc, profile.username, profile.id
    limit 10
  ), per_source as (
    select daily.provider as label, sum(daily.selected_metric)::bigint as value
    from daily
    group by daily.provider
  ), per_group as (
    select group_row.id, group_row.name as label, sum(daily.selected_metric)::bigint as value
    from daily
    join public.profile_group_members as member
      on member.organization_id = p_organization_id
     and member.profile_id = daily.profile_id
    join public.profile_groups as group_row
      on group_row.id = member.group_id
     and group_row.organization_id = p_organization_id
     and group_row.deleted_at is null
    group by group_row.id, group_row.name
  ), coverage as (
    select
      count(distinct profile.id) filter (where profile.is_active)::integer as selected_profiles,
      count(distinct daily.profile_id) filter (where profile.is_active)::integer as profiles_with_metrics,
      count(distinct daily.profile_id) filter (where profile.is_active and daily.coverage_status = 'partial')::integer as partial_profiles,
      -- As datas continuam olhando TUDO: elas respondem "até quando existe
      -- métrica nesta janela", e o dia de um perfil que caiu existiu.
      min(daily.metric_date) as first_metric_date,
      max(daily.metric_date) as last_metric_date
    from scoped_profiles as profile
    left join daily on daily.profile_id = profile.id
  )
  select jsonb_build_object(
    'generated_at', timezone('utc', now()),
    'filters', jsonb_build_object(
      'start_date', p_start_date,
      'end_date', p_end_date,
      'metric', p_metric,
      'bucket', selected_bucket,
      'provider', p_provider,
      'group_id', p_group_id
    ),
    'kpis', jsonb_build_object(
      'impressions', coalesce((select sum(impressions) from daily), 0),
      'reach', coalesce((select sum(reach) from daily), 0),
      'views', coalesce((select sum(views) from daily), 0),
      'likes', coalesce((select sum(likes) from daily), 0),
      'comments', coalesce((select sum(comments) from daily), 0),
      'shares', coalesce((select sum(shares) from daily), 0),
      'saves', coalesce((select sum(saves) from daily), 0),
      'interactions', coalesce((select sum(interactions) from daily), 0),
      'engagement_rate', case
        when coalesce((select sum(reach) from daily), 0) > 0
          then round((select sum(interactions) from daily)::numeric * 100 / (select sum(reach) from daily), 4)
        else 0
      end,
      'followers_total', coalesce((select sum(followers_count) from latest_followers), 0),
      'followers_delta', coalesce((
        select sum(latest.followers_count - baseline.followers_count)
        from latest_followers as latest
        join baseline_followers as baseline using (profile_id)
      ), 0),
      'followers_baseline_profiles', (select count(*) from baseline_followers)
    ),
    'metric_series', coalesce((
      select jsonb_agg(jsonb_build_object('date', bucket_date, 'value', value) order by bucket_date)
      from metric_series
    ), '[]'::jsonb),
    'series_by_metric', jsonb_build_object(
      'likes', coalesce((select jsonb_agg(jsonb_build_object('date', bucket_date, 'value', likes) order by bucket_date) from series_by_metric), '[]'::jsonb),
      'comments', coalesce((select jsonb_agg(jsonb_build_object('date', bucket_date, 'value', comments) order by bucket_date) from series_by_metric), '[]'::jsonb),
      'views', coalesce((select jsonb_agg(jsonb_build_object('date', bucket_date, 'value', views) order by bucket_date) from series_by_metric), '[]'::jsonb),
      'reach', coalesce((select jsonb_agg(jsonb_build_object('date', bucket_date, 'value', reach) order by bucket_date) from series_by_metric), '[]'::jsonb),
      'shares', coalesce((select jsonb_agg(jsonb_build_object('date', bucket_date, 'value', shares) order by bucket_date) from series_by_metric), '[]'::jsonb),
      'saves', coalesce((select jsonb_agg(jsonb_build_object('date', bucket_date, 'value', saves) order by bucket_date) from series_by_metric), '[]'::jsonb),
      'interactions', coalesce((select jsonb_agg(jsonb_build_object('date', bucket_date, 'value', interactions) order by bucket_date) from series_by_metric), '[]'::jsonb)
    ),
    'follower_series', coalesce((
      select jsonb_agg(jsonb_build_object('date', bucket_date, 'value', value) order by bucket_date)
      from (
        select bucket_date, sum(followers_count)::bigint as value
        from follower_points
        group by bucket_date
      ) as series
    ), '[]'::jsonb),
    'metric_per_source', coalesce((
      select jsonb_agg(jsonb_build_object('label', label, 'value', value) order by label)
      from per_source
    ), '[]'::jsonb),
    'metric_per_group', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'value', value) order by label)
      from per_group
    ), '[]'::jsonb),
    'ranking', coalesce((
      select jsonb_agg(to_jsonb(ranking) order by value desc, username, profile_id)
      from ranking
    ), '[]'::jsonb),
    'coverage', (select to_jsonb(coverage) from coverage)
  ) into result;

  return result;
end;
$$;

create or replace function public.get_dashboard_operations_v2(
  p_organization_id uuid,
  p_start_date date,
  p_end_date date,
  p_profile_ids uuid[] default null,
  p_group_id uuid default null,
  p_provider text default null,
  p_bucket text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  selected_bucket text;
  result jsonb;
begin
  if not public.is_service_role_request()
    and not public.is_organization_member(p_organization_id)
  then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if p_start_date is null or p_end_date is null
    or p_start_date > p_end_date
    or (p_end_date - p_start_date) > 365
  then
    raise exception using errcode = '22023', message = 'Período inválido; use uma janela entre 1 e 366 dias.';
  end if;

  if p_provider is not null and p_provider not in ('meta_official', 'zernio') then
    raise exception using errcode = '22023', message = 'Provider inválido.';
  end if;

  if p_group_id is not null and not exists (
    select 1
    from public.profile_groups as group_row
    where group_row.id = p_group_id
      and group_row.organization_id = p_organization_id
      and group_row.deleted_at is null
  ) then
    raise exception using errcode = '22023', message = 'Grupo inválido para a organização.';
  end if;

  selected_bucket := coalesce(
    p_bucket,
    case
      when (p_end_date - p_start_date) <= 30 then 'day'
      when (p_end_date - p_start_date) <= 179 then 'week'
      else 'month'
    end
  );

  if selected_bucket not in ('day', 'week', 'month') then
    raise exception using errcode = '22023', message = 'Bucket inválido.';
  end if;

  with scoped_profiles as materialized (
    select profile.id, (profile.deleted_at is null) as is_active
    from public.instagram_profiles as profile
    where profile.organization_id = p_organization_id
      and (p_profile_ids is null or profile.id = any(p_profile_ids))
      and (p_provider is null or profile.provider::text = p_provider)
      and (
        p_group_id is null
        or exists (
          select 1
          from public.profile_group_members as member
          where member.organization_id = p_organization_id
            and member.group_id = p_group_id
            and member.profile_id = profile.id
        )
      )
  ), published as materialized (
    select
      item.profile_id,
      item.format::text as format,
      timezone('America/Sao_Paulo', item.published_at) as local_published_at
    from public.publication_items as item
    join scoped_profiles as profile on profile.id = item.profile_id
    where item.organization_id = p_organization_id
      and item.status = 'published'
      and item.published_at >= (p_start_date::timestamp at time zone 'America/Sao_Paulo')
      and item.published_at < ((p_end_date + 1)::timestamp at time zone 'America/Sao_Paulo')
  ), publication_scope as materialized (
    select
      item.status::text as status,
      item.format::text as format
    from public.publication_items as item
    join scoped_profiles as profile on profile.id = item.profile_id
    where item.organization_id = p_organization_id
      and item.status not in ('removed', 'cancelled', 'ignored')
      and coalesce(item.published_at, item.execute_at, item.created_at)
        >= (p_start_date::timestamp at time zone 'America/Sao_Paulo')
      and coalesce(item.published_at, item.execute_at, item.created_at)
        < ((p_end_date + 1)::timestamp at time zone 'America/Sao_Paulo')
  ), post_series as (
    select
      date_trunc(selected_bucket, published.local_published_at)::date as bucket_date,
      count(*)::bigint as value
    from published
    group by date_trunc(selected_bucket, published.local_published_at)::date
  ), status_distribution as (
    select status as label, count(*)::bigint as value
    from publication_scope
    group by status
  ), format_distribution as (
    select format as label, count(*)::bigint as value
    from publication_scope
    group by format
  ), metric_profiles as (
    -- Só os IDS, e sem agregar valor: aqui a pergunta é "este perfil recebeu
    -- alguma métrica no período?", não quanto ele somou.
    select distinct metric.profile_id
    from public.profile_analytics_daily_metrics as metric
    join scoped_profiles as profile on profile.id = metric.profile_id
    where metric.organization_id = p_organization_id
      and metric.metric_date between p_start_date and p_end_date
      and metric.coverage_status in ('complete', 'partial')
  )
  select jsonb_build_object(
    'generated_at', timezone('utc', now()),
    'posts', (select count(*) from published),
    'post_series', coalesce((
      select jsonb_agg(jsonb_build_object('date', bucket_date, 'value', value) order by bucket_date)
      from post_series
    ), '[]'::jsonb),
    'publication_status', coalesce((
      select jsonb_agg(jsonb_build_object('label', label, 'value', value) order by label)
      from status_distribution
    ), '[]'::jsonb),
    'publication_format', coalesce((
      select jsonb_agg(jsonb_build_object('label', label, 'value', value) order by label)
      from format_distribution
    ), '[]'::jsonb),
    -- Perfis que de fato publicaram na janela: é o denominador que interessa,
    -- porque perfil sem publicação não tem métrica a exibir.
    'profiles_with_publications', (
      select count(distinct published.profile_id)
      from published
      join scoped_profiles as profile on profile.id = published.profile_id and profile.is_active
    )::integer,
    -- Publicou e continua sem linha diária: o único número que merece alarme.
    'profiles_pending_collection', (
      select count(distinct published.profile_id)
      from published
      join scoped_profiles as profile on profile.id = published.profile_id and profile.is_active
      where not exists (
        select 1 from metric_profiles as pending where pending.profile_id = published.profile_id
      )
    )::integer
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_dashboard_operations_v2(uuid, date, date, uuid[], uuid, text, text) from public, anon;
grant execute on function public.get_dashboard_operations_v2(uuid, date, date, uuid[], uuid, text, text) to authenticated, service_role;

notify pgrst, 'reload schema';
