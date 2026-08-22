-- Testes transacionais dos contratos agregados da Dashboard V2.
-- Executar contra banco descartável com migrations até 210.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(1);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
)
values
  ('11000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dashboard-v2-owner@example.com', '', now(), now(), now()),
  ('11000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dashboard-v2-outsider@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values
  ('21000000-0000-4000-8000-000000000001', 'Dashboard V2 A', 'dashboard-v2-a', '11000000-0000-4000-8000-000000000001'),
  ('21000000-0000-4000-8000-000000000002', 'Dashboard V2 B', 'dashboard-v2-b', '11000000-0000-4000-8000-000000000002');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values
  ('21000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'admin', '11000000-0000-4000-8000-000000000001'),
  ('21000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000002', 'admin', '11000000-0000-4000-8000-000000000002')
on conflict (organization_id, user_id) do nothing;

insert into public.zernio_connections (
  id, organization_id, label, encrypted_api_key, zernio_profile_id, status, created_by
)
values
  ('51000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', 'Dashboard V2 Zernio A', repeat('a', 32), 'dashboard-v2-remote-a', 'online', '11000000-0000-4000-8000-000000000001'),
  ('51000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000002', 'Dashboard V2 Zernio B', repeat('b', 32), 'dashboard-v2-remote-b', 'online', '11000000-0000-4000-8000-000000000002');

insert into public.zernio_connection_remote_profiles (
  organization_id, zernio_connection_id, zernio_profile_id,
  profile_name, kind, status, connected_at
)
values
  ('21000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', 'dashboard-v2-remote-a', 'Dashboard V2 A', 'canonical', 'connected', now()),
  ('21000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000002', 'dashboard-v2-remote-b', 'Dashboard V2 B', 'canonical', 'connected', now());

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username,
  encrypted_access_token, status, created_by, provider,
  zernio_profile_id, zernio_account_id, zernio_connection_id
)
values
  ('31000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', 'dashboard-v2-profile-a1', 'dashboard_v2_a1', 'token', 'online', '11000000-0000-4000-8000-000000000001', 'zernio', 'dashboard-v2-remote-a', 'dashboard-v2-account-a', '51000000-0000-4000-8000-000000000001'),
  ('31000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000001', 'dashboard-v2-profile-a2', 'dashboard_v2_a2', 'token', 'online', '11000000-0000-4000-8000-000000000001', 'meta_official', null, null, null),
  ('31000000-0000-4000-8000-000000000003', '21000000-0000-4000-8000-000000000002', 'dashboard-v2-profile-b1', 'dashboard_v2_b1', 'token', 'online', '11000000-0000-4000-8000-000000000002', 'zernio', 'dashboard-v2-remote-b', 'dashboard-v2-account-b', '51000000-0000-4000-8000-000000000002');

insert into public.profile_groups (id, organization_id, name, created_by)
values
  ('41000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', 'Grupo A1', '11000000-0000-4000-8000-000000000001'),
  ('41000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000002', 'Grupo B1', '11000000-0000-4000-8000-000000000002');

insert into public.profile_group_members (organization_id, group_id, profile_id, added_by)
values
  ('21000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'),
  ('21000000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-000000000003', '11000000-0000-4000-8000-000000000002');

insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date,
  posts, reach, views, likes, comments, shares, saves, interactions,
  coverage_status
)
values
  ('21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 'zernio', '2026-08-01', 1, 100, 200, 10, 2, 3, 4, 19, 'complete'),
  ('21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 'zernio', '2026-08-02', 1, 50, 80, 7, 1, 1, 1, 10, 'partial'),
  ('21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000002', 'meta_official', '2026-08-01', 1, 20, 30, 5, 0, 0, 0, 5, 'complete'),
  ('21000000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-000000000003', 'zernio', '2026-08-01', 1, 999, 999, 999, 0, 0, 0, 999, 'complete');

insert into public.profile_follower_daily_snapshots (
  organization_id, profile_id, provider, snapshot_date,
  followers_count, sync_status, synced_at
)
values
  ('21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 'zernio', '2026-07-31', 90, 'synced', now()),
  ('21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 'zernio', '2026-08-02', 110, 'synced', now()),
  ('21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000002', 'meta_official', '2026-07-31', 40, 'synced', now()),
  ('21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000002', 'meta_official', '2026-08-02', 45, 'synced', now());

insert into public.profile_post_analytics_snapshots (
  organization_id, profile_id, provider, zernio_post_id, content,
  published_at, likes, views, reach, total_interactions, sync_status
)
values
  ('21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 'zernio', 'dashboard-v2-post-1', repeat('a', 700), '2026-08-01 15:00:00+00', 12, 100, 50, 15, 'synced'),
  ('21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 'zernio', 'dashboard-v2-post-2', 'segundo', '2026-08-02 15:00:00+00', 5, 30, 20, 7, 'synced'),
  ('21000000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-000000000003', 'zernio', 'dashboard-v2-post-b', 'não pode vazar', '2026-08-01 15:00:00+00', 999, 999, 999, 999, 'synced');

set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  payload jsonb;
  top_post record;
begin
  payload := public.get_dashboard_bootstrap_v2('21000000-0000-4000-8000-000000000001');
  if jsonb_array_length(payload -> 'profiles') <> 2
    or jsonb_array_length(payload -> 'groups') <> 1
  then
    raise exception 'Bootstrap V2 não respeitou o escopo da organização.';
  end if;

  payload := public.get_dashboard_analytics_v2(
    '21000000-0000-4000-8000-000000000001',
    '2026-08-01', '2026-08-02', null, null, null, 'likes', null
  );
  if (payload #>> '{kpis,likes}')::bigint <> 22
    or (payload #>> '{kpis,reach}')::bigint <> 170
    or (payload #>> '{kpis,followers_total}')::bigint <> 155
    or (payload #>> '{kpis,followers_delta}')::bigint <> 25
    or payload #>> '{filters,bucket}' <> 'day'
  then
    raise exception 'Agregados V2 globais incorretos: %', payload;
  end if;

  payload := public.get_dashboard_analytics_v2(
    '21000000-0000-4000-8000-000000000001',
    '2026-08-01', '2026-08-02', null,
    '41000000-0000-4000-8000-000000000001', 'zernio', 'likes', 'day'
  );
  if (payload #>> '{kpis,likes}')::bigint <> 17
    or (payload #>> '{coverage,selected_profiles}')::integer <> 1
  then
    raise exception 'Filtros de grupo/provider incorretos: %', payload;
  end if;

  select * into top_post
  from public.get_dashboard_top_posts_v2(
    '21000000-0000-4000-8000-000000000001',
    '2026-08-01', '2026-08-02', null, null, null, 'likes', 1
  );
  if top_post.metric_value <> 12 or char_length(top_post.content) <> 500 then
    raise exception 'Top posts V2 não ordenou/truncou corretamente.';
  end if;

  begin
    perform public.get_dashboard_analytics_v2(
      '21000000-0000-4000-8000-000000000001',
      '2026-08-01', '2026-08-02',
      array['31000000-0000-4000-8000-000000000003']::uuid[],
      null, null, 'likes', 'day'
    );
    raise exception 'Perfil externo não foi rejeitado.';
  exception when sqlstate '22023' then
    null;
  end;

  begin
    perform public.get_dashboard_analytics_v2(
      '21000000-0000-4000-8000-000000000002',
      '2026-08-01', '2026-08-02', null, null, null, 'likes', 'day'
    );
    raise exception 'Organização externa não foi rejeitada.';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    perform public.get_dashboard_analytics_v2(
      '21000000-0000-4000-8000-000000000001',
      '2025-01-01', '2026-08-02', null, null, null, 'likes', 'day'
    );
    raise exception 'Janela acima de 366 dias não foi rejeitada.';
  exception when sqlstate '22023' then
    null;
  end;
end;
$$;

reset role;
select extensions.pass('contratos agregados da Dashboard V2 passaram isolamento, filtros e agregações');
select * from extensions.finish();

rollback;
