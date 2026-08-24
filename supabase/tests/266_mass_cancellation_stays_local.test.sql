-- Cancelamento em massa permanece uma mutação local única. O teste não chama
-- Zernio, usa rollback e também cobre o bloqueio sem cancelamento parcial.

begin;

select plan(7);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('26600000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'cancel266@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));
insert into public.organizations (id, name, slug, created_by)
values ('26600000-0000-0000-0000-000000000002', 'Mass cancellation 266', 'mass-cancellation-266', '26600000-0000-0000-0000-000000000001');
insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by, provider, capabilities)
select gen_random_uuid(), '26600000-0000-0000-0000-000000000002', 'cancel-266-' || profile_number,
  'cancel_266_' || profile_number, 'synthetic-token', 'offline', '26600000-0000-0000-0000-000000000001',
  'meta_official', jsonb_build_object('synthetic', true, 'profileNumber', profile_number)
from generate_series(1, 1000) profile_number;
insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values ('26600000-0000-0000-0000-000000000004', '26600000-0000-0000-0000-000000000002', '26600000-0000-0000-0000-000000000001', 'Cancelar 1000 itens', 'queued', timezone('utc', now()));
insert into public.publication_items (organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key, pipeline_version)
select profile.organization_id, '26600000-0000-0000-0000-000000000004', profile.id,
  case when (profile.capabilities ->> 'profileNumber')::integer % 2 = 0 then 'story'::public.publication_format else 'reel'::public.publication_format end,
  'waiting', timezone('utc', now()) + interval '1 hour', 'cancel-266-item-000000-' || profile.id, 2
from public.instagram_profiles profile
where profile.organization_id = '26600000-0000-0000-0000-000000000002';

create temporary table cancellation_telemetry_266 as
select count(*)::bigint as total from public.zernio_publication_request_rollups;

update public.publication_items
set status = 'preparing', claimed_by = 'cancel-test-266', lease_until = timezone('utc', now()) + interval '3 minutes'
where id = (select id from public.publication_items where batch_id = '26600000-0000-0000-0000-000000000004' order by id limit 1);

insert into public.publication_queue_cancellation_operations (
  id, organization_id, requested_by, idempotency_key, scope, target_id
) values (
  '26600000-0000-0000-0000-000000000005', '26600000-0000-0000-0000-000000000002',
  '26600000-0000-0000-0000-000000000001', 'cancel-266-blocked-0001', 'batch', '26600000-0000-0000-0000-000000000004'
);

select is((public.execute_server_publication_queue_cancellation('26600000-0000-0000-0000-000000000005') ->> 'state'), 'blocked',
  'um item em processamento bloqueia o lote inteiro');
select is((select count(*)::bigint from public.publication_items where batch_id = '26600000-0000-0000-0000-000000000004' and status = 'waiting'), 999::bigint,
  'cancelamento bloqueado não altera os outros 999 itens');

update public.publication_items
set status = 'waiting', claimed_by = null, lease_until = null
where batch_id = '26600000-0000-0000-0000-000000000004' and status = 'preparing';
insert into public.publication_queue_cancellation_operations (
  id, organization_id, requested_by, idempotency_key, scope, target_id
) values (
  '26600000-0000-0000-0000-000000000006', '26600000-0000-0000-0000-000000000002',
  '26600000-0000-0000-0000-000000000001', 'cancel-266-complete-0001', 'batch', '26600000-0000-0000-0000-000000000004'
);

select is((public.execute_server_publication_queue_cancellation('26600000-0000-0000-0000-000000000006') ->> 'cancelledItems')::integer, 1000,
  'uma única execução local cancela os 1000 itens');
select is((select count(*)::bigint from public.publication_items where batch_id = '26600000-0000-0000-0000-000000000004' and status = 'cancelled'), 1000::bigint,
  'todos os itens terminam cancelados e verificados');
select is((select status::text from public.publication_batches where id = '26600000-0000-0000-0000-000000000004'), 'cancelled',
  'o lote também termina cancelado localmente');
select is((select count(*)::bigint from public.zernio_publication_request_rollups), (select total from cancellation_telemetry_266),
  'nenhuma requisição Zernio é registrada pelo cancelamento');
select ok((
  select pg_get_functiondef(procedure.oid)
  from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public' and procedure.proname = 'execute_server_publication_queue_cancellation'
) not ilike '%zernio%'
  and (
    select pg_get_functiondef(procedure.oid)
    from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.proname = 'execute_server_publication_queue_cancellation'
  ) not ilike '%http%'
  and (
    select pg_get_functiondef(procedure.oid)
    from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.proname = 'execute_server_publication_queue_cancellation'
  ) not ilike '%net.%',
  'executor de cancelamento não contém integração de rede/provedor');

select * from finish();
rollback;
