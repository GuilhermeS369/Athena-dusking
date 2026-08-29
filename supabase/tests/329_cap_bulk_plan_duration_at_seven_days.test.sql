-- Cobre o teto de 7 dias da migration 329.
--
-- O ponto delicado não é recusar 8 dias — é NÃO quebrar o histórico. Já existem
-- planos concluídos de 9, 10 e até 20 dias em produção. Uma CHECK constraint
-- (mesmo NOT VALID) passaria a ser exigida em qualquer UPDATE dessas linhas, e
-- refresh_bulk_rotation_plan_state, pausa operacional e cancelamento por escopo
-- escrevem em planos existentes. Por isso o teto é um gatilho BEFORE INSERT, e
-- este teste prova que uma linha antiga acima do teto continua atualizável.

begin;

select plan(5);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('32900000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'cap329@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));

insert into public.organizations (id, name, slug, created_by)
values ('32900000-0000-0000-0000-000000000002', 'Duration cap 329', 'duration-cap-329', '32900000-0000-0000-0000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('32900000-0000-0000-0000-000000000002', '32900000-0000-0000-0000-000000000001', 'admin', '32900000-0000-0000-0000-000000000001');

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
select gen_random_uuid(), '32900000-0000-0000-0000-000000000002', '32900000-0000-0000-0000-000000000001',
  'lote 329 ' || n, 'queued', timezone('utc', now())
from generate_series(1, 4) n;

create or replace function pg_temp.plan_insert(p_days bigint, p_key text) returns void language plpgsql as $$
declare
  batch uuid;
begin
  select batch_row.id into batch
  from public.publication_batches batch_row
  where batch_row.organization_id = '32900000-0000-0000-0000-000000000002'
    and not exists (select 1 from public.bulk_publication_plans plan where plan.batch_id = batch_row.id)
  order by batch_row.name
  limit 1;

  insert into public.bulk_publication_plans (
    organization_id, created_by, batch_id, request_key, request_hash, name, status, format,
    origin_type, interval_minutes, duration_days, slots_per_profile, order_mode, rotation_seed,
    profile_count, media_count, expected_publications, expected_chunks
  ) values (
    '32900000-0000-0000-0000-000000000002', '32900000-0000-0000-0000-000000000001', batch,
    p_key, repeat('a', 64), 'plano ' || p_key, 'queued', 'reel', 'ungrouped',
    60, p_days, p_days * 24, 'same_order', 'seed-' || p_key, 1, 1, p_days * 24, 1
  );
end;
$$;

select lives_ok(
  $$select pg_temp.plan_insert(7::bigint, 'cap-329-duracao-no-teto')$$,
  'plano de exatamente 7 dias é aceito'
);

select throws_ok(
  $$select pg_temp.plan_insert(8::bigint, 'cap-329-duracao-acima-do-teto')$$,
  '22023',
  'A duração máxima de uma programação em massa é de 7 dias.',
  'plano de 8 dias é recusado com mensagem clara'
);

select throws_ok(
  $$select pg_temp.plan_insert(365::bigint, 'cap-329-duracao-absurda-365')$$,
  '22023',
  'A duração máxima de uma programação em massa é de 7 dias.',
  'plano de 365 dias é recusado — o caso que motivou o teto'
);

-- Simula uma linha histórica acima do teto: o gatilho é BEFORE INSERT, então
-- precisamos desativá-lo só para plantar a fixture, como se ela fosse anterior
-- à migration.
alter table public.bulk_publication_plans disable trigger bulk_publication_plans_enforce_duration_cap;
select pg_temp.plan_insert(20::bigint, 'cap-329-duracao-historica-20');
alter table public.bulk_publication_plans enable trigger bulk_publication_plans_enforce_duration_cap;

select is(
  (select duration_days from public.bulk_publication_plans where request_key = 'cap-329-duracao-historica-20'),
  20::bigint,
  'plano histórico de 20 dias permanece na tabela'
);

-- É isto que uma CHECK constraint quebraria: refresh_bulk_rotation_plan_state,
-- pausa e cancelamento escrevem em planos existentes.
select lives_ok(
  $$update public.bulk_publication_plans
      set status = 'completed', generated_publications = 10
      where request_key = 'cap-329-duracao-historica-20'$$,
  'plano histórico acima do teto continua podendo ser atualizado'
);

select * from finish();

rollback;
