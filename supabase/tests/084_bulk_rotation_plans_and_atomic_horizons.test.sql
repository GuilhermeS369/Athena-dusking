-- Teste transacional da migration 084. Executar contra um banco descartável
-- que já contenha o schema até a migration 084.

begin;

create or replace function public.media_asset_has_storage_object(p_storage_path text)
returns boolean language sql stable security definer set search_path = public
as $$ select p_storage_path is not null $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, confirmed_at, created_at, updated_at)
values (
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'bulk-test@example.com', '', timezone('utc', now()),
  timezone('utc', now()), timezone('utc', now())
);

insert into public.organizations (id, name, slug, created_by)
values ('20000000-0000-0000-0000-000000000001', 'Organização teste bulk', 'organizacao-teste-bulk', '10000000-0000-0000-0000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'admin', '10000000-0000-0000-0000-000000000001');

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by
) values (
  '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
  'bulk-test-profile', 'bulk_test_profile', 'test-token', 'online', '10000000-0000-0000-0000-000000000001'
);

insert into public.media_assets (
  id, organization_id, uploaded_by, storage_path, original_name, mime_type, kind,
  size_bytes, checksum_sha256, status
) values (
  '40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001/bulk-test.jpg', 'bulk-test.jpg', 'image/jpeg', 'image',
  1024, repeat('a', 64), 'ready'
);

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values (
  '50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001', 'Fila anterior', 'queued', '2026-08-13T10:00:00Z'
);

insert into public.publication_items (
  id, organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key
) values (
  '60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
  'image', 'waiting', '2026-08-13T15:00:00Z', 'bulk-test-existing-queue-item'
);

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-0000-0000-000000000001';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.email = 'bulk-test@example.com';

do $$
declare
  first_result jsonb;
  repeated_result jsonb;
  second_result jsonb;
  first_plan_id uuid;
  second_plan_id uuid;
  first_profile public.bulk_publication_plan_profiles%rowtype;
  second_profile public.bulk_publication_plan_profiles%rowtype;
  first_count bigint;
begin
  first_result := public.create_bulk_rotation_plan(
    '20000000-0000-0000-0000-000000000001', 'bulk-test-request-0001', 'Primeiro lote',
    array['30000000-0000-0000-0000-000000000001'::uuid], 'ungrouped', null, 'image'::public.publication_format, 60, 1::bigint,
    E'Legenda\ncompartilhada', 'same_order', 'seed-primeiro', 1::smallint, 500, '2026-08-13T10:00:00Z'::timestamptz
  );
  first_plan_id := (first_result ->> 'planId')::uuid;
  if (first_result ->> 'created')::boolean is not true then raise exception 'primeiro plano deveria ser criado'; end if;
  if first_result ->> 'expectedPublications' <> '24' then raise exception 'projeção deveria ser 24'; end if;

  select * into first_profile from public.bulk_publication_plan_profiles where plan_id = first_plan_id;
  if first_profile.schedule_base_at <> '2026-08-13T15:00:00Z'::timestamptz then raise exception 'base não respeitou a fila ativa'; end if;
  if first_profile.first_execute_at <> '2026-08-13T16:00:00Z'::timestamptz then raise exception 'primeiro slot inválido'; end if;
  if first_profile.last_execute_at <> '2026-08-14T15:00:00Z'::timestamptz then raise exception 'último slot inválido'; end if;

  repeated_result := public.create_bulk_rotation_plan(
    '20000000-0000-0000-0000-000000000001', 'bulk-test-request-0001', 'Primeiro lote',
    array['30000000-0000-0000-0000-000000000001'::uuid], 'ungrouped', null, 'image'::public.publication_format, 60, 1::bigint,
    E'Legenda\ncompartilhada', 'same_order', 'seed-primeiro', 1::smallint, 500, '2026-08-13T10:00:00Z'::timestamptz
  );
  if (repeated_result ->> 'created')::boolean is not false then raise exception 'repetição deveria ser idempotente'; end if;
  if repeated_result ->> 'planId' <> first_plan_id::text then raise exception 'idempotência retornou outro plano'; end if;
  select count(*) into first_count from public.bulk_publication_plans where request_key = 'bulk-test-request-0001';
  if first_count <> 1 then raise exception 'idempotência duplicou plano'; end if;

  second_result := public.create_bulk_rotation_plan(
    '20000000-0000-0000-0000-000000000001', 'bulk-test-request-0002', 'Segundo lote',
    array['30000000-0000-0000-0000-000000000001'::uuid], 'ungrouped', null, 'image'::public.publication_format, 60, 1::bigint,
    null, 'diversified', 'seed-segundo', 1::smallint, 500, '2026-08-13T10:00:00Z'::timestamptz
  );
  second_plan_id := (second_result ->> 'planId')::uuid;
  select * into second_profile from public.bulk_publication_plan_profiles where plan_id = second_plan_id;
  if second_profile.schedule_base_at <> first_profile.last_execute_at then raise exception 'segundo plano sobrepôs horizonte'; end if;
  if second_profile.first_execute_at <> '2026-08-14T16:00:00Z'::timestamptz then raise exception 'segundo plano não anexou após horizonte'; end if;

  begin
    perform public.create_bulk_rotation_plan(
      '20000000-0000-0000-0000-000000000001', 'bulk-test-request-0001', 'Conteúdo diferente',
      array['30000000-0000-0000-0000-000000000001'::uuid], 'ungrouped', null, 'image'::public.publication_format, 60, 1::bigint,
      null, 'same_order', 'seed-primeiro', 1::smallint, 500, '2026-08-13T10:00:00Z'::timestamptz
    );
    raise exception 'chave reutilizada com conteúdo diferente deveria falhar';
  exception when unique_violation then null;
  end;

  update public.instagram_profiles set status = 'offline' where id = '30000000-0000-0000-0000-000000000001';
  begin
    perform public.create_bulk_rotation_plan(
      '20000000-0000-0000-0000-000000000001', 'bulk-test-request-0003', 'Perfil offline',
      array['30000000-0000-0000-0000-000000000001'::uuid], 'ungrouped', null, 'image'::public.publication_format, 60, 1::bigint,
      null, 'same_order', 'seed-terceiro', 1::smallint, 500, '2026-08-13T10:00:00Z'::timestamptz
    );
    raise exception 'perfil offline deveria provocar rollback';
  exception when raise_exception then
    if SQLERRM not like 'O conjunto de perfis mudou%' then raise; end if;
  end;
  if exists (select 1 from public.bulk_publication_plans where request_key = 'bulk-test-request-0003') then
    raise exception 'falha de snapshot deixou plano parcial';
  end if;
end;
$$;

reset role;
rollback;
