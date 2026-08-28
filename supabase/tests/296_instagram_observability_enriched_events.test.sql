begin;

select '1..2';

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values (
  '29600000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'instagram-296@example.com', 'x', now(), now(), now()
);
insert into public.organizations (id, name, slug, created_by)
values (
  '29600000-0000-4000-8000-000000000002',
  'Instagram 296', 'instagram-296', '29600000-0000-4000-8000-000000000001'
);
insert into public.organization_members (organization_id, user_id, role)
values (
  '29600000-0000-4000-8000-000000000002',
  '29600000-0000-4000-8000-000000000001', 'viewer'
);
insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, display_name, provider, encrypted_access_token, created_by
) values (
  '29600000-0000-4000-8000-000000000003',
  '29600000-0000-4000-8000-000000000002', 'ig-296', 'perfil_296', 'Perfil 296', 'meta_official', 'encrypted-test-token',
  '29600000-0000-4000-8000-000000000001'
);
insert into public.profile_groups (id, organization_id, name, created_by)
values (
  '29600000-0000-4000-8000-000000000004',
  '29600000-0000-4000-8000-000000000002', 'Grupo 296',
  '29600000-0000-4000-8000-000000000001'
);
insert into public.instagram_observability_events (
  occurred_at, organization_id, domain, severity, treatment_state, stage,
  event_type, stable_code, source_type, source_id, profile_id, source_group_id, message
) values (
  now(), '29600000-0000-4000-8000-000000000002', 'publication', 'info', 'resolved',
  'enriched_test', 'published', 'published', 'test_296', 'one',
  '29600000-0000-4000-8000-000000000003', '29600000-0000-4000-8000-000000000004', 'Publicado.'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
declare enriched record;
begin
  select * into enriched
  from public.instagram_observability_events_enriched
  where organization_id = '29600000-0000-4000-8000-000000000002'
    and stable_code = 'published';
  if enriched.profile_username <> 'perfil_296'
    or enriched.profile_display_name <> 'Perfil 296'
    or enriched.profile_provider <> 'meta_official'
    or enriched.source_group_name <> 'Grupo 296' then
    raise exception 'Evento não foi enriquecido corretamente.';
  end if;
end;
$$;
select 'ok 1 - projeção enriquece evento com dados seguros';

set local role authenticated;
select set_config('request.jwt.claim.sub', '29600000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
begin
  perform 1 from public.instagram_observability_events_enriched limit 1;
  raise exception 'Papel autenticado consultou a projeção interna.';
exception
  when insufficient_privilege then
    return;
end;
$$;
select 'ok 2 - projeção interna não é exposta diretamente ao cliente';

rollback;
