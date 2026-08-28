begin;
select '1..2';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values (
  '29800000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'instagram-298@example.com', '',
  now(), now(), now()
);

insert into public.organizations (id, name, slug, created_by)
values (
  '29800000-0000-4000-8000-000000000001',
  'Instagram 298',
  'instagram-298',
  '29800000-0000-4000-8000-000000000001'
);

insert into public.instagram_observability_events (
  occurred_at, organization_id, domain, severity, treatment_state, stage,
  event_type, stable_code, source_type, source_id, message
)
values (
  now() - interval '14 days 1 minute',
  '29800000-0000-4000-8000-000000000001',
  'publication', 'info', 'resolved', 'retention_test', 'old',
  'test_298', 'old', 'Antigo.'
);

select public.maintain_instagram_observability_hot_source('boundary_events', 14, 50);
do $$ begin
  if exists (select 1 from public.instagram_observability_events where source_type = 'test_298') then
    raise exception 'Evento vencido permaneceu na partição de borda.';
  end if;
end $$;
select 'ok 1 - fonte de borda remove somente evento vencido';

do $$ begin
  perform public.maintain_instagram_observability_hot_source('invalid', 14, 50);
  raise exception 'Fonte inválida foi aceita.';
exception when invalid_parameter_value then return;
end $$;
select 'ok 2 - fonte desconhecida é recusada';
rollback;
