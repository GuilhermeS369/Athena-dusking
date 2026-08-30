-- Cobre o arquivo frio da migration 333.
--
-- O caso mais importante é o 3: a mídia do item precisa SOBREVIVER à mudança.
-- A FK original é `on delete cascade`, então um "mover" ingênuo apagaria
-- `publication_item_media` junto com o item — 474 mil linhas que registram qual
-- mídia foi publicada. É a perda silenciosa que este desenho existe para evitar.

begin;

select plan(13);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('33300000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'cold333@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));

insert into public.organizations (id, name, slug, created_by)
values ('33300000-0000-0000-0000-000000000002', 'Cold 333', 'cold-333', '33300000-0000-0000-0000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('33300000-0000-0000-0000-000000000002', '33300000-0000-0000-0000-000000000001', 'admin', '33300000-0000-0000-0000-000000000001');

-- Segunda organização: prova que o movimento é escopado.
insert into public.organizations (id, name, slug, created_by)
values ('33300000-0000-0000-0000-000000000003', 'Cold 333 vizinha', 'cold-333-vizinha', '33300000-0000-0000-0000-000000000001');

insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by, provider)
values
  ('33300000-0000-0000-0000-00000000000a', '33300000-0000-0000-0000-000000000002', 'cold-333-a', 'cold_333_a', 'synthetic-token', 'online', '33300000-0000-0000-0000-000000000001', 'meta_official'),
  ('33300000-0000-0000-0000-00000000000b', '33300000-0000-0000-0000-000000000003', 'cold-333-b', 'cold_333_b', 'synthetic-token', 'online', '33300000-0000-0000-0000-000000000001', 'meta_official');

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values
  ('33300000-0000-0000-0000-000000000004', '33300000-0000-0000-0000-000000000002', '33300000-0000-0000-0000-000000000001', 'Lote 333', 'processing', timezone('utc', now())),
  ('33300000-0000-0000-0000-000000000005', '33300000-0000-0000-0000-000000000003', '33300000-0000-0000-0000-000000000001', 'Lote 333 vizinho', 'processing', timezone('utc', now()));

insert into public.media_assets (id, organization_id, uploaded_by, original_name, mime_type, kind, size_bytes, storage_path, checksum_sha256, status)
values ('33300000-0000-0000-0000-0000000000f1', '33300000-0000-0000-0000-000000000002',
  '33300000-0000-0000-0000-000000000001', 'cold333.mp4', 'video/mp4', 'video', 1024,
  'cold-333/f1.mp4', repeat('a', 64), 'ready');

-- `auth.role()` lê o claim do JWT, não o papel do Postgres — então `set local
-- role` sozinho não satisfaz a guarda da função.
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

-- Item A: arquivado há 30 dias, COM mídia. Deve mover, e a mídia deve sobreviver.
insert into public.publication_items (id, organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key, published_at, archived_at)
values ('33300000-0000-0000-0000-0000000000c1', '33300000-0000-0000-0000-000000000002',
  '33300000-0000-0000-0000-000000000004', '33300000-0000-0000-0000-00000000000a', 'reel', 'published',
  timezone('utc', now()) - interval '31 days', 'cold-333-antigo-com-midia',
  timezone('utc', now()) - interval '31 days', timezone('utc', now()) - interval '30 days');

insert into public.publication_item_media (organization_id, publication_item_id, media_asset_id, position)
values ('33300000-0000-0000-0000-000000000002', '33300000-0000-0000-0000-0000000000c1',
  '33300000-0000-0000-0000-0000000000f1', 0);

-- Item B: arquivado há 2 dias. NÃO deve mover — está dentro da retenção.
insert into public.publication_items (id, organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key, published_at, archived_at)
values ('33300000-0000-0000-0000-0000000000c2', '33300000-0000-0000-0000-000000000002',
  '33300000-0000-0000-0000-000000000004', '33300000-0000-0000-0000-00000000000a', 'reel', 'published',
  timezone('utc', now()) - interval '3 days', 'cold-333-recente-arquivado',
  timezone('utc', now()) - interval '3 days', timezone('utc', now()) - interval '2 days');

-- Item C: NUNCA arquivado, e antigo. Não pode sair da tabela quente de jeito nenhum.
insert into public.publication_items (id, organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key, published_at)
values ('33300000-0000-0000-0000-0000000000c3', '33300000-0000-0000-0000-000000000002',
  '33300000-0000-0000-0000-000000000004', '33300000-0000-0000-0000-00000000000a', 'reel', 'published',
  timezone('utc', now()) - interval '40 days', 'cold-333-nunca-arquivado',
  timezone('utc', now()) - interval '40 days');

