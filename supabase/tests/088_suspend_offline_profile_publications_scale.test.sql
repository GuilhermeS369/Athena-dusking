-- Teste transacional de escala, plano compacto e corrida em voo da suspensão.
-- Executar em PostgreSQL 17 descartável com schema até as migrations 087/088.

begin;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'sub', nullif(current_setting('request.jwt.claim.sub', true), ''),
    'role', nullif(current_setting('request.jwt.claim.role', true), ''),
    'email', nullif(current_setting('request.jwt.claim.email', true), '')
  )
$$;

create or replace function public.media_asset_has_storage_object(p_storage_path text)
returns boolean language sql stable security definer set search_path = public
as $$ select p_storage_path is not null $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, confirmed_at, created_at, updated_at)
values (
  '13000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'suspension-scale@example.com', '', timezone('utc', now()),
  timezone('utc', now()), timezone('utc', now())
);
insert into public.organizations (id, name, slug, created_by)
values ('23000000-0000-0000-0000-000000000001', 'Organização suspensão em escala', 'suspensao-escala', '13000000-0000-0000-0000-000000000001');
insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('23000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', 'admin', '13000000-0000-0000-0000-000000000001');
insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by
) values
  ('33000000-0000-0000-0000-000000000001', '23000000-0000-0000-0000-000000000001', 'suspension-scale', 'suspension_scale', 'token', 'online', '13000000-0000-0000-0000-000000000001'),
  ('33000000-0000-0000-0000-000000000002', '23000000-0000-0000-0000-000000000001', 'suspension-compact', 'suspension_compact', 'token', 'online', '13000000-0000-0000-0000-000000000001'),
  ('33000000-0000-0000-0000-000000000003', '23000000-0000-0000-0000-000000000001', 'suspension-race', 'suspension_race', 'token', 'online', '13000000-0000-0000-0000-000000000001'),
  ('33000000-0000-0000-0000-000000000004', '23000000-0000-0000-0000-000000000001', 'suspension-creation-race', 'suspension_creation_race', 'token', 'online', '13000000-0000-0000-0000-000000000001');
insert into public.media_assets (
  id, organization_id, uploaded_by, storage_path, original_name, mime_type, kind,
  size_bytes, checksum_sha256, status
) values (
  '43000000-0000-0000-0000-000000000001', '23000000-0000-0000-0000-000000000001',
  '13000000-0000-0000-0000-000000000001', '23000000-0000-0000-0000-000000000001/suspension.jpg',
  'suspension.jpg', 'image/jpeg', 'image', 1024, repeat('c', 64), 'ready'
);

set local role authenticated;
set local request.jwt.claim.sub = '13000000-0000-0000-0000-000000000001';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.email = 'suspension-scale@example.com';

do $$
declare
  result jsonb;
begin
  result := public.create_bulk_rotation_plan(
    '23000000-0000-0000-0000-000000000001',
    'bulk-suspension-scale-request-0001',
    'Plano compacto suspenso',
    array['33000000-0000-0000-0000-000000000002'::uuid],
    'ungrouped', null, 'image'::public.publication_format,
    60, 1::bigint, null, 'same_order', 'seed-suspension-scale',
    1::smallint, 500, timezone('utc', now())
  );
  if result ->> 'expectedPublications' <> '24' then
    raise exception 'plano compacto deveria conter 24 slots';
  end if;
end;
$$;

reset role;

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values
  ('53000000-0000-0000-0000-000000000001', '23000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', 'Suspensão de 2.000 itens', 'queued', timezone('utc', now())),
  ('53000000-0000-0000-0000-000000000002', '23000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', 'Corrida em voo', 'queued', timezone('utc', now()));

insert into public.publication_items (
  organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key
)
select
  '23000000-0000-0000-0000-000000000001',
  '53000000-0000-0000-0000-000000000001',
  '33000000-0000-0000-0000-000000000001',
  'image', 'waiting',
  timezone('utc', now()) + interval '1 day' + (slot_number * interval '10 minutes'),
  'suspension-scale-' || lpad(slot_number::text, 8, '0')
from generate_series(1, 2000) slot_number;

insert into public.publication_items (
  id, organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key
) values
(
  '63000000-0000-0000-0000-000000000001',
  '23000000-0000-0000-0000-000000000001',
  '53000000-0000-0000-0000-000000000002',
  '33000000-0000-0000-0000-000000000003',
  'image', 'waiting', timezone('utc', now()) + interval '1 hour',
  'suspension-race-item-00000001'
),
(
  '63000000-0000-0000-0000-000000000002',
  '23000000-0000-0000-0000-000000000001',
  '53000000-0000-0000-0000-000000000002',
  '33000000-0000-0000-0000-000000000004',
  'image', 'waiting', timezone('utc', now()) + interval '2 hours',
  'suspension-creation-race-0001'
);

set local role service_role;
set local request.jwt.claim.role = 'service_role';

do $$
declare
  claimed record;
  compact_plan_id uuid;
  compact_chunk_id uuid;
  reference_summary jsonb;
  reconcile_result jsonb;
