begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(8);

-- complete_zernio_profile_recycling fecha o ciclo dos dois caminhos de remocao.
-- O teste roda o ciclo inteiro (enfileirar -> claim -> complete) para cada um e
-- confere o motivo que sobra gravado no perfil, que e o campo que alguem le
-- primeiro ao investigar por que um perfil sumiu.

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  ('14700000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'motivo-347@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('24700000-0000-4000-8000-000000000001', 'Motivo 347', 'motivo-347', '14700000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('24700000-0000-4000-8000-000000000001', '14700000-0000-4000-8000-000000000001', 'admin', '14700000-0000-4000-8000-000000000001');

insert into public.zernio_connections (
  id, organization_id, label, encrypted_api_key, zernio_profile_id, status, created_by
) values (
  '34700000-0000-4000-8000-000000000001', '24700000-0000-4000-8000-000000000001',
  'Chave 347', 'encrypted-api-key-teste-347', 'zernio-profile-347', 'online',
  '14700000-0000-4000-8000-000000000001'
);

insert into public.zernio_connection_remote_profiles (
  organization_id, zernio_connection_id, zernio_profile_id, kind, status
) values (
  '24700000-0000-4000-8000-000000000001', '34700000-0000-4000-8000-000000000001',
  'zernio-profile-347', 'canonical', 'connected'
);

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, status, created_by,
  provider, zernio_connection_id, zernio_profile_id, zernio_account_id
) values
  ('44700000-0000-4000-8000-000000000001', '24700000-0000-4000-8000-000000000001',
   'ig-347-operador', 'perfil_do_operador', 'online', '14700000-0000-4000-8000-000000000001',
   'zernio', '34700000-0000-4000-8000-000000000001', 'zernio-profile-347', 'zernio-account-347-a'),
  ('44700000-0000-4000-8000-000000000002', '24700000-0000-4000-8000-000000000001',
   'ig-347-queda', 'perfil_que_caiu', 'online', '14700000-0000-4000-8000-000000000001',
   'zernio', '34700000-0000-4000-8000-000000000001', 'zernio-profile-347', 'zernio-account-347-b');

-- Caminho do operador ---------------------------------------------------------

set local role authenticated;
set local request.jwt.claim.sub = '14700000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.email = 'motivo-347@example.com';

select extensions.is(
  (select removed_outcome from public.enqueue_instagram_profile_removal(
    '24700000-0000-4000-8000-000000000001',
    array['44700000-0000-4000-8000-000000000001']::uuid[])),
  'queued',
  'a exclusao pedida pelo operador entra na fila'
);

-- Caminho da queda detectada por worker ---------------------------------------

reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select extensions.ok(
  (public.schedule_zernio_sync_profile_disconnection(
    '24700000-0000-4000-8000-000000000001',
    '44700000-0000-4000-8000-000000000002',
    'auth_expired'
  ) ->> 'scheduled')::boolean,
  'a queda detectada pelo worker tambem entra na fila'
);

-- Um worker drena os dois --------------------------------------------------

create temporary table claimed_347 on commit drop as
select * from public.claim_zernio_profile_recycling_jobs('worker-teste-347', 10, 180);

select extensions.is(
  (select count(*)::integer from claimed_347),
  2,
  'o worker reivindica os dois jobs no mesmo ciclo'
);

do $$
declare
  linha record;
begin
  for linha in select job_id from claimed_347 loop
    perform public.complete_zernio_profile_recycling(
      linha.job_id, 'worker-teste-347', 'remote_deleted', 200, 'athena-teste-347', null, null
    );
  end loop;
end;
$$;

-- O motivo gravado acompanha o sinal ------------------------------------------

select extensions.is(
  (select last_error_code from public.instagram_profiles where id = '44700000-0000-4000-8000-000000000001'),
  'profile_removed_by_operator',
  'perfil excluido pelo operador nao fica marcado como queda da Zernio'
);
select extensions.matches(
  (select last_error_message from public.instagram_profiles where id = '44700000-0000-4000-8000-000000000001'),
  'operador',
  'a mensagem do perfil do operador diz quem mandou excluir'
);

-- O caminho antigo nao pode ter mudado.
select extensions.is(
  (select last_error_code from public.instagram_profiles where id = '44700000-0000-4000-8000-000000000002'),
  'zernio_account_disconnected',
  'queda detectada pelo worker mantem o motivo de sempre'
);

-- E os dois de fato foram removidos -------------------------------------------

select extensions.is(
  (select count(*)::integer from public.instagram_profiles
    where id in ('44700000-0000-4000-8000-000000000001', '44700000-0000-4000-8000-000000000002')
      and deleted_at is not null),
  2,
  'os dois perfis ficam com soft-delete depois do ciclo'
);
select extensions.is(
  (select count(*)::integer from public.zernio_profile_recycling_jobs where status = 'completed'),
  2,
  'os dois jobs fecham como completed'
);

select * from extensions.finish();
rollback;
