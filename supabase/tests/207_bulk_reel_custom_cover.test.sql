-- Teste transacional das invariantes centrais da capa de Reel.
-- Executar contra banco descartável com migrations até 207.

begin;

create or replace function public.media_asset_has_storage_object(p_storage_path text)
returns boolean language sql stable security definer set search_path = public
as $$ select p_storage_path is not null $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, confirmed_at, created_at, updated_at)
values ('10700000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cover-test@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('20700000-0000-4000-8000-000000000001', 'Organização capa Reel', 'organizacao-capa-reel', '10700000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('20700000-0000-4000-8000-000000000001', '10700000-0000-4000-8000-000000000001', 'admin', '10700000-0000-4000-8000-000000000001');

insert into public.media_assets (id, organization_id, uploaded_by, storage_path, original_name, mime_type, kind, size_bytes, checksum_sha256, status)
values
  ('40700000-0000-4000-8000-000000000001', '20700000-0000-4000-8000-000000000001', '10700000-0000-4000-8000-000000000001', '20700000-0000-4000-8000-000000000001/capa.jpg', 'capa.jpg', 'image/jpeg', 'image', 1000, repeat('a', 64), 'ready'),
  ('40700000-0000-4000-8000-000000000002', '20700000-0000-4000-8000-000000000001', '10700000-0000-4000-8000-000000000001', '20700000-0000-4000-8000-000000000001/video.mp4', 'video.mp4', 'video/mp4', 'video', 1000, repeat('b', 64), 'ready');

do $$
begin
  if not public.bulk_reel_cover_is_eligible(
    '20700000-0000-4000-8000-000000000001',
    '40700000-0000-4000-8000-000000000001',
    'ungrouped', null
  ) then raise exception 'imagem pronta e sem grupo deveria ser elegível'; end if;

  if public.bulk_reel_cover_is_eligible(
    '20700000-0000-4000-8000-000000000001',
    '40700000-0000-4000-8000-000000000002',
    'ungrouped', null
  ) then raise exception 'vídeo não pode ser capa'; end if;
end;
$$;

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values ('50700000-0000-4000-8000-000000000001', '20700000-0000-4000-8000-000000000001', '10700000-0000-4000-8000-000000000001', 'Lote capa', 'queued', now());

insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by)
values ('30700000-0000-4000-8000-000000000001', '20700000-0000-4000-8000-000000000001', 'cover-profile', 'cover_profile', 'token', 'online', '10700000-0000-4000-8000-000000000001');

insert into public.publication_items (organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key, reel_cover_media_asset_id)
values ('20700000-0000-4000-8000-000000000001', '50700000-0000-4000-8000-000000000001', '30700000-0000-4000-8000-000000000001', 'reel', 'waiting', now() + interval '1 hour', 'cover-test-item-0001', '40700000-0000-4000-8000-000000000001');

do $$
begin
  if not public.media_asset_is_in_active_generation_job(
    '20700000-0000-4000-8000-000000000001',
    '40700000-0000-4000-8000-000000000001'
  ) then raise exception 'capa de item ativo precisa ficar protegida'; end if;

  begin
    insert into public.publication_items (organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key, reel_cover_media_asset_id)
    values ('20700000-0000-4000-8000-000000000001', '50700000-0000-4000-8000-000000000001', '30700000-0000-4000-8000-000000000001', 'story', 'waiting', now() + interval '2 hours', 'cover-test-item-0002', '40700000-0000-4000-8000-000000000001');
    raise exception 'Story com capa deveria ser rejeitado';
  exception when check_violation then null;
  end;
end;
$$;

rollback;
