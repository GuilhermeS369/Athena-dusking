-- Athena Scheduler: o bootstrap da dashboard para de mandar a frota inteira
-- para o navegador.
--
-- O QUE FOI MEDIDO (05/09/2026, organização Pomodoro):
--
--   get_dashboard_bootstrap_v2 ......... 1.854 ms, 633 KB de JSON
--     profiles ......................... 1.458 linhas
--     analytics_state .................. 2.024 linhas
--
-- As 2.024 linhas de `analytics_state` existem para alimentar UM cartão — o de
-- "Saúde das fontes" — que mostra **oito**. O resto atravessa a rede, é
-- serializado no servidor, hidratado no navegador e descartado.
--
-- (Os 2.024 contra 1.458 perfis não são erro de contagem: o ramo de current
-- state não filtra por perfil vivo, então linhas de perfis já apagados vinham
-- junto. Esta migração também fecha isso.)
--
-- O QUE MUDA. `analytics_state` passa a trazer só quem PRECISA de atenção — a
-- lista de problemas, no máximo 60 — e ganha ao lado `analytics_state_counts`,
-- a contagem por situação. É o que o cartão precisa para dizer "1.402 ativos, 9
-- sem permissão" e listar os nove, em vez de listar os oito primeiros em ordem
-- alfabética e esconder os nove.
--
-- Perfil que não aparece na lista está sincronizado; a contagem prova isso, e o
-- cliente não presume mais "pendente" por ausência.

create or replace function public.get_dashboard_bootstrap_v2(
  p_organization_id uuid
)
returns jsonb
language plpgsql
stable
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
    -- O join com `profiles` é novo e é o que impede linha de perfil apagado de
    -- entrar na conta.
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
    -- Só o que pede ação. 'synced' é a maioria esmagadora e não tem nada a
    -- dizer individualmente: quem responde por ela é a contagem.
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

notify pgrst, 'reload schema';
