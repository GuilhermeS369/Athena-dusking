-- Teste transacional autocontido do encerramento terminal de perfil Meta.
-- Executar em banco descartável com schema até a migration 138.

begin;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  confirmed_at, created_at, updated_at
) values (
  '16000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'meta-terminal@example.com', '',
  timezone('utc', now()), timezone('utc', now()), timezone('utc', now())
);

insert into public.organizations (id, name, slug, created_by)
values (
  '26000000-0000-0000-0000-000000000001',
  'Organização teste terminal Meta',
  'organizacao-teste-terminal-meta',
  '16000000-0000-0000-0000-000000000001'
);

insert into public.organization_members (
  organization_id, user_id, role, invited_by
) values (
  '26000000-0000-0000-0000-000000000001',
  '16000000-0000-0000-0000-000000000001',
  'admin',
  '16000000-0000-0000-0000-000000000001'
);

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username,
  encrypted_access_token, provider, status, created_by
) values
  (
    '36000000-0000-0000-0000-000000000001',
    '26000000-0000-0000-0000-000000000001',
    'meta-terminal-profile', 'meta_terminal_profile',
    'encrypted-test-token', 'meta_official', 'online',
    '16000000-0000-0000-0000-000000000001'
  ),
  (
    '36000000-0000-0000-0000-000000000002',
    '26000000-0000-0000-0000-000000000001',
    'meta-unrelated-profile', 'meta_unrelated_profile',
    'encrypted-unrelated-token', 'meta_official', 'online',
    '16000000-0000-0000-0000-000000000001'
  );

insert into public.publication_batches (
  id, organization_id, created_by, name, status, review_confirmed_at
) values (
  '56000000-0000-0000-0000-000000000001',
  '26000000-0000-0000-0000-000000000001',
  '16000000-0000-0000-0000-000000000001',
  'Lote teste terminal Meta', 'processing', timezone('utc', now())
);

insert into public.publication_items (
  id, organization_id, batch_id, profile_id, format, status,
  execute_at, idempotency_key, attempt_count, meta_media_id, published_at
) values
  (
    '66000000-0000-0000-0000-000000000001',
    '26000000-0000-0000-0000-000000000001',
    '56000000-0000-0000-0000-000000000001',
    '36000000-0000-0000-0000-000000000001',
    'reel', 'waiting', timezone('utc', now()) - interval '1 minute',
    'meta-terminal-source-item-0001', 0, null, null
  ),
  (
    '66000000-0000-0000-0000-000000000002',
    '26000000-0000-0000-0000-000000000001',
    '56000000-0000-0000-0000-000000000001',
    '36000000-0000-0000-0000-000000000001',
    'image', 'failed', timezone('utc', now()) + interval '1 hour',
    'meta-terminal-pending-item-0002', 3, null, null
  ),
  (
    '66000000-0000-0000-0000-000000000003',
    '26000000-0000-0000-0000-000000000001',
    '56000000-0000-0000-0000-000000000001',
    '36000000-0000-0000-0000-000000000001',
    'story', 'published', timezone('utc', now()) - interval '2 hours',
    'meta-terminal-published-item-003', 1, 'meta-media-preserved',
    timezone('utc', now()) - interval '2 hours'
  ),
  (
    '66000000-0000-0000-0000-000000000004',
    '26000000-0000-0000-0000-000000000001',
    '56000000-0000-0000-0000-000000000001',
    '36000000-0000-0000-0000-000000000002',
    'image', 'waiting', timezone('utc', now()) + interval '2 hours',
    'meta-terminal-unrelated-item-0004', 0, null, null
  );

set local role service_role;
set local request.jwt.claim.role = 'service_role';

do $$
declare
  result jsonb;
  worker_id text := 'meta-terminal-test-worker';
  ignored_count integer;
  ignored_event_count integer;
begin
  update public.publication_items set
    status = 'preparing',
    claimed_by = worker_id,
    lease_until = timezone('utc', now()) + interval '3 minutes',
    attempt_count = attempt_count + 1,
    active_claim_consumed_attempt = true
  where id = '66000000-0000-0000-0000-000000000001';

  result := public.finalize_meta_profile_disconnection(
    '66000000-0000-0000-0000-000000000001',
    worker_id,
    '190',
    'Error validating access token: login required.',
    458
  );

  if result ->> 'completed' <> 'true'
    or result ->> 'idempotent' <> 'false'
    or (result ->> 'ignoredItemCount')::integer <> 2 then
    raise exception 'resultado terminal Meta inesperado: %', result;
  end if;

  if not coalesce((
    select deleted_at is not null
      and status = 'offline'
      and last_error_code = 'meta_profile_disconnected'
      and encrypted_access_token = 'encrypted-test-token'
    from public.instagram_profiles
    where id = '36000000-0000-0000-0000-000000000001'
  ), false) then
    raise exception 'perfil Meta não foi removido logicamente ou credencial histórica não foi preservada';
  end if;

  if exists (
    select 1 from public.publication_items item
    where item.profile_id = '36000000-0000-0000-0000-000000000001'
      and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')
      and item.meta_media_id is null
      and item.published_at is null
  ) then
    raise exception 'publicações pendentes do perfil Meta não foram ignoradas';
  end if;

  select count(*) into ignored_count
  from public.publication_items item
  where item.profile_id = '36000000-0000-0000-0000-000000000001'
    and item.status = 'ignored';
  if ignored_count <> 2 then
    raise exception 'quantidade de publicações Meta ignoradas divergente: %', ignored_count;
  end if;

  if not coalesce((
    select status = 'ignored'
      and attempt_count = 0
      and claimed_by is null
      and lease_until is null
      and active_claim_consumed_attempt is false
    from public.publication_items
    where id = '66000000-0000-0000-0000-000000000001'
  ), false) then
    raise exception 'item-fonte não liberou lease ou não devolveu a tentativa consumida pelo claim';
  end if;

  if not coalesce((
    select status = 'published'
      and meta_media_id = 'meta-media-preserved'
      and published_at is not null
    from public.publication_items
    where id = '66000000-0000-0000-0000-000000000003'
  ), false) then
    raise exception 'publicação já confirmada não foi preservada';
  end if;

  if not coalesce((
    select status = 'online' and deleted_at is null
    from public.instagram_profiles
    where id = '36000000-0000-0000-0000-000000000002'
  ), false)
  or (select status from public.publication_items
      where id = '66000000-0000-0000-0000-000000000004') <> 'waiting' then
    raise exception 'perfil ou item não relacionado foi alterado';
  end if;

  select count(*) into ignored_event_count
  from public.publication_item_events event
  where event.publication_item_id in (
    '66000000-0000-0000-0000-000000000001',
    '66000000-0000-0000-0000-000000000002'
  )
    and event.event_type = 'ignored'
    and event.error_code = 'meta_profile_disconnected';
  if ignored_event_count <> 2 then
    raise exception 'eventos ignored esperados=2 observados=%', ignored_event_count;
  end if;
end;
$$;

reset role;
rollback;
