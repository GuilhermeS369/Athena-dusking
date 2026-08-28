begin;

select '1..3';

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('29500000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'instagram-295-a@example.com', 'x', now(), now(), now()),
  ('29500000-0000-4000-8000-000000000002', '00000000-0000-0000-8000-000000000000', 'authenticated', 'authenticated', 'instagram-295-b@example.com', 'x', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values
  ('29500000-0000-4000-8000-000000000011', 'Instagram 295 A', 'instagram-295-a', '29500000-0000-4000-8000-000000000001'),
  ('29500000-0000-4000-8000-000000000012', 'Instagram 295 B', 'instagram-295-b', '29500000-0000-4000-8000-000000000002');

insert into public.organization_members (organization_id, user_id, role, joined_at)
values
  ('29500000-0000-4000-8000-000000000011', '29500000-0000-4000-8000-000000000001', 'operator', now() - interval '1 day'),
  ('29500000-0000-4000-8000-000000000012', '29500000-0000-4000-8000-000000000002', 'viewer', now());

set local role authenticated;
select set_config('request.jwt.claim.sub', '29500000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.email', 'instagram-295-a@example.com', true);

do $$
declare context jsonb;
begin
  context := public.get_instagram_operation_context('29500000-0000-4000-8000-000000000011');
  if context #>> '{activeOrganization,id}' <> '29500000-0000-4000-8000-000000000011'
    or context #>> '{activeOrganization,role}' <> 'operator'
    or context ->> 'userId' <> '29500000-0000-4000-8000-000000000001'
    or context ->> 'email' <> 'instagram-295-a@example.com' then
    raise exception 'Contexto autenticado incorreto: %', context;
  end if;
end;
$$;
select 'ok 1 - resolve usuário, papel e organização ativa em uma chamada';

do $$
declare context jsonb;
begin
  context := public.get_instagram_operation_context('29500000-0000-4000-8000-000000000012');
  if context #>> '{activeOrganization,id}' <> '29500000-0000-4000-8000-000000000011' then
    raise exception 'Pedido tentou atravessar organização: %', context;
  end if;
end;
$$;
select 'ok 2 - organização de outro usuário nunca é selecionada';

reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'anon', true);
do $$
begin
  if public.get_instagram_operation_context(null) is not null then
    raise exception 'Usuário anônimo recebeu contexto.';
  end if;
exception
  when insufficient_privilege then
    return;
end;
$$;
select 'ok 3 - acesso anônimo não recebe contexto';

rollback;
