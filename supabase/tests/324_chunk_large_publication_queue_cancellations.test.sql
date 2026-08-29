-- Cobre o caminho em blocos introduzido pela migration 324: um escopo com mais
-- itens cancelaveis do que cabe numa única chamada (limite de 1500) precisa de
-- mais de uma chamada a execute_server_publication_queue_cancellation, com
-- progresso real persistido entre elas, até concluir com o total correto.
-- Também cobre o bloqueio dentro de um bloco (item em preparing no início da
-- fila) sem cancelar nada até o item ser liberado.

begin;

select plan(16);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('32400000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'cancel324@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));
insert into public.organizations (id, name, slug, created_by)
values ('32400000-0000-0000-0000-000000000002', 'Chunk cancellation 324', 'chunk-cancellation-324', '32400000-0000-0000-0000-000000000001');
insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('32400000-0000-0000-0000-000000000002', '32400000-0000-0000-0000-000000000001', 'admin', '32400000-0000-0000-0000-000000000001');
insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by, provider, capabilities)
select gen_random_uuid(), '32400000-0000-0000-0000-000000000002', 'cancel-324-' || profile_number,
  'cancel_324_' || profile_number, 'synthetic-token', 'offline', '32400000-0000-0000-0000-000000000001',
  'meta_official', jsonb_build_object('synthetic', true, 'profileNumber', profile_number)
from generate_series(1, 20) profile_number;

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values ('32400000-0000-0000-0000-000000000004', '32400000-0000-0000-0000-000000000002', '32400000-0000-0000-0000-000000000001', 'Lote grande 324', 'queued', timezone('utc', now()));

-- 1800 itens > limite de 1500 por chamada: força o caminho em blocos.
-- created_at explicito e crescente garante ordem determinística (a mesma
-- ORDER BY created_at, id usada pela função) para os itens 1..1800.
-- execute_at varia por item (não só por perfil) para não colidir com o
-- gatilho de vaga única por (perfil, execute_at) — com só 20 perfis para 1800
-- itens, um horário fixo repetido geraria vários itens por perfil no mesmo
-- horário.
insert into public.publication_items (organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key, created_at)
select profile.organization_id, '32400000-0000-0000-0000-000000000004', profile.id,
  case when (item_number % 2) = 0 then 'story'::public.publication_format else 'reel'::public.publication_format end,
  'waiting', timezone('utc', now()) + interval '1 hour' + (item_number || ' minutes')::interval, 'cancel-324-item-' || lpad(item_number::text, 5, '0'),
  timezone('utc', now()) - interval '1 hour' + (item_number || ' milliseconds')::interval
from generate_series(1, 1800) item_number
join public.instagram_profiles profile
  on profile.organization_id = '32400000-0000-0000-0000-000000000002'
  and (profile.capabilities ->> 'profileNumber')::integer = ((item_number - 1) % 20) + 1;

insert into public.publication_queue_cancellation_operations (
  id, organization_id, requested_by, idempotency_key, scope, target_id
) values (
  '32400000-0000-0000-0000-000000000005', '32400000-0000-0000-0000-000000000002',
  '32400000-0000-0000-0000-000000000001', 'cancel-324-chunked-0001', 'batch', '32400000-0000-0000-0000-000000000004'
);

-- Primeira chamada: 1800 > 1500, deve processar só o primeiro bloco e voltar
-- 'running' com progresso real, sem concluir.
select results_eq(
  $$select status, progress from public.publication_queue_cancellation_operations where id = '32400000-0000-0000-0000-000000000005'$$,
  $$select 'running'::text, 5$$,
  'operação recém-criada começa running/5% (antes de qualquer execução)'
);

select is(
  (public.execute_server_publication_queue_cancellation('32400000-0000-0000-0000-000000000005') ->> 'state'),
  'running',
  'primeira chamada de um escopo de 1800 itens não conclui de uma vez'
);
select is(
  (select status::text from public.publication_queue_cancellation_operations where id = '32400000-0000-0000-0000-000000000005'),
  'running',
  'operação continua running após a primeira chamada'
);
select is(
  (select (result ->> 'remainingCancelableItems')::integer from public.publication_queue_cancellation_operations where id = '32400000-0000-0000-0000-000000000005'),
  300,
  'restam 300 itens cancelaveis após cancelar o primeiro bloco de 1500'
);
select is(
  (select (result ->> 'cancelledSoFar')::integer from public.publication_queue_cancellation_operations where id = '32400000-0000-0000-0000-000000000005'),
  1500,
  'o progresso acumulado registra os 1500 itens já cancelados no primeiro bloco'
);
select cmp_ok(
  (select progress from public.publication_queue_cancellation_operations where id = '32400000-0000-0000-0000-000000000005'),
  '>', 5,
  'o progresso avança de verdade entre chamadas, não fica travado em 5%'
);
select is(
  (select count(*)::bigint from public.publication_items where batch_id = '32400000-0000-0000-0000-000000000004' and status = 'cancelled'),
  1500::bigint,
  'exatamente os 1500 itens do primeiro bloco terminam cancelados nesse ponto'
);

