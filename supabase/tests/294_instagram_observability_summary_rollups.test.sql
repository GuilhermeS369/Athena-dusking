begin;

select '1..2';

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values (
  '29400000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'instagram-294@example.com', 'x', now(), now(), now()
);
insert into public.organizations (id, name, slug, created_by)
values (
  '29400000-0000-4000-8000-000000000002',
  'Instagram 294', 'instagram-294', '29400000-0000-4000-8000-000000000001'
);
insert into public.organization_members (organization_id, user_id, role)
values (
  '29400000-0000-4000-8000-000000000002',
  '29400000-0000-4000-8000-000000000001', 'viewer'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
insert into public.instagram_observability_events (
  occurred_at, organization_id, domain, severity, treatment_state, stage,
  event_type, stable_code, source_type, source_id, message
) values (
  now(), '29400000-0000-4000-8000-000000000002', 'publication', 'info', 'resolved',
  'summary_test', 'published', 'published', 'test_294', 'one', 'Publicado.'
);

select public.refresh_instagram_observability_rollups_recent(20);

do $$
begin
  if not exists (
    select 1 from public.instagram_observability_rollups_5m
    where organization_id = '29400000-0000-4000-8000-000000000002'
      and event_count = 1
  ) then
    raise exception 'Trigger não agregou o evento.';
  end if;
end;
$$;
select 'ok 1 - manutenção alimenta rollup de cinco minutos';

set local role authenticated;
select set_config('request.jwt.claim.sub', '29400000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare summary jsonb;
begin
  summary := public.get_instagram_observability_summary('29400000-0000-4000-8000-000000000002');
  if (summary ->> 'events24h')::bigint <> 1 then
    raise exception 'Resumo não leu o rollup: %', summary;
  end if;
end;
$$;
select 'ok 2 - resumo usa rollup e mantém autorização';

rollback;
