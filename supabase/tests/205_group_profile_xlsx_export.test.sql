-- Exportação de grupos: combina o membro atual e a queda Zernio confirmada,
-- sem expor registros de outra organização ao membro autenticado.
begin;

create or replace function auth.jwt()
returns jsonb language sql stable as $$
  select jsonb_build_object('sub', nullif(current_setting('request.jwt.claim.sub', true), ''), 'role', 'authenticated')
$$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, confirmed_at, created_at, updated_at)
values ('20500000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'group-export-205@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));
insert into public.organizations (id, name, slug, created_by)
values
  ('20500000-0000-0000-0000-000000000002', 'Organização de exportação', 'organizacao-exportacao-205', '20500000-0000-0000-0000-000000000001'),
  ('20500000-0000-0000-0000-000000000003', 'Organização isolada', 'organizacao-isolada-205', '20500000-0000-0000-0000-000000000001');
insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('20500000-0000-0000-0000-000000000002', '20500000-0000-0000-0000-000000000001', 'admin', '20500000-0000-0000-0000-000000000001');

insert into public.profile_groups (id, organization_id, name, consumption_mode, created_by)
values
  ('20500000-0000-0000-0000-000000000004', '20500000-0000-0000-0000-000000000002', 'Grupo exportável', 'reusable', '20500000-0000-0000-0000-000000000001'),
  ('20500000-0000-0000-0000-000000000005', '20500000-0000-0000-0000-000000000003', 'Grupo de outra organização', 'single_use', '20500000-0000-0000-0000-000000000001');
insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by)
values
  ('20500000-0000-0000-0000-000000000006', '20500000-0000-0000-0000-000000000002', 'group-export-current', 'perfil_atual_205', 'token', 'online', '20500000-0000-0000-0000-000000000001'),
  ('20500000-0000-0000-0000-000000000007', '20500000-0000-0000-0000-000000000002', 'group-export-fallen', 'perfil_caiu_205', 'token', 'offline', '20500000-0000-0000-0000-000000000001'),
  ('20500000-0000-0000-0000-000000000008', '20500000-0000-0000-0000-000000000003', 'group-export-isolated', 'perfil_isolado_205', 'token', 'online', '20500000-0000-0000-0000-000000000001');
insert into public.profile_group_members (organization_id, group_id, profile_id, added_by)
values ('20500000-0000-0000-0000-000000000002', '20500000-0000-0000-0000-000000000004', '20500000-0000-0000-0000-000000000006', '20500000-0000-0000-0000-000000000001');
insert into public.zernio_profile_disconnection_incidents (id, organization_id, profile_id, zernio_account_id, username_snapshot, connection_label_snapshot, signal, error_code, error_message, state, finalized_at)
values ('20500000-0000-0000-0000-000000000009', '20500000-0000-0000-0000-000000000002', '20500000-0000-0000-0000-000000000007', 'zernio-account-205', 'perfil_caiu_205', 'Zernio 205', 'auth_expired', 'oauth_expired', 'Autorização da conta expirou.', 'completed', timezone('utc', now()));
insert into public.zernio_group_profile_removal_events (organization_id, group_id, profile_id, incident_id, removal_sequence, signal, counted_at)
values ('20500000-0000-0000-0000-000000000002', '20500000-0000-0000-0000-000000000004', '20500000-0000-0000-0000-000000000007', '20500000-0000-0000-0000-000000000009', 1, 'auth_expired', timezone('utc', now()));

set local role authenticated;
set local request.jwt.claim.sub = '20500000-0000-0000-0000-000000000001';

do $$
declare export_rows jsonb;
begin
  select jsonb_agg(to_jsonb(row)) into export_rows
  from public.group_profile_export_rows row
  where row.group_id = '20500000-0000-0000-0000-000000000004';

  if jsonb_array_length(coalesce(export_rows, '[]'::jsonb)) <> 2 then
    raise exception 'a exportação deveria conter um perfil atual e um perfil caído: %', export_rows;
  end if;
  if not exists (select 1 from jsonb_array_elements(export_rows) row where row ->> 'row_kind' = 'current' and row ->> 'username' = 'perfil_atual_205') then
    raise exception 'perfil atual não encontrado na exportação: %', export_rows;
  end if;
  if not exists (select 1 from jsonb_array_elements(export_rows) row where row ->> 'row_kind' = 'fallen' and row ->> 'zernio_connection_label' = 'Zernio 205' and row ->> 'profile_status' = 'fallen') then
    raise exception 'queda confirmada não foi preservada na exportação: %', export_rows;
  end if;
  if exists (select 1 from public.group_profile_export_rows where group_id = '20500000-0000-0000-0000-000000000005') then
    raise exception 'a view expôs dados de organização sem associação do usuário.';
  end if;
end;
$$;

reset role;
rollback;
