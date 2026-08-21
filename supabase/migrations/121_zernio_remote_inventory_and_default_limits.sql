-- Fase 2: distingue inventário remoto, vínculos locais, reservas e limite local.
-- Também persiste o limite padrão que será capturado por novos cadastros/lotes.

create table public.zernio_multi_connection_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  default_instagram_slot_limit integer not null default 2
    check (default_instagram_slot_limit between 1 and 100),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create trigger zernio_multi_connection_settings_set_updated_at
before update on public.zernio_multi_connection_settings
for each row execute function public.set_updated_at();

alter table public.zernio_multi_connection_settings enable row level security;
create policy zernio_multi_connection_settings_select_member
  on public.zernio_multi_connection_settings for select to authenticated
  using (public.is_organization_member(organization_id));
create policy zernio_multi_connection_settings_insert_admin
  on public.zernio_multi_connection_settings for insert to authenticated
  with check (
    updated_by = (select auth.uid())
    and public.has_organization_role(organization_id, array['admin']::public.organization_role[])
  );
create policy zernio_multi_connection_settings_update_admin
  on public.zernio_multi_connection_settings for update to authenticated
  using (public.has_organization_role(organization_id, array['admin']::public.organization_role[]))
  with check (
    updated_by = (select auth.uid())
    and public.has_organization_role(organization_id, array['admin']::public.organization_role[])
  );

insert into public.zernio_multi_connection_settings (organization_id)
select distinct organization_id from public.zernio_connections
on conflict (organization_id) do nothing;

alter table public.zernio_connections
  add column remote_instagram_account_count integer
    check (remote_instagram_account_count is null or remote_instagram_account_count >= 0),
  add column remote_inventory_checked_at timestamptz,
  add column remote_inventory_error_code text,
  add column remote_inventory_error_message text;

alter table public.zernio_connection_import_batches
  add column default_instagram_slot_limit_snapshot integer not null default 2
    check (default_instagram_slot_limit_snapshot between 1 and 100);

alter table public.zernio_connection_import_items
  add column instagram_slot_limit_snapshot integer not null default 2
    check (instagram_slot_limit_snapshot between 1 and 100);

create or replace function public.create_zernio_connection_import_batch(
  p_organization_id uuid,
  p_created_by uuid,
  p_items jsonb
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  new_batch_id uuid;
  item_count integer;
  default_slot_limit integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'O lote precisa conter ao menos uma linha válida.';
  end if;

  select count(*) into item_count from jsonb_array_elements(p_items) as item;
  select coalesce(setting.default_instagram_slot_limit, 2)
  into default_slot_limit
  from (select p_organization_id as organization_id) requested
  left join public.zernio_multi_connection_settings setting
    on setting.organization_id = requested.organization_id;

  insert into public.zernio_connection_import_batches (
    organization_id, created_by, total_count, default_instagram_slot_limit_snapshot
  ) values (
    p_organization_id, p_created_by, item_count, default_slot_limit
  ) returning id into new_batch_id;

  insert into public.zernio_connection_import_items (
    batch_id, organization_id, line_number, label, encrypted_api_key, instagram_slot_limit_snapshot
  )
  select new_batch_id, p_organization_id, (item.value ->> 'lineNumber')::integer,
    item.value ->> 'label', item.value ->> 'encryptedApiKey', default_slot_limit
  from jsonb_array_elements(p_items) as item;

  return new_batch_id;
end;
$$;

drop view public.zernio_connections_safe;
create view public.zernio_connections_safe with (security_invoker = true) as
select
  connection.id, connection.organization_id, connection.label, true as configured,
  connection.zernio_profile_id, connection.status, connection.balance_cents,
  connection.balance_currency, connection.supported_platforms, connection.instagram_slot_limit,
  connection.remote_instagram_account_count, connection.remote_inventory_checked_at,
  connection.remote_inventory_error_code, connection.remote_inventory_error_message,
  connection.last_checked_at, connection.last_success_at, connection.last_failure_at,
  connection.last_sync_at, connection.last_error_code, connection.last_error_message,
  connection.created_by, connection.deleted_at, connection.created_at, connection.updated_at,
  coalesce((select count(*)::integer from public.instagram_profiles profile
    where profile.organization_id = connection.organization_id and profile.provider = 'zernio'
      and profile.zernio_connection_id = connection.id and profile.deleted_at is null), 0) as instagram_profile_count,
  public.active_zernio_connection_slot_reservation_count(connection.organization_id, connection.id) as active_slot_reservation_count,
  jsonb_build_object(
    'instagram', coalesce(connection.remote_instagram_account_count, 0),
    'tiktok', 0,
    'youtube', 0
  ) as platform_counts
from public.zernio_connections connection;

grant select on public.zernio_multi_connection_settings, public.zernio_connections_safe to authenticated;
grant all on public.zernio_multi_connection_settings to service_role;
revoke all on function public.create_zernio_connection_import_batch(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.create_zernio_connection_import_batch(uuid, uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