-- Item D: da organização vizinha, arquivado há 30 dias. Não pode ser tocado.
insert into public.publication_items (id, organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key, published_at, archived_at)
values ('33300000-0000-0000-0000-0000000000c4', '33300000-0000-0000-0000-000000000003',
  '33300000-0000-0000-0000-000000000005', '33300000-0000-0000-0000-00000000000b', 'reel', 'published',
  timezone('utc', now()) - interval '31 days', 'cold-333-outra-organizacao',
  timezone('utc', now()) - interval '31 days', timezone('utc', now()) - interval '30 days');

create temporary table resultado_333 on commit drop as
select public.move_archived_publication_items_to_cold_storage(
  '33300000-0000-0000-0000-000000000002', 7, 500) as payload;

-- ---------------------------------------------------------------------------
-- 1. Só o item antigo saiu
-- ---------------------------------------------------------------------------
select is(
  (select (payload ->> 'movedItems')::integer from resultado_333),
  1,
  'apenas o item arquivado há mais de 7 dias é movido'
);

select is(
  (select count(*)::integer from public.publication_items
   where id = '33300000-0000-0000-0000-0000000000c1'),
  0,
  'o item antigo sai da tabela quente'
);

select is(
  (select count(*)::integer from public.publication_items_archive
   where id = '33300000-0000-0000-0000-0000000000c1'),
  1,
  'o item antigo aparece no arquivo frio'
);

-- ---------------------------------------------------------------------------
-- 2. O QUE MAIS IMPORTA: a mídia sobreviveu à cascata
-- ---------------------------------------------------------------------------
select is(
  (select (payload ->> 'movedMedia')::integer from resultado_333),
  1,
  'a mídia do item é copiada para o frio'
);

select is(
  (select media_asset_id from public.publication_item_media_archive
   where publication_item_id = '33300000-0000-0000-0000-0000000000c1'),
  '33300000-0000-0000-0000-0000000000f1'::uuid,
  'o registro de QUAL mídia foi publicada sobrevive — a FK on delete cascade não o destrói'
);

select is(
  (select count(*)::integer from public.publication_item_media
   where publication_item_id = '33300000-0000-0000-0000-0000000000c1'),
  0,
  'a linha quente da mídia é removida pela cascata, como esperado'
);

-- ---------------------------------------------------------------------------
-- 3. O que não pode se mexer
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::integer from public.publication_items
   where id = '33300000-0000-0000-0000-0000000000c2'),
  1,
  'item arquivado há 2 dias permanece na tabela quente'
);

select is(
  (select count(*)::integer from public.publication_items
   where id = '33300000-0000-0000-0000-0000000000c3'),
  1,
  'item NUNCA arquivado permanece, por mais antigo que seja'
);

select is(
  (select count(*)::integer from public.publication_items
   where id = '33300000-0000-0000-0000-0000000000c4'),
  1,
  'item da outra organização não é tocado — o movimento é escopado'
);

-- ---------------------------------------------------------------------------
-- 4. Piso de retenção: nem pedindo 0 dias o recente sai
-- ---------------------------------------------------------------------------
select is(
  (select (public.move_archived_publication_items_to_cold_storage(
     '33300000-0000-0000-0000-000000000002', 0, 500) ->> 'movedItems')::integer),
  0,
  'pedir retenção de 0 dias não move o item de 2 dias — o piso de 7 protege'
);

select is(
  (select (public.move_archived_publication_items_to_cold_storage(
     '33300000-0000-0000-0000-000000000002', 0, 500) ->> 'retentionDays')::integer),
  7,
  'a retenção efetiva é elevada ao piso de 7 dias'
);

-- ---------------------------------------------------------------------------
-- 5. A guarda de paridade de colunas dispara
-- ---------------------------------------------------------------------------
-- Simula a migration futura que adiciona coluna na quente e esquece a fria.
-- O ALTER precisa do papel dono da tabela; service_role não é dono.
reset role;
alter table public.publication_items add column coluna_esquecida_333 text;
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

select throws_matching(
  $$select public.move_archived_publication_items_to_cold_storage('33300000-0000-0000-0000-000000000002', 7, 500)$$,
  'sem espelhar no arquivo frio',
  'coluna nova sem espelho no frio faz a função falhar alto, em vez de mover dado pela metade'
);

-- ---------------------------------------------------------------------------
-- 6. Só o service_role move
-- ---------------------------------------------------------------------------
reset role;
alter table public.publication_items drop column coluna_esquecida_333;
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '33300000-0000-0000-0000-000000000001', 'role', 'authenticated'
)::text, true);

-- A proteção tem duas camadas, e a de fora é a mais forte: o `revoke execute`
-- barra o usuário logado ANTES de a função rodar, então nem se chega na guarda
-- interna de `auth.role()`. A guarda interna continua valendo para quem tiver
-- execute (hoje só o service_role).
select throws_matching(
  $$select public.move_archived_publication_items_to_cold_storage('33300000-0000-0000-0000-000000000002', 7, 500)$$,
  'permission denied for function',
  'usuário logado não consegue nem executar a função — barrado pelo grant'
);

select * from finish();

rollback;
