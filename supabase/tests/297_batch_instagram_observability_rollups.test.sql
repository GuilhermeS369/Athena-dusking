begin;

select '1..3';

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values (
  '29700000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'instagram-297@example.com', 'x', now(), now(), now()
);
insert into public.organizations (id, name, slug, created_by)
values (
  '29700000-0000-4000-8000-000000000002',
  'Instagram 297', 'instagram-297', '29700000-0000-4000-8000-000000000001'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
insert into public.instagram_observability_events (
  occurred_at, organization_id, domain, severity, treatment_state, stage,
  event_type, stable_code, source_type, source_id, message
) values (
  now(), '29700000-0000-4000-8000-000000000002', 'publication', 'info', 'resolved',
  'summary_test', 'published', 'published', 'test_297', 'one', 'Publicado.'
);

do $$
begin
  if exists (
    select 1 from public.instagram_observability_rollups_5m
    where organization_id = '29700000-0000-4000-8000-000000000002'
  ) then
    raise exception 'Insert ainda atualizou rollup de forma síncrona.';
  end if;
end;
$$;
select 'ok 1 - evento não disputa o bucket agregado no caminho de escrita';

select public.refresh_instagram_observability_rollups_recent(20);
do $$
begin
  if not exists (
    select 1 from public.instagram_observability_rollups_5m
    where organization_id = '29700000-0000-4000-8000-000000000002'
      and event_count = 1
  ) then
    raise exception 'Atualização em lote não agregou o evento.';
  end if;
end;
$$;
select 'ok 2 - manutenção agrega a janela recente em lote';

select public.refresh_instagram_observability_rollups_recent(20);
do $$
begin
  if (select event_count from public.instagram_observability_rollups_5m
      where organization_id = '29700000-0000-4000-8000-000000000002' limit 1) <> 1 then
    raise exception 'Atualização em lote não foi idempotente.';
  end if;
end;
$$;
select 'ok 3 - reprocessamento do bucket é idempotente';

rollback;
