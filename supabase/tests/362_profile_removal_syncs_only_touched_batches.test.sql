-- A exclusão de perfis só pode sincronizar os lotes cujos itens ela mexeu.
--
-- O teste central é o do lote JÁ TERMINAL: ele entra com um status
-- deliberadamente divergente ('queued' num lote onde tudo já foi publicado). Se
-- a exclusão continuar varrendo a vida inteira do perfil, ela vai "consertar"
-- esse status sem querer e o teste falha — que é exatamente o trabalho inútil
-- que estourava o statement_timeout em 03/09/2026.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(11);

select extensions.has_function(
  'public', 'contain_instagram_profile_for_removal',
  array['uuid','uuid','uuid','text','text','text','boolean','boolean'],
  'a contenção aceita o adiamento da sincronização de lote'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.contain_instagram_profile_for_removal(uuid,uuid,uuid,text,text,text,boolean,boolean)',
    'EXECUTE'
  ),
  'a contenção continua fora do alcance do usuário autenticado'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  ('16200000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'removal-362-admin@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('26200000-0000-4000-8000-000000000001', 'Remoção 362', 'remocao-362', '16200000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by) values
  ('26200000-0000-4000-8000-000000000001', '16200000-0000-4000-8000-000000000001', 'admin', '16200000-0000-4000-8000-000000000001');

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by
) values
  ('46200000-0000-4000-8000-000000000001', '26200000-0000-4000-8000-000000000001',
   'ig-362-a', 'conta_362_a', 'token', 'online', '16200000-0000-4000-8000-000000000001'),
  ('46200000-0000-4000-8000-000000000002', '26200000-0000-4000-8000-000000000001',
   'ig-362-b', 'conta_362_b', 'token', 'online', '16200000-0000-4000-8000-000000000001');

-- Lote VIVO: tem o item aberto do perfil. É o único que a exclusão precisa
-- recalcular.
insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values ('66200000-0000-4000-8000-000000000001', '26200000-0000-4000-8000-000000000001',
  '16200000-0000-4000-8000-000000000001', 'Lote vivo 362', 'queued', timezone('utc', now()));

-- Lote MORTO: tudo já publicado, e com o status propositalmente divergente.
-- Nenhum item dele muda de status durante a exclusão, então nada aqui pode ser
-- reescrito.
insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values ('66200000-0000-4000-8000-000000000002', '26200000-0000-4000-8000-000000000001',
  '16200000-0000-4000-8000-000000000001', 'Lote morto 362', 'queued', timezone('utc', now()));

insert into public.publication_items (
  id, organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key
) values
  ('76200000-0000-4000-8000-000000000001', '26200000-0000-4000-8000-000000000001',
   '66200000-0000-4000-8000-000000000001', '46200000-0000-4000-8000-000000000001',
   'image', 'waiting', timezone('utc', now()) + interval '1 hour', 'removal-362-item-0001'),
  ('76200000-0000-4000-8000-000000000002', '26200000-0000-4000-8000-000000000001',
   '66200000-0000-4000-8000-000000000002', '46200000-0000-4000-8000-000000000001',
   'image', 'published', timezone('utc', now()) - interval '1 day', 'removal-362-item-0002');

set local role authenticated;
set local request.jwt.claim.sub = '16200000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.email = 'removal-362-admin@example.com';

create temporary table removal_362_outcomes on commit drop as
select * from public.enqueue_instagram_profile_removal(
  '26200000-0000-4000-8000-000000000001',
  array['46200000-0000-4000-8000-000000000001']::uuid[],
  'operator: teste 362'
);

select extensions.is(
  (select removed_outcome from removal_362_outcomes),
  'deleted_local',
  'o perfil sem contrapartida remota é finalizado na hora'
);

select extensions.is(
  (select status::text from public.publication_items where id = '76200000-0000-4000-8000-000000000001'),
  'ignored',
  'o item aberto sai de circulação'
);
select extensions.is(
  (select status::text from public.publication_items where id = '76200000-0000-4000-8000-000000000002'),
  'published',
  'o item já publicado não é tocado'
);
-- Só o evento da contenção é contado. O outro evento do mesmo item vem do
-- trigger handle_profile_publication_suspension (migration 208), que dispara ao
-- perfil virar 'offline' na primeira linha da contenção e grava um 'suspended'
-- antes. São dois passos distintos e ambos ficam no histórico.
select extensions.is(
  (select count(*)::integer from public.publication_item_events
    where publication_item_id = '76200000-0000-4000-8000-000000000001'
      and event_type::text = 'cancelled'),
  1,
  'um evento de cancelamento por item efetivamente retirado da fila'
);

select extensions.is(
  (select status::text from public.publication_batches where id = '66200000-0000-4000-8000-000000000001'),
  'completed',
  'o lote que teve item alterado é recalculado'
);
select extensions.is(
  (select status::text from public.publication_batches where id = '66200000-0000-4000-8000-000000000002'),
  'queued',
  'o lote sem alteração nenhuma não é varrido nem reescrito'
);

-- Adiamento: com p_defer_batch_sync o lote NÃO é sincronizado dentro da
-- contenção, e os ids afetados voltam para quem chamou fazer isso uma vez só.
set local role service_role;
set local request.jwt.claim.role = 'service_role';

insert into public.publication_items (
  id, organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key
) values
  ('76200000-0000-4000-8000-000000000003', '26200000-0000-4000-8000-000000000001',
   '66200000-0000-4000-8000-000000000002', '46200000-0000-4000-8000-000000000002',
   'image', 'waiting', timezone('utc', now()) + interval '1 hour', 'removal-362-item-0003');

do $$
declare
  containment jsonb;
begin
  containment := public.contain_instagram_profile_for_removal(
    '26200000-0000-4000-8000-000000000001',
    '46200000-0000-4000-8000-000000000002',
    null,
    'teste_362',
    'Contenção de teste.',
    'system: teste 362',
    false,
    true
  );
  create temporary table removal_362_containment on commit drop as select containment as payload;
end;
$$;

select extensions.is(
  (select payload -> 'affectedBatchIds' from removal_362_containment),
  '["66200000-0000-4000-8000-000000000002"]'::jsonb,
  'o adiamento devolve exatamente os lotes que mudaram'
);

-- Depois da contenção, todo item do lote morto está em estado terminal
-- ('published' e 'ignored') — uma sincronização o levaria a 'completed'. Ele
-- segue em 'processing', o valor que o trigger de suspensão deixou ao suspender
-- o item recém-inserido: prova de que a contenção adiada não sincronizou.
select extensions.is(
  (select status::text from public.publication_batches where id = '66200000-0000-4000-8000-000000000002'),
  'processing',
  'com o adiamento ligado a contenção não sincroniza sozinha'
);

-- E o trabalho adiado é trabalho de verdade: quem chamou precisa fazê-lo.
select extensions.is(
  public.sync_publication_batch_status('66200000-0000-4000-8000-000000000002')::text,
  'completed',
  'a sincronização que o chamador faz depois fecha o lote'
);

select * from extensions.finish();
rollback;
