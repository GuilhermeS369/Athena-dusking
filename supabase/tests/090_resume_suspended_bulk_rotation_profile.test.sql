-- Retomada compacta: preserva índice original da rotação e redistribui apenas
-- o restante do perfil selecionado depois de uma pausa parcial.

begin;

create or replace function auth.jwt()
returns jsonb language sql stable as $$
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
values ('15000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'resume-bulk@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));
insert into public.organizations (id, name, slug, created_by)
values ('25000000-0000-0000-0000-000000000001', 'Retomada compacta', 'retomada-compacta', '15000000-0000-0000-0000-000000000001');
insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('25000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-000000000001', 'admin', '15000000-0000-0000-0000-000000000001');
insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by)
values ('35000000-0000-0000-0000-000000000001', '25000000-0000-0000-0000-000000000001', 'resume-bulk', 'resume_bulk', 'token', 'online', '15000000-0000-0000-0000-000000000001');
insert into public.media_assets (id, organization_id, uploaded_by, storage_path, original_name, mime_type, kind, size_bytes, checksum_sha256, status)
values
  ('45000000-0000-0000-0000-000000000001', '25000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-000000000001', '25000000-0000-0000-0000-000000000001/a.jpg', 'a.jpg', 'image/jpeg', 'image', 100, repeat('a', 64), 'ready'),
  ('45000000-0000-0000-0000-000000000002', '25000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-000000000001', '25000000-0000-0000-0000-000000000001/b.jpg', 'b.jpg', 'image/jpeg', 'image', 100, repeat('b', 64), 'ready');

set local role authenticated;
set local request.jwt.claim.sub = '15000000-0000-0000-0000-000000000001';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.email = 'resume-bulk@example.com';

do $$
declare
  created jsonb;
  resolved_plan_id uuid;
  resolved_batch_id uuid;
  resolved_chunk_id uuid;
  result jsonb;
  claimed record;
begin
  created := public.create_bulk_rotation_plan(
    '25000000-0000-0000-0000-000000000001', 'resume-bulk-request-00000001',
    'Plano retomável', array['35000000-0000-0000-0000-000000000001'::uuid],
    'ungrouped', null, 'image'::public.publication_format, 360, 1::bigint, null,
    'same_order', 'resume-bulk-seed', 1::smallint, 500,
    '2026-08-13T22:00:00Z'::timestamptz
  );
  resolved_plan_id := (created ->> 'planId')::uuid;
  resolved_batch_id := (created ->> 'batchId')::uuid;

  set local role service_role;
  select * into claimed from public.claim_bulk_rotation_generation_chunks('resume-bulk-worker', 1, 300, 3);
  resolved_chunk_id := claimed.id;
  perform public.process_bulk_rotation_generation_chunk(resolved_chunk_id, 'resume-bulk-worker', 2);

  update public.instagram_profiles set status = 'offline'
  where id = '35000000-0000-0000-0000-000000000001';
  update public.instagram_profiles set status = 'online'
  where id = '35000000-0000-0000-0000-000000000001';

  result := public.resume_suspended_batch_profile_publications(
    '25000000-0000-0000-0000-000000000001', resolved_batch_id,
    '35000000-0000-0000-0000-000000000001', '2026-08-14T12:00:00Z',
    'resume-bulk@example.com'
  );

  if result ->> 'resumedCompactSlots' <> '2' or result ->> 'ignoredItems' <> '2' then
    raise exception 'retomada compacta deveria encerrar 2 materializados vencidos e preservar 2 slots restantes: %', result;
  end if;
  if (select next_slot_index from public.bulk_publication_plan_profiles where plan_id = resolved_plan_id) <> 2 then
    raise exception 'cursor original da rotação não foi preservado';
  end if;
  if (select schedule_base_at from public.bulk_publication_plan_profiles where plan_id = resolved_plan_id) <> '2026-08-14T00:00:00Z'::timestamptz then
    raise exception 'base compacta não foi deslocada para preservar os índices originais';
  end if;
  if (select first_execute_at from public.bulk_publication_plan_profiles where plan_id = resolved_plan_id) <> '2026-08-14T18:00:00Z'::timestamptz
    or (select last_execute_at from public.bulk_publication_plan_profiles where plan_id = resolved_plan_id) <> '2026-08-15T00:00:00Z'::timestamptz then
    raise exception 'restante compacto não foi redistribuído a partir de now + intervalo';
  end if;
  if (select resume_count from public.bulk_publication_plan_profiles where plan_id = resolved_plan_id) <> 1 then
    raise exception 'contador de retomada compacta não foi incrementado';
  end if;
end;
$$;

reset role;
rollback;