begin
  update public.instagram_profiles
  set status = 'offline', last_error_message = 'Perfil offline no teste de escala.'
  where id = '33000000-0000-0000-0000-000000000001';

  if (select count(*) from public.publication_items
      where profile_id = '33000000-0000-0000-0000-000000000001' and status = 'suspended') <> 2000 then
    raise exception 'transição offline não suspendeu os 2.000 itens';
  end if;
  if (select count(*) from public.publication_item_events event
      join public.publication_items item on item.id = event.publication_item_id
      where item.profile_id = '33000000-0000-0000-0000-000000000001'
        and event.event_type = 'suspended') <> 2000 then
    raise exception 'suspensão em escala não registrou um evento por item';
  end if;
  if exists (select 1 from public.claim_publication_items('worker-scale', 100, 120)
      where profile_id = '33000000-0000-0000-0000-000000000001') then
    raise exception 'claim varreu ou retomou item suspenso em escala';
  end if;

  select id into compact_plan_id
  from public.bulk_publication_plans
  where request_key = 'bulk-suspension-scale-request-0001';
  select id into compact_chunk_id
  from public.bulk_publication_generation_chunks
  where plan_id = compact_plan_id;

  update public.instagram_profiles
  set status = 'offline', last_error_message = 'Perfil compacto offline no teste.'
  where id = '33000000-0000-0000-0000-000000000002';

  if (select status from public.bulk_publication_generation_chunks where id = compact_chunk_id) <> 'paused' then
    raise exception 'trigger não pausou chunk compacto';
  end if;
  if (select status from public.bulk_publication_plan_profiles where plan_id = compact_plan_id) <> 'suspended' then
    raise exception 'trigger não suspendeu perfil do plano compacto';
  end if;
  if (select status from public.bulk_publication_plans where id = compact_plan_id) <> 'paused' then
    raise exception 'estado agregado do plano compacto não foi atualizado';
  end if;

  update public.publication_items
  set execute_at = timezone('utc', now()) - interval '30 seconds'
  where id = '63000000-0000-0000-0000-000000000001';

  select * into claimed
  from public.claim_publication_items('worker-race', 1, 120)
  where id = '63000000-0000-0000-0000-000000000001';
  if claimed.id is null then raise exception 'item da corrida não foi claimed'; end if;
  if not public.assert_claimed_publication_profile_online(claimed.id, 'worker-race') then
    raise exception 'barreira rejeitou perfil ainda online';
  end if;

  update public.instagram_profiles
  set status = 'offline', last_error_message = 'Perfil ficou offline durante a chamada externa.'
  where id = '33000000-0000-0000-0000-000000000003';
  if public.assert_claimed_publication_profile_online(claimed.id, 'worker-race') then
    raise exception 'barreira aceitou item já suspenso';
  end if;

  reconcile_result := public.reconcile_confirmed_publication_item(
    claimed.id, 'worker-race', 'provider-confirmed-media-id'
  );
  if reconcile_result ->> 'status' <> 'published'
    or (reconcile_result ->> 'reconciledFromSuspension')::boolean is not true then
    raise exception 'confirmação concorrente não foi reconciliada a partir da suspensão';
  end if;
  if (select status from public.publication_items where id = claimed.id) <> 'published' then
    raise exception 'item confirmado externamente não convergiu para published';
  end if;
  if (select count(*) from public.publication_item_events
      where publication_item_id = claimed.id and event_type = 'published') <> 1 then
    raise exception 'reconciliação não auditou publicação confirmada';
  end if;

  update public.publication_items
  set execute_at = timezone('utc', now()) - interval '30 seconds'
  where id = '63000000-0000-0000-0000-000000000002';
  select * into claimed
  from public.claim_publication_items('worker-creation-race', 1, 120)
  where id = '63000000-0000-0000-0000-000000000002';
  if claimed.id is null then raise exception 'item da corrida de criação não foi claimed'; end if;

  update public.instagram_profiles
  set status = 'offline', last_error_message = 'Perfil ficou offline após aceitar criação externa.'
  where id = '33000000-0000-0000-0000-000000000004';
  reconcile_result := public.reconcile_suspended_publication_creation(
    claimed.id, 'worker-creation-race', 'provider-accepted-creation-id'
  );
  if reconcile_result ->> 'status' <> 'suspended'
    or (reconcile_result ->> 'preservedWhileSuspended')::boolean is not true then
    raise exception 'criação externa não foi preservada no item suspenso';
  end if;
  if (select creation_id from public.publication_items where id = claimed.id)
      <> 'provider-accepted-creation-id' then
    raise exception 'identificador da criação externa não foi persistido';
  end if;
  if (select status from public.publication_items where id = claimed.id) <> 'suspended' then
    raise exception 'preservar criação externa retomou indevidamente o item';
  end if;

  reference_summary := public.get_publication_queue_reference_summary(
    '23000000-0000-0000-0000-000000000001'
  );
  if reference_summary #>> '{totals,suspended}' <> '2001'
    or reference_summary #>> '{totals,suspendedAccounts}' <> '2' then
    raise exception 'resumo de referência não expôs suspensões em escala';
  end if;
end;
$$;

reset role;
rollback;
