-- Cobre a limpeza dedicada de falhas terminais da migration 327.
--
-- "Terminal" é definido exatamente pela condição que claim_publication_items
-- usa para recusar o item: status 'failed' e (next_attempt_at is null or
-- attempt_count >= 5). Um item nessas condições nunca mais pode ser
-- reivindicado, então mantê-lo com archived_at null só entope a fila visível.
--
-- O teste garante os dois lados: o que É terminal é arquivado, e o que ainda
-- pode ser reivindicado (retry agendado, tentativas restantes) NÃO é tocado.
-- Também garante que a janela de acomodação protege uma falha recém-gravada.

begin;

select plan(11);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('32700000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'terminal327@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));

insert into public.organizations (id, name, slug, created_by)
values ('32700000-0000-0000-0000-000000000002', 'Terminal failures 327', 'terminal-failures-327', '32700000-0000-0000-0000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('32700000-0000-0000-0000-000000000002', '32700000-0000-0000-0000-000000000001', 'admin', '32700000-0000-0000-0000-000000000001');

insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by, provider)
values ('32700000-0000-0000-0000-000000000003', '32700000-0000-0000-0000-000000000002', 'terminal-327-1',
  'terminal_327_1', 'synthetic-token', 'online', '32700000-0000-0000-0000-000000000001', 'meta_official');

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values ('32700000-0000-0000-0000-000000000004', '32700000-0000-0000-0000-000000000002',
  '32700000-0000-0000-0000-000000000001', 'Lote 327', 'processing', timezone('utc', now()));

-- O trigger de updated_at é BEFORE UPDATE, não BEFORE INSERT: dá para inserir
-- já com updated_at antigo e assim exercitar a janela de acomodação.
insert into public.publication_items (
  organization_id, batch_id, profile_id, format, status, execute_at,
  idempotency_key, attempt_count, next_attempt_at, last_error_code, updated_at
) values
  -- 1) terminal clássico: falhou sem próximo retry agendado
  ('32700000-0000-0000-0000-000000000002', '32700000-0000-0000-0000-000000000004', '32700000-0000-0000-0000-000000000003',
   'reel', 'failed', timezone('utc', now()) - interval '2 hours', 'terminal-327-sem-retry', 1, null, 'user_content',
   timezone('utc', now()) - interval '2 hours'),
  -- 2) terminal por esgotamento: 5 tentativas, mesmo com retry marcado
  ('32700000-0000-0000-0000-000000000002', '32700000-0000-0000-0000-000000000004', '32700000-0000-0000-0000-000000000003',
   'reel', 'failed', timezone('utc', now()) - interval '3 hours', 'terminal-327-esgotado', 5,
   timezone('utc', now()) + interval '5 minutes', 'platform_error', timezone('utc', now()) - interval '3 hours'),
  -- 3) NÃO terminal: ainda tem tentativas e retry agendado
  ('32700000-0000-0000-0000-000000000002', '32700000-0000-0000-0000-000000000004', '32700000-0000-0000-0000-000000000003',
   'reel', 'failed', timezone('utc', now()) - interval '4 hours', 'terminal-327-retry-vivo', 2,
   timezone('utc', now()) + interval '5 minutes', 'zernio_processing_timeout', timezone('utc', now()) - interval '4 hours'),
  -- 4) terminal, mas recém-gravado: a janela de acomodação precisa protegê-lo
  ('32700000-0000-0000-0000-000000000002', '32700000-0000-0000-0000-000000000004', '32700000-0000-0000-0000-000000000003',
   -- 1 minuto atrás: dentro da janela de 15min (protegido na 1ª chamada) e
   -- estritamente anterior a now() (arquivável na 2ª chamada, com janela 0).
   -- Precisa ser < now() porque dentro de uma transação now() é congelado.
   'reel', 'failed', timezone('utc', now()) - interval '5 hours', 'terminal-327-recente', 1, null, 'system_error',
   timezone('utc', now()) - interval '1 minute'),
  -- 5) item ativo: não pode ser tocado
  ('32700000-0000-0000-0000-000000000002', '32700000-0000-0000-0000-000000000004', '32700000-0000-0000-0000-000000000003',
   'reel', 'waiting', timezone('utc', now()) + interval '6 hours', 'terminal-327-ativo', 0, null, null,
   timezone('utc', now()) - interval '6 hours'),
  -- 6) já publicado: fora do escopo desta limpeza
  ('32700000-0000-0000-0000-000000000002', '32700000-0000-0000-0000-000000000004', '32700000-0000-0000-0000-000000000003',
   'reel', 'published', timezone('utc', now()) - interval '7 hours', 'terminal-327-publicado', 1, null, null,
   timezone('utc', now()) - interval '7 hours');

set local role service_role;

create temporary table limpeza_327 on commit drop as
select * from public.clean_publication_queue_terminal_failures('32700000-0000-0000-0000-000000000002', 2000, 15);

select is(
  (select archived_failure_count from limpeza_327),
  2,
  'arquivou exatamente as 2 falhas terminais acomodadas'
);

select is(
  (select remaining_failure_count from limpeza_327),
  0::bigint,
  'não sobrou falha terminal acomodada'
);

select ok(
  (select archived_at is not null from public.publication_items where idempotency_key = 'terminal-327-sem-retry'),
  'falha sem retry agendado foi arquivada'
);

select ok(
  (select archived_at is not null from public.publication_items where idempotency_key = 'terminal-327-esgotado'),
  'falha com 5 tentativas foi arquivada mesmo tendo next_attempt_at'
);

select ok(
  (select archived_at is null from public.publication_items where idempotency_key = 'terminal-327-retry-vivo'),
  'falha AINDA reivindicável (tentativas restantes + retry agendado) NÃO foi tocada'
);

select ok(
  (select archived_at is null from public.publication_items where idempotency_key = 'terminal-327-recente'),
  'falha terminal recém-gravada é protegida pela janela de acomodação'
);

select ok(
  (select archived_at is null from public.publication_items where idempotency_key = 'terminal-327-ativo'),
  'item ativo em waiting NÃO foi tocado'
);

select ok(
  (select archived_at is null from public.publication_items where idempotency_key = 'terminal-327-publicado'),
  'item published NÃO é escopo desta limpeza (é da clean_publication_queue_finished)'
);

select is(
  (select count(*)::integer from public.publication_failure_acknowledgements
   where organization_id = '32700000-0000-0000-0000-000000000002'),
  2,
  'cada falha arquivada gerou um reconhecimento de falha'
);

-- Com janela zero, a falha recém-gravada também entra.
create temporary table limpeza_327_b on commit drop as
select * from public.clean_publication_queue_terminal_failures('32700000-0000-0000-0000-000000000002', 2000, 0);

select is(
  (select archived_failure_count from limpeza_327_b),
  1,
  'com janela de acomodação zero, a falha recente também é arquivada'
);

select is(
  (select count(*)::integer from public.publication_items
   where organization_id = '32700000-0000-0000-0000-000000000002'
     and archived_at is null),
  3,
  'sobraram só os 3 que não são falha terminal: retry vivo, waiting e published'
);

select * from finish();

rollback;