-- Segunda chamada: só restam 300 itens (<= 1500), completa pelo caminho
-- tradicional numa única vez, e o total reportado soma os dois blocos.
select is(
  (public.execute_server_publication_queue_cancellation('32400000-0000-0000-0000-000000000005') ->> 'cancelledItems')::integer,
  1800,
  'a segunda chamada conclui e reporta o total das duas etapas (1500 + 300)'
);
select is(
  (select status::text from public.publication_queue_cancellation_operations where id = '32400000-0000-0000-0000-000000000005'),
  'completed',
  'a operação termina completed depois de esvaziar o backlog'
);
select is(
  (select count(*)::bigint from public.publication_items where batch_id = '32400000-0000-0000-0000-000000000004' and status = 'cancelled'),
  1800::bigint,
  'todos os 1800 itens terminam cancelados'
);
select is(
  (select status::text from public.publication_batches where id = '32400000-0000-0000-0000-000000000004'),
  'cancelled',
  'o lote também termina cancelado'
);

-- Segundo cenário: bloqueio DENTRO de um bloco (cancel_publication_queue_scope_chunk),
-- caminho novo desta migration e ainda não coberto por nenhum teste existente.
-- Um item em preparing logo no início da fila (created_at mais antigo) faz o
-- bloco inteiro não cancelar nada — mas, diferente do bloqueio tradicional, a
-- operação continua 'running' (não vira um estado terminal de erro), porque o
-- item tende a se liberar sozinho e o próprio polling da UI tenta de novo.
insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values ('32400000-0000-0000-0000-000000000007', '32400000-0000-0000-0000-000000000002', '32400000-0000-0000-0000-000000000001', 'Lote com item em voo 324', 'processing', timezone('utc', now()));

insert into public.publication_items (id, organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key, created_at, claimed_by, lease_until)
select
  case when item_number = 1 then '32400000-0000-0000-0000-000000000008'::uuid else gen_random_uuid() end,
  profile.organization_id, '32400000-0000-0000-0000-000000000007', profile.id,
  case when (item_number % 2) = 0 then 'story'::public.publication_format else 'reel'::public.publication_format end,
  case when item_number = 1 then 'preparing'::public.publication_item_status else 'waiting'::public.publication_item_status end,
  timezone('utc', now()) + interval '3 hours' + (item_number || ' minutes')::interval,
  'cancel-324-inflight-item-' || lpad(item_number::text, 5, '0'),
  timezone('utc', now()) - interval '2 hours' + (item_number || ' milliseconds')::interval,
  case when item_number = 1 then 'test-worker-324' else null end,
  case when item_number = 1 then timezone('utc', now()) + interval '3 minutes' else null end
from generate_series(1, 1600) item_number
join public.instagram_profiles profile
  on profile.organization_id = '32400000-0000-0000-0000-000000000002'
  and (profile.capabilities ->> 'profileNumber')::integer = ((item_number - 1) % 20) + 1;

insert into public.publication_queue_cancellation_operations (
  id, organization_id, requested_by, idempotency_key, scope, target_id
) values (
  '32400000-0000-0000-0000-000000000009', '32400000-0000-0000-0000-000000000002',
  '32400000-0000-0000-0000-000000000001', 'cancel-324-chunk-blocked-0001', 'batch', '32400000-0000-0000-0000-000000000007'
);

select is(
  (public.execute_server_publication_queue_cancellation('32400000-0000-0000-0000-000000000009') ->> 'state'),
  'running',
  'bloco com item em preparing não é tratado como erro terminal'
);
select is(
  (select status::text from public.publication_queue_cancellation_operations where id = '32400000-0000-0000-0000-000000000009'),
  'running',
  'a operação continua running (não vira blocked) quando o bloqueio é só de um bloco'
);
select is(
  (select (result ->> 'remainingCancelableItems')::integer from public.publication_queue_cancellation_operations where id = '32400000-0000-0000-0000-000000000009'),
  1599,
  'nenhum item cancelavel foi processado enquanto o item em voo travava o bloco'
);
select is(
  (select count(*)::bigint from public.publication_items where batch_id = '32400000-0000-0000-0000-000000000007' and status = 'cancelled'),
  0::bigint,
  'nada foi cancelado nesta chamada bloqueada'
);

-- Libera o item em voo (como o dispatcher faria ao terminar) e tenta de novo:
-- o mesmo polling que já existia agora consegue avançar sozinho.
update public.publication_items set status = 'waiting', claimed_by = null, lease_until = null
where id = '32400000-0000-0000-0000-000000000008';

select cmp_ok(
  (
    select (public.execute_server_publication_queue_cancellation('32400000-0000-0000-0000-000000000009') ->> 'remainingCancelableItems')::integer
  ),
  '<', 1599,
  'depois de o item em voo se liberar, a próxima chamada consegue progredir de verdade'
);

select * from finish();
rollback;
