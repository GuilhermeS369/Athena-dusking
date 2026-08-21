-- Teste transacional do cancelamento verificável por conta, lote e grupo.
-- Executar em banco descartável com as migrations até a 167 aplicadas.

begin;

create or replace function auth.jwt()
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'sub', nullif(current_setting('request.jwt.claim.sub', true), ''),
    'role', nullif(current_setting('request.jwt.claim.role', true), ''),
    'email', nullif(current_setting('request.jwt.claim.email', true), '')
  )
$$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, confirmed_at, created_at, updated_at)
values ('16700000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cancel@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));
insert into public.organizations (id, name, slug, created_by)
values ('26700000-0000-0000-0000-000000000001', 'Organização de cancelamento', 'organizacao-cancelamento', '16700000-0000-0000-0000-000000000001');
insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('26700000-0000-0000-0000-000000000001', '16700000-0000-0000-0000-000000000001', 'admin', '16700000-0000-0000-0000-000000000001');
insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by)
values
  ('36700000-0000-0000-0000-000000000001', '26700000-0000-0000-0000-000000000001', 'cancel-a', 'cancel_a', 'token', 'online', '16700000-0000-0000-0000-000000000001'),
  ('36700000-0000-0000-0000-000000000002', '26700000-0000-0000-0000-000000000001', 'cancel-b', 'cancel_b', 'token', 'online', '16700000-0000-0000-0000-000000000001');
insert into public.profile_groups (id, organization_id, name, created_by)
values ('46700000-0000-0000-0000-000000000001', '26700000-0000-0000-0000-000000000001', 'Grupo de cancelamento', '16700000-0000-0000-0000-000000000001');
insert into public.profile_group_members (organization_id, group_id, profile_id, added_by)
values ('26700000-0000-0000-0000-000000000001', '46700000-0000-0000-0000-000000000001', '36700000-0000-0000-0000-000000000001', '16700000-0000-0000-0000-000000000001');
insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values
  ('56700000-0000-0000-0000-000000000001', '26700000-0000-0000-0000-000000000001', '16700000-0000-0000-0000-000000000001', 'Lote por grupo', 'processing', timezone('utc', now())),
  ('56700000-0000-0000-0000-000000000002', '26700000-0000-0000-0000-000000000001', '16700000-0000-0000-0000-000000000001', 'Lote bloqueado', 'processing', timezone('utc', now())),
  ('56700000-0000-0000-0000-000000000003', '26700000-0000-0000-0000-000000000001', '16700000-0000-0000-0000-000000000001', 'Lote por conta', 'queued', timezone('utc', now()));
insert into public.publication_items (id, organization_id, batch_id, profile_id, format, status, idempotency_key, lease_until, claimed_by)
values
  ('66700000-0000-0000-0000-000000000001', '26700000-0000-0000-0000-000000000001', '56700000-0000-0000-0000-000000000001', '36700000-0000-0000-0000-000000000001', 'image', 'waiting', 'cancel-group-waiting-0001', null, null),
  ('66700000-0000-0000-0000-000000000002', '26700000-0000-0000-0000-000000000001', '56700000-0000-0000-0000-000000000001', '36700000-0000-0000-0000-000000000002', 'image', 'waiting', 'cancel-group-outside-0001', null, null),
  ('66700000-0000-0000-0000-000000000003', '26700000-0000-0000-0000-000000000001', '56700000-0000-0000-0000-000000000002', '36700000-0000-0000-0000-000000000002', 'image', 'preparing', 'cancel-blocked-active-001', timezone('utc', now()) + interval '5 minutes', 'worker-test'),
  ('66700000-0000-0000-0000-000000000004', '26700000-0000-0000-0000-000000000001', '56700000-0000-0000-0000-000000000002', '36700000-0000-0000-0000-000000000001', 'image', 'waiting', 'cancel-blocked-waiting-1', null, null),
  ('66700000-0000-0000-0000-000000000005', '26700000-0000-0000-0000-000000000001', '56700000-0000-0000-0000-000000000003', '36700000-0000-0000-0000-000000000001', 'image', 'suspended', 'cancel-account-suspended-1', null, null);

set local role authenticated;
set local request.jwt.claim.sub = '16700000-0000-0000-0000-000000000001';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.email = 'cancel@example.com';

do $$
declare
  result jsonb;
begin
  result := public.cancel_publication_queue_scope('group', '46700000-0000-0000-0000-000000000001');
  if result ->> 'state' <> 'cancelled' or result ->> 'verified' <> 'true' or result ->> 'cancelledItems' <> '2' then
    raise exception 'cancelamento por grupo não foi confirmado integralmente: %', result;
  end if;
  if (select status from public.publication_items where id = '66700000-0000-0000-0000-000000000001') <> 'cancelled'
    or (select status from public.publication_items where id = '66700000-0000-0000-0000-000000000005') <> 'cancelled' then
    raise exception 'cancelamento por grupo não encerrou todos os itens do perfil membro';
  end if;
  if (select status from public.publication_items where id = '66700000-0000-0000-0000-000000000002') <> 'waiting' then
    raise exception 'cancelamento por grupo atingiu perfil externo ao grupo';
  end if;

  result := public.cancel_publication_queue_scope('batch', '56700000-0000-0000-0000-000000000002');
  if result ->> 'state' <> 'blocked' or result ->> 'blockedItems' <> '1' then
    raise exception 'lote com item em lease deveria ser bloqueado sem alterações: %', result;
  end if;
  if (select status from public.publication_items where id = '66700000-0000-0000-0000-000000000004') <> 'waiting' then
    raise exception 'cancelamento bloqueado alterou item aguardando indevidamente';
  end if;

  update public.publication_items set status = 'failed', lease_until = null, claimed_by = null
  where id = '66700000-0000-0000-0000-000000000003';
  result := public.cancel_publication_queue_scope('batch', '56700000-0000-0000-0000-000000000002');
  if result ->> 'state' <> 'cancelled' or result ->> 'verified' <> 'true' or result ->> 'cancelledItems' <> '2' then
    raise exception 'lote liberado não foi cancelado e verificado: %', result;
  end if;
  if exists (
    select 1 from public.publication_items
    where batch_id = '56700000-0000-0000-0000-000000000002'
      and status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')
  ) then
    raise exception 'a verificação final do lote deixou itens ativos';
  end if;
end;
$$;

reset role;
rollback;
