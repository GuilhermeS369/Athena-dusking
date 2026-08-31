begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(23);

select extensions.has_function(
  'public', 'enqueue_instagram_profile_removal', array['uuid','uuid[]','text'],
  'RPC de enfileiramento da exclusão existe'
);
select extensions.has_function(
  'public', 'preview_instagram_profile_removal', array['uuid','uuid[]'],
  'RPC de resumo da exclusão existe'
);
select extensions.has_function(
  'public', 'list_instagram_profiles_catalog_ids',
  -- A migration 344 acrescentou p_created_on ao final da assinatura.
  array['uuid','integer','text','uuid','text','text','text','date'],
  'RPC de ids do filtro existe'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.contain_instagram_profile_for_removal(uuid,uuid,uuid,text,text,text,boolean)',
    'EXECUTE'
  ),
  'contenção direta não é exposta ao usuário autenticado'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  ('14200000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'removal-342-admin@example.com', '', now(), now(), now()),
  ('14200000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'removal-342-viewer@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('24200000-0000-4000-8000-000000000001', 'Remoção 342', 'remocao-342', '14200000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by) values
  ('24200000-0000-4000-8000-000000000001', '14200000-0000-4000-8000-000000000001', 'admin', '14200000-0000-4000-8000-000000000001'),
  ('24200000-0000-4000-8000-000000000001', '14200000-0000-4000-8000-000000000002', 'viewer', '14200000-0000-4000-8000-000000000001');

insert into public.zernio_connections (
  id, organization_id, label, encrypted_api_key, zernio_profile_id, status, created_by
) values (
  '34200000-0000-4000-8000-000000000001', '24200000-0000-4000-8000-000000000001',
  'Chave 342', 'encrypted-api-key-teste-342', 'zernio-profile-342', 'online',
  '14200000-0000-4000-8000-000000000001'
);

-- O trigger enforce_zernio_profile_connection_pair exige que o profileId remoto
-- esteja no pool da conexão com status claimed/connected.
insert into public.zernio_connection_remote_profiles (
  organization_id, zernio_connection_id, zernio_profile_id, kind, status
) values (
  '24200000-0000-4000-8000-000000000001', '34200000-0000-4000-8000-000000000001',
  'zernio-profile-342', 'canonical', 'connected'
);

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, status, created_by,
  provider, zernio_connection_id, zernio_profile_id, zernio_account_id
) values (
  '44200000-0000-4000-8000-000000000001', '24200000-0000-4000-8000-000000000001',
  'ig-342-zernio', 'conta_zernio_342', 'online', '14200000-0000-4000-8000-000000000001',
  'zernio', '34200000-0000-4000-8000-000000000001', 'zernio-profile-342', 'zernio-account-342'
);

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by
) values (
  '44200000-0000-4000-8000-000000000002', '24200000-0000-4000-8000-000000000001',
  'ig-342-meta', 'conta_meta_342', 'token', 'online', '14200000-0000-4000-8000-000000000001'
);

insert into public.profile_groups (id, organization_id, name, created_by)
values ('54200000-0000-4000-8000-000000000001', '24200000-0000-4000-8000-000000000001', 'Grupo 342', '14200000-0000-4000-8000-000000000001');

insert into public.profile_group_members (organization_id, group_id, profile_id, added_by) values
  ('24200000-0000-4000-8000-000000000001', '54200000-0000-4000-8000-000000000001', '44200000-0000-4000-8000-000000000001', '14200000-0000-4000-8000-000000000001'),
  ('24200000-0000-4000-8000-000000000001', '54200000-0000-4000-8000-000000000001', '44200000-0000-4000-8000-000000000002', '14200000-0000-4000-8000-000000000001');

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values ('64200000-0000-4000-8000-000000000001', '24200000-0000-4000-8000-000000000001',
  '14200000-0000-4000-8000-000000000001', 'Lote 342', 'queued', timezone('utc', now()));

insert into public.publication_items (
  id, organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key
) values
  ('74200000-0000-4000-8000-000000000001', '24200000-0000-4000-8000-000000000001', '64200000-0000-4000-8000-000000000001', '44200000-0000-4000-8000-000000000001', 'image', 'waiting', timezone('utc', now()) + interval '1 hour', 'removal-342-item-0001'),
  ('74200000-0000-4000-8000-000000000002', '24200000-0000-4000-8000-000000000001', '64200000-0000-4000-8000-000000000001', '44200000-0000-4000-8000-000000000002', 'image', 'waiting', timezone('utc', now()) + interval '2 hours', 'removal-342-item-0002');

set local role authenticated;
set local request.jwt.claim.sub = '14200000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.email = 'removal-342-admin@example.com';

-- Resumo antes de qualquer mutação -------------------------------------------

select extensions.is(
  (select total from public.preview_instagram_profile_removal(
    '24200000-0000-4000-8000-000000000001',
    array['44200000-0000-4000-8000-000000000001', '44200000-0000-4000-8000-000000000002']::uuid[]
  )),
  2,
  'o resumo enxerga os dois perfis'
);
select extensions.is(
  (select zernio_count from public.preview_instagram_profile_removal(
    '24200000-0000-4000-8000-000000000001',
    array['44200000-0000-4000-8000-000000000001', '44200000-0000-4000-8000-000000000002']::uuid[]
  )),
  1,
  'o resumo separa quem passa pela Zernio'
);
select extensions.is(
  (select connection_labels from public.preview_instagram_profile_removal(
    '24200000-0000-4000-8000-000000000001',
    array['44200000-0000-4000-8000-000000000001']::uuid[]
  )),
  array['Chave 342'],
  'o resumo nomeia a chave Zernio afetada'
);
select extensions.is(
  (select pending_item_count from public.preview_instagram_profile_removal(
    '24200000-0000-4000-8000-000000000001',
    array['44200000-0000-4000-8000-000000000001', '44200000-0000-4000-8000-000000000002']::uuid[]
  )),
  2,
  'o resumo conta as publicações que serão canceladas'
);

-- Ids do filtro batem com o total do resumo do catálogo -----------------------

select extensions.is(
  (select count(*)::integer from public.list_instagram_profiles_catalog_ids('24200000-0000-4000-8000-000000000001')),
  (select filtered_total::integer from public.get_instagram_profiles_catalog_summary('24200000-0000-4000-8000-000000000001')),
  'ids do filtro batem com o total filtrado do catálogo'
);

-- Enfileiramento ---------------------------------------------------------------

create temporary table removal_342_outcomes on commit drop as
select * from public.enqueue_instagram_profile_removal(
  '24200000-0000-4000-8000-000000000001',
  array['44200000-0000-4000-8000-000000000001', '44200000-0000-4000-8000-000000000002']::uuid[],
  'operator: teste 342'
);

select extensions.is(
  (select removed_outcome from removal_342_outcomes where removed_profile_id = '44200000-0000-4000-8000-000000000001'),
  'queued',
  'perfil Zernio entra na fila de remoção remota'
);
select extensions.is(
  (select removed_outcome from removal_342_outcomes where removed_profile_id = '44200000-0000-4000-8000-000000000002'),
  'deleted_local',
  'perfil Meta é finalizado localmente'
);

select extensions.is(
  (select signal from public.zernio_profile_disconnection_incidents
    where profile_id = '44200000-0000-4000-8000-000000000001'),
  'operator_requested',
  'o incidente registra o sinal do operador'
);
select extensions.is(
  (select count(*)::integer from public.zernio_profile_recycling_jobs job
     join public.zernio_profile_disconnection_incidents incident on incident.id = job.incident_id
    where incident.profile_id = '44200000-0000-4000-8000-000000000001' and job.status = 'pending'),
  1,
  'existe exatamente um job pendente para o perfil Zernio'
);

-- O perfil Zernio NÃO pode sumir antes do DELETE remoto: some-lo aqui daria a
-- impressão de que a vaga da chave já foi liberada.
select extensions.ok(
  (select deleted_at is null from public.instagram_profiles where id = '44200000-0000-4000-8000-000000000001'),
  'perfil Zernio segue vivo até o worker confirmar a remoção remota'
);
select extensions.is(
  (select status::text from public.instagram_profiles where id = '44200000-0000-4000-8000-000000000001'),
  'offline',
  'perfil Zernio é contido imediatamente'
);
select extensions.ok(
  (select deleted_at is not null from public.instagram_profiles where id = '44200000-0000-4000-8000-000000000002'),
  'perfil Meta já sai do catálogo'
);
select extensions.is(
  (select count(*)::integer from public.profile_group_members where profile_id = '44200000-0000-4000-8000-000000000002'),
  0,
  'perfil Meta é desvinculado dos grupos'
);
select extensions.is(
  (select count(*)::integer from public.publication_items
    where batch_id = '64200000-0000-4000-8000-000000000001' and status = 'ignored'),
  2,
  'as publicações em fila dos dois perfis saem de circulação'
);

-- Exclusão pedida pelo operador não é queda de perfil e não pode contar como tal.
select extensions.is(
  (select count(*)::integer from public.zernio_group_profile_removal_events),
  0,
  'o contador de quedas de perfil ignora a exclusão pedida pelo operador'
);

-- Reenfileirar é idempotente ---------------------------------------------------

select extensions.is(
  (select removed_outcome from public.enqueue_instagram_profile_removal(
    '24200000-0000-4000-8000-000000000001',
    array['44200000-0000-4000-8000-000000000001']::uuid[]
  )),
  'already_queued',
  'reenviar a mesma seleção não cria um segundo pedido'
);
select extensions.is(
  (select count(*)::integer from public.zernio_profile_recycling_jobs job
     join public.zernio_profile_disconnection_incidents incident on incident.id = job.incident_id
    where incident.profile_id = '44200000-0000-4000-8000-000000000001'),
  1,
  'continua existindo um único job para o perfil'
);
select extensions.is(
  (select removed_outcome from public.enqueue_instagram_profile_removal(
    '24200000-0000-4000-8000-000000000001',
    array['44200000-0000-4000-8000-000000000002']::uuid[]
  )),
  'skipped_not_found',
  'perfil já excluído é ignorado em vez de reprocessado'
);

-- Papel ------------------------------------------------------------------------

set local request.jwt.claim.sub = '14200000-0000-4000-8000-000000000002';
set local request.jwt.claim.email = 'removal-342-viewer@example.com';

select extensions.throws_ok(
  $$select * from public.enqueue_instagram_profile_removal(
      '24200000-0000-4000-8000-000000000001',
      array['44200000-0000-4000-8000-000000000001']::uuid[]
    )$$,
  '42501',
  null,
  'viewer não consegue excluir perfis'
);

select * from extensions.finish();
rollback;
