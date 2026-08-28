begin;
select '1..3';

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values (
  '29900000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'instagram-299@example.com', '',
  now(), now(), now()
);
insert into public.organizations (id, name, slug, created_by)
values (
  '29900000-0000-4000-8000-000000000001',
  'Instagram 299', 'instagram-299',
  '29900000-0000-4000-8000-000000000001'
);
insert into public.organization_members (organization_id, user_id, role, invited_by)
values (
  '29900000-0000-4000-8000-000000000001',
  '29900000-0000-4000-8000-000000000001',
  'admin', '29900000-0000-4000-8000-000000000001'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.refresh_instagram_observability_summary_snapshots(
  '29900000-0000-4000-8000-000000000001'
);

do $$ begin
  if not exists (
    select 1 from public.instagram_observability_summary_snapshots
    where organization_id = '29900000-0000-4000-8000-000000000001'
      and events_24h = 0
  ) then
    raise exception 'Snapshot inicial não foi criado.';
  end if;
end $$;
select 'ok 1 - recomposição cria snapshot por organização';

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '29900000-0000-4000-8000-000000000001', true);
do $$ declare summary jsonb; begin
  summary := public.get_instagram_observability_summary('29900000-0000-4000-8000-000000000001');
  if summary #>> '{events24h}' <> '0' or summary #>> '{workers,expected}' <> '5' then
    raise exception 'Resumo não leu snapshot e workers esperados: %', summary;
  end if;
end $$;
select 'ok 2 - leitura combina snapshot com saúde viva dos workers';

do $$ begin
  perform public.refresh_instagram_observability_summary_snapshots(
    '29900000-0000-4000-8000-000000000001'
  );
  raise exception 'Usuário autenticado recompôs snapshot.';
exception when insufficient_privilege then return;
end $$;
select 'ok 3 - recomposição permanece exclusiva do serviço';

rollback;
