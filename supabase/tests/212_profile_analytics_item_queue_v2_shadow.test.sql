-- Testes transacionais da fila V2 por item em shadow mode.
-- Executar contra banco descartável com migrations até 212.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(1);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
)
values
  ('12000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'queue-v2-owner@example.com', '', now(), now(), now()),
  ('12000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'queue-v2-outsider@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values
  ('22000000-0000-4000-8000-000000000001', 'Queue V2 A', 'queue-v2-a', '12000000-0000-4000-8000-000000000001'),
  ('22000000-0000-4000-8000-000000000002', 'Queue V2 B', 'queue-v2-b', '12000000-0000-4000-8000-000000000002');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values
  ('22000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', 'admin', '12000000-0000-4000-8000-000000000001'),
  ('22000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-000000000002', 'admin', '12000000-0000-4000-8000-000000000002')
on conflict (organization_id, user_id) do nothing;

insert into public.zernio_connections (
  id, organization_id, label, encrypted_api_key, zernio_profile_id, status, created_by
)
values
  ('32000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'Queue V2 C1', repeat('a', 32), 'queue-v2-remote-1', 'online', '12000000-0000-4000-8000-000000000001'),
  ('32000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000001', 'Queue V2 C2', repeat('b', 32), 'queue-v2-remote-2', 'online', '12000000-0000-4000-8000-000000000001');

insert into public.zernio_connection_remote_profiles (
  organization_id, zernio_connection_id, zernio_profile_id,
  profile_name, kind, status, connected_at
)
values
  ('22000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000001', 'queue-v2-remote-1', 'Queue V2 C1', 'canonical', 'connected', now()),
  ('22000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000002', 'queue-v2-remote-2', 'Queue V2 C2', 'canonical', 'connected', now());

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username,
  encrypted_access_token, status, created_by, provider,
  zernio_profile_id, zernio_account_id, zernio_connection_id
)
values
  ('42000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'queue-v2-profile-1', 'queue_v2_p1', 'token', 'online', '12000000-0000-4000-8000-000000000001', 'zernio', 'queue-v2-remote-1', 'queue-v2-account-1', '32000000-0000-4000-8000-000000000001'),
  ('42000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000001', 'queue-v2-profile-2', 'queue_v2_p2', 'token', 'online', '12000000-0000-4000-8000-000000000001', 'zernio', 'queue-v2-remote-1', 'queue-v2-account-2', '32000000-0000-4000-8000-000000000001'),
  ('42000000-0000-4000-8000-000000000003', '22000000-0000-4000-8000-000000000001', 'queue-v2-profile-3', 'queue_v2_p3', 'token', 'online', '12000000-0000-4000-8000-000000000001', 'zernio', 'queue-v2-remote-2', 'queue-v2-account-3', '32000000-0000-4000-8000-000000000002');

insert into public.profile_analytics_refresh_jobs (
  id, organization_id, trigger, status, total_count
)
values (
  '52000000-0000-4000-8000-000000000001',
  '22000000-0000-4000-8000-000000000001',
  'manual',
  'pending',
  3
);

insert into public.profile_analytics_refresh_job_items (
  job_id, organization_id, profile_id, zernio_connection_id
)
values
  ('52000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000001'),
  ('52000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000002', '32000000-0000-4000-8000-000000000001'),
  ('52000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000003', '32000000-0000-4000-8000-000000000002');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  enqueue_row record;
  claim_a record;
  claim_b record;
  retry_claim record;
  completion_row record;
  second_completion record;
  retry_row record;
  rejected boolean;
  original_legacy_count integer;
begin
  select count(*) into original_legacy_count
  from public.profile_analytics_refresh_job_items
  where job_id = '52000000-0000-4000-8000-000000000001';

  select * into enqueue_row
  from public.enqueue_profile_analytics_refresh_v2_shadow_job(
    '52000000-0000-4000-8000-000000000001',
    array['current', 'daily']::text[]
  );

  if enqueue_row.inserted_count <> 6 or enqueue_row.total_count <> 6 then
    raise exception 'Shadow enqueue deveria criar seis itens: %', row_to_json(enqueue_row);
  end if;

  select * into enqueue_row
  from public.enqueue_profile_analytics_refresh_v2_shadow_job(
    '52000000-0000-4000-8000-000000000001',
    array['current', 'daily']::text[]
  );

  if enqueue_row.inserted_count <> 0 or enqueue_row.total_count <> 6 then
    raise exception 'Shadow enqueue não foi idempotente: %', row_to_json(enqueue_row);
  end if;

  if (select count(*) from public.profile_analytics_refresh_job_items where job_id = '52000000-0000-4000-8000-000000000001') <> original_legacy_count then
    raise exception 'Shadow enqueue alterou a fila legada.';
  end if;

  select * into claim_a
  from public.claim_profile_analytics_refresh_v2_item('queue-v2-worker-a', 300, 1, 'shadow');
  select * into claim_b
  from public.claim_profile_analytics_refresh_v2_item('queue-v2-worker-b', 300, 1, 'shadow');

  if claim_a.item_id is null or claim_b.item_id is null then
    raise exception 'Dois workers não conseguiram colaborar no mesmo job.';
  end if;
  if claim_a.legacy_job_id is distinct from claim_b.legacy_job_id then
    raise exception 'Claims de colaboração não pertencem ao mesmo job legado.';
  end if;
  if claim_a.connection_key = claim_b.connection_key then
    raise exception 'Fairness/limite por conexão não distribuiu os dois primeiros claims.';
  end if;

  rejected := false;
  begin
    perform public.complete_profile_analytics_refresh_v2_item(
      claim_a.item_id,
      'queue-v2-worker-b',
      claim_a.lease_token,
      'shadow_observed',
      false, null, null, null, 5,
      '{"test":"wrong-worker"}'::jsonb
    );
  exception when sqlstate '55000' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'Conclusão por worker sem lease não foi rejeitada.';
  end if;

  select * into completion_row
  from public.complete_profile_analytics_refresh_v2_item(
    claim_a.item_id,
    'queue-v2-worker-a',
    claim_a.lease_token,
    'shadow_observed',
    false, null, null, null, 7,
    '{"test":"shadow"}'::jsonb
  );

  if completion_row.status <> 'completed' or completion_row.idempotent then
    raise exception 'Conclusão shadow inválida: %', row_to_json(completion_row);
  end if;

  select * into second_completion
  from public.complete_profile_analytics_refresh_v2_item(
    claim_a.item_id,
    'queue-v2-worker-a',
    claim_a.lease_token,
    'shadow_observed',
    false, null, null, null, 7,
    '{"test":"shadow"}'::jsonb
  );

  if not second_completion.idempotent or second_completion.status <> 'completed' then
    raise exception 'Conclusão repetida não foi idempotente: %', row_to_json(second_completion);
  end if;

  if not exists (
    select 1
    from public.profile_analytics_source_watermarks watermark
    where watermark.organization_id = claim_a.organization_id
      and watermark.profile_id = claim_a.profile_id
      and watermark.source_class = claim_a.source_class
      and watermark.last_shadow_observed_at is not null
      and watermark.last_success_at is null
  ) then
    raise exception 'Watermark shadow não foi registrada corretamente.';
  end if;

  select * into retry_row
  from public.complete_profile_analytics_refresh_v2_item(
    claim_b.item_id,
    'queue-v2-worker-b',
    claim_b.lease_token,
    'error',
    true, 'timeout', 'ETIMEDOUT', 'timeout simulado', 10,
    '{"test":"retry"}'::jsonb
  );

  if retry_row.status <> 'retry_pending' or retry_row.next_attempt_at is null then
    raise exception 'Retry exponencial não foi agendado: %', row_to_json(retry_row);
  end if;

  update public.profile_analytics_refresh_v2_items
  set status = 'cancelled',
      completed_at = timezone('utc', now())
  where id <> claim_b.item_id
    and status in ('pending', 'retry_pending');

  update public.profile_analytics_refresh_v2_items
  set available_at = timezone('utc', now()) - interval '1 second'
  where id = claim_b.item_id;

  select * into retry_claim
  from public.claim_profile_analytics_refresh_v2_item('queue-v2-worker-c', 300, 1, 'shadow');

  if retry_claim.item_id is distinct from claim_b.item_id or retry_claim.attempts <> 2 then
    raise exception 'Item retryable não foi reclamado corretamente: %', row_to_json(retry_claim);
  end if;

  rejected := false;
  begin
    perform public.complete_profile_analytics_refresh_v2_item(
      retry_claim.item_id,
      'queue-v2-worker-c',
      retry_claim.lease_token,
      'succeeded',
      false, null, null, null, 1, '{}'::jsonb
    );
  exception when sqlstate '22023' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'Shadow mode aceitou resultado de escrita real.';
  end if;

  update public.profile_analytics_refresh_v2_items
  set lease_until = timezone('utc', now()) - interval '1 second'
  where id = retry_claim.item_id;

  select * into retry_claim
  from public.claim_profile_analytics_refresh_v2_item('queue-v2-worker-d', 300, 1, 'shadow');

  if retry_claim.item_id is distinct from claim_b.item_id or retry_claim.attempts <> 3 then
    raise exception 'Lease expirado não foi recuperado por outro worker: %', row_to_json(retry_claim);
  end if;

  perform public.complete_profile_analytics_refresh_v2_item(
    retry_claim.item_id,
    'queue-v2-worker-d',
    retry_claim.lease_token,
    'shadow_observed',
    false, null, null, null, 2,
    '{"test":"lease-recovered"}'::jsonb
  );

  if not exists (
    select 1
    from public.profile_analytics_refresh_v2_item_events event
    where event.item_id = retry_claim.item_id
      and event.event_type = 'lease_recovered'
      and event.worker_id = 'queue-v2-worker-d'
  ) then
    raise exception 'Evento de recuperação de lease não foi persistido.';
  end if;

  if exists (
    select 1
    from public.profile_analytics_source_watermarks
    where last_success_at is not null
  ) then
    raise exception 'Shadow mode gravou sucesso analítico real.';
  end if;
end;
$$;

reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '12000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"12000000-0000-4000-8000-000000000002"}', true);

do $$
declare
  rejected boolean := false;
begin
  begin
    perform public.enqueue_profile_analytics_refresh_v2_shadow_job(
      '52000000-0000-4000-8000-000000000001',
      array['current']::text[]
    );
  exception when sqlstate '42501' then
    rejected := true;
  end;

  if not rejected then
    raise exception 'Usuário de outra organização conseguiu enfileirar shadow items.';
  end if;
end;
$$;

reset role;
select extensions.pass('fila V2 shadow passou colaboração, fairness, lease, retry, idempotência e isolamento');
select * from extensions.finish();

rollback;
