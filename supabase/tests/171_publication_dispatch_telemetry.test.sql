-- Teste transacional da telemetria agregada de despacho. Executar em banco
-- descartável com schema até a migration 171.

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('17100000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'aleidar1010@gmail.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));

insert into public.organizations (id, name, slug, created_by)
values ('27100000-0000-0000-0000-000000000001', 'Organização telemetria', 'organizacao-telemetria-171', '17100000-0000-0000-0000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('27100000-0000-0000-0000-000000000001', '17100000-0000-0000-0000-000000000001', 'admin', '17100000-0000-0000-0000-000000000001');

insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, provider, status, created_by)
values
  ('37100000-0000-0000-0000-000000000001', '27100000-0000-0000-0000-000000000001', 'telemetry-meta', 'telemetry_meta', 'token', 'meta_official', 'online', '17100000-0000-0000-0000-000000000001'),
  ('37100000-0000-0000-0000-000000000002', '27100000-0000-0000-0000-000000000001', 'telemetry-zernio', 'telemetry_zernio', 'token', 'zernio', 'online', '17100000-0000-0000-0000-000000000001');

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values ('57100000-0000-0000-0000-000000000001', '27100000-0000-0000-0000-000000000001', '17100000-0000-0000-0000-000000000001', 'Lote telemetria', 'processing', timezone('utc', now()));

insert into public.publication_items (id, organization_id, batch_id, profile_id, format, status, execute_at, published_at, idempotency_key, last_error_code, last_error_message)
values
  ('97100000-0000-0000-0000-000000000001', '27100000-0000-0000-0000-000000000001', '57100000-0000-0000-0000-000000000001', '37100000-0000-0000-0000-000000000001', 'image', 'published', timezone('utc', now()) - interval '70 seconds', timezone('utc', now()) - interval '10 seconds', 'telemetry-published-171', null, null),
  ('97100000-0000-0000-0000-000000000002', '27100000-0000-0000-0000-000000000001', '57100000-0000-0000-0000-000000000001', '37100000-0000-0000-0000-000000000002', 'reel', 'failed', timezone('utc', now()) - interval '60 seconds', null, 'telemetry-failed-171', 'zernio_timeout', 'O provedor não respondeu dentro do limite.');

insert into public.publication_item_events (organization_id, publication_item_id, event_type, previous_status, status, error_code, error_message, created_at)
values
  ('27100000-0000-0000-0000-000000000001', '97100000-0000-0000-0000-000000000002', 'failed', 'publishing', 'failed', 'zernio_timeout', 'O provedor não respondeu dentro do limite.', timezone('utc', now()) - interval '5 seconds'),
  ('27100000-0000-0000-0000-000000000001', '97100000-0000-0000-0000-000000000001', 'processing_deferred', 'preparing', 'waiting', 'dispatch_rate_limit', 'A capacidade foi reservada para outra tentativa.', timezone('utc', now()) - interval '4 seconds');

set local role service_role;
set local request.jwt.claim.role = 'service_role';

select public.record_publication_worker_cycle_event(
  'a7100000-0000-0000-0000-000000000001', 'telemetry-worker', 'completed',
  timezone('utc', now()) - interval '2 seconds', timezone('utc', now()),
  '{"dispatch":{"claimed":2,"outcomes":{"published":1,"failed":1,"dispatch_rate_limit":1}}}'::jsonb
);

do $$
declare
  result jsonb;
begin
  result := public.get_publication_dispatch_telemetry('27100000-0000-0000-0000-000000000001', 24);

  if result ->> 'windowHours' <> '24' then raise exception 'janela de telemetria incorreta'; end if;
  if result #>> '{cycles,claimed_count}' <> '2' then raise exception 'claims de ciclos incorretos: %', result -> 'cycles'; end if;
  if result #>> '{cycles,rate_limited_count}' <> '1' then raise exception 'adiamentos por limite incorretos: %', result -> 'cycles'; end if;
  if not exists (
    select 1 from jsonb_array_elements(result -> 'providers') provider
    where provider ->> 'provider' = 'meta_official' and provider ->> 'published_count' = '1'
  ) then raise exception 'métrica Meta ausente: %', result -> 'providers'; end if;
  if not exists (
    select 1 from jsonb_array_elements(result -> 'errors') error
    where error ->> 'provider' = 'zernio' and error ->> 'error_code' = 'zernio_timeout' and error ->> 'total' = '1'
  ) then raise exception 'erro Zernio agrupado ausente: %', result -> 'errors'; end if;
end;
$$;

reset role;
rollback;
