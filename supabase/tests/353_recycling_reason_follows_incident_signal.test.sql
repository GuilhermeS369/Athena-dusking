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
  ('15300000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'motivo-353@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('25300000-0000-4000-8000-000000000001', 'Motivo 353', 'motivo-353', '15300000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('25300000-0000-4000-8000-000000000001', '15300000-0000-4000-8000-000000000001', 'admin', '15300000-0000-4000-8000-000000000001');

insert into public.zernio_connections (
  id, organization_id, label, encrypted_api_key, zernio_profile_id, status, created_by
) values (
  '35300000-0000-4000-8000-000000000001', '25300000-0000-4000-8000-000000000001',
  'Chave 353', 'encrypted-api-key-teste-353', 'zernio-profile-353', 'online',
  '15300000-0000-4000-8000-000000000001'
);

insert into public.zernio_connection_remote_profiles (
  organization_id, zernio_connection_id, zernio_profile_id, kind, status
) values (
  '25300000-0000-4000-8000-000000000001', '35300000-0000-4000-8000-000000000001',
  'zernio-profile-353', 'canonical', 'connected'
);

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, status, created_by,
  provider, zernio_connection_id, zernio_profile_id, zernio_account_id
) values
  ('45300000-0000-4000-8000-000000000001', '25300000-0000-4000-8000-000000000001',
   'ig-353-operador', 'perfil_do_operador', 'online', '15300000-0000-4000-8000-000000000001',
   'zernio', '35300000-0000-4000-8000-000000000001', 'zernio-profile-353', 'zernio-account-353-a'),
  ('45300000-0000-4000-8000-000000000002', '25300000-0000-4000-8000-000000000001',
   'ig-353-queda', 'perfil_que_caiu', 'online', '15300000-0000-4000-8000-000000000001',
   'zernio', '35300000-0000-4000-8000-000000000001', 'zernio-profile-353', 'zernio-account-353-b');

-- Caminho do operador ---------------------------------------------------------

set local role authenticated;
set local request.jwt.claim.sub = '15300000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.email = 'motivo-353@example.com';

select extensions.is(
  (select removed_outcome from public.enqueue_instagram_profile_removal(
    '25300000-0000-4000-8000-000000000001',
    array['45300000-0000-4000-8000-000000000001']::uuid[])),
  'queued',
  'a exclusao pedida pelo operador entra na fila'
);

-- Caminho da queda detectada por worker ---------------------------------------

reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select extensions.ok(
  (public.schedule_zernio_sync_profile_disconnection(
    '25300000-0000-4000-8000-000000000001',
    '45300000-0000-4000-8000-000000000002',
    'auth_expired'
  ) ->> 'scheduled')::boolean,
  'a queda detectada pelo worker tambem entra na fila'
);

-- Um worker drena os dois --------------------------------------------------

create temporary table claimed_353 on commit drop as
select * from public.claim_zernio_profile_recycling_jobs('worker-teste-353', 10, 180);

select extensions.is(
  (select count(*)::integer from claimed_353),
  2,
  'o worker reivindica os dois jobs no mesmo ciclo'
);

do $$
declare
  linha record;
begin
  for linha in select job_id from claimed_353 loop
    perform public.complete_zernio_profile_recycling(
      linha.job_id, 'worker-teste-353', 'remote_deleted', 200, 'athena-teste-353', null, null
    );
  end loop;
end;
$$;

-- O motivo gravado acompanha o sinal ------------------------------------------

select extensions.is(
  (select last_error_code from public.instagram_profiles where id = '45300000-0000-4000-8000-000000000001'),
  'profile_removed_by_operator',
  'perfil excluido pelo operador nao fica marcado como queda da Zernio'
);
select extensions.matches(
  (select last_error_message from public.instagram_profiles where id = '45300000-0000-4000-8000-000000000001'),
  'operador',
  'a mensagem do perfil do operador diz quem mandou excluir'
);

-- O caminho antigo nao pode ter mudado.
select extensions.is(
  (select last_error_code from public.instagram_profiles where id = '45300000-0000-4000-8000-000000000002'),
  'zernio_account_disconnected',
  'queda detectada pelo worker mantem o motivo de sempre'
);

-- E os dois de fato foram removidos -------------------------------------------

select extensions.is(
  (select count(*)::integer from public.instagram_profiles
    where id in ('45300000-0000-4000-8000-000000000001', '45300000-0000-4000-8000-000000000002')
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
