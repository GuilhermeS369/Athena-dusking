-- Fases 0 e 1 da correção definitiva Zernio.
-- 1. Persiste controles operacionais por organização para permitir congelamento
--    auditável de remoções automáticas durante snapshots/dry-runs.
-- 2. Torna o enqueue observável por correlation_id.
-- 3. Corrige o CASE text -> enum que pode abortar a criação do lote vazio.

create table public.zernio_sync_operational_controls (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  automatic_duplicate_removal_enabled boolean not null default true,
  freeze_reason text check (freeze_reason is null or char_length(trim(freeze_reason)) between 3 and 500),
  freeze_correlation_id uuid,
  frozen_at timestamptz,
  frozen_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default timezone('utc', now()),
  check (
    automatic_duplicate_removal_enabled
    or (freeze_reason is not null and freeze_correlation_id is not null and frozen_at is not null)
  )
);

create trigger zernio_sync_operational_controls_set_updated_at
before update on public.zernio_sync_operational_controls
for each row execute function public.set_updated_at();

alter table public.zernio_sync_operational_controls enable row level security;

create policy zernio_sync_operational_controls_select_admin
  on public.zernio_sync_operational_controls for select to authenticated
  using (public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

revoke all on public.zernio_sync_operational_controls from public, anon, authenticated;
grant select on public.zernio_sync_operational_controls to authenticated;
grant all on public.zernio_sync_operational_controls to service_role;

alter table public.zernio_sync_batches
  add column correlation_id uuid;

update public.zernio_sync_batches
set correlation_id = gen_random_uuid()
where correlation_id is null;

alter table public.zernio_sync_batches
  alter column correlation_id set default gen_random_uuid(),
  alter column correlation_id set not null;

create unique index zernio_sync_batches_correlation_idx
  on public.zernio_sync_batches(correlation_id);

create or replace function public.set_zernio_automatic_duplicate_removal(
  p_organization_id uuid,
  p_enabled boolean,
  p_reason text default null,
  p_correlation_id uuid default null,
  p_requested_by uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  requested_by uuid := coalesce(p_requested_by, auth.uid());
  control_row public.zernio_sync_operational_controls%rowtype;
begin
  if auth.role() <> 'service_role'
     and not public.has_organization_role(p_organization_id, array['admin']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Somente administradores podem alterar o congelamento Zernio.';
  end if;
  if not coalesce(p_enabled, false)
     and (nullif(trim(coalesce(p_reason, '')), '') is null or p_correlation_id is null) then
    raise exception using errcode = '22023', message = 'O congelamento exige motivo e correlation_id.';
  end if;

  insert into public.zernio_sync_operational_controls (
    organization_id,
    automatic_duplicate_removal_enabled,
    freeze_reason,
    freeze_correlation_id,
    frozen_at,
    frozen_by
  ) values (
    p_organization_id,
    coalesce(p_enabled, false),
    case when coalesce(p_enabled, false) then null else left(trim(p_reason), 500) end,
    case when coalesce(p_enabled, false) then null else p_correlation_id end,
    case when coalesce(p_enabled, false) then null else timezone('utc', now()) end,
    case when coalesce(p_enabled, false) then null else requested_by end
  )
  on conflict (organization_id) do update set
    automatic_duplicate_removal_enabled = excluded.automatic_duplicate_removal_enabled,
    freeze_reason = excluded.freeze_reason,
    freeze_correlation_id = excluded.freeze_correlation_id,
    frozen_at = excluded.frozen_at,
    frozen_by = excluded.frozen_by,
    updated_at = timezone('utc', now())
  returning * into control_row;

  return jsonb_build_object(
    'organizationId', control_row.organization_id,
    'automaticDuplicateRemovalEnabled', control_row.automatic_duplicate_removal_enabled,
    'freezeCorrelationId', control_row.freeze_correlation_id,
    'frozenAt', control_row.frozen_at
  );
end;
$$;

create or replace function public.enqueue_zernio_organization_sync_batch(
  p_organization_id uuid,
  p_requested_by uuid,
  p_lock_holder uuid,
  p_correlation_id uuid default null
)
returns table (batch_id uuid, total_connections integer, reused boolean, correlation_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  active_batch_id uuid;
  active_correlation_id uuid;
  created_batch_id uuid;
  created_correlation_id uuid := coalesce(p_correlation_id, gen_random_uuid());
  connection_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':zernio-sync-enqueue', 0));

  select sync_batch.id, sync_batch.correlation_id
  into active_batch_id, active_correlation_id
  from public.zernio_sync_batches sync_batch
  where sync_batch.organization_id = p_organization_id
    and sync_batch.status = 'processing'::public.zernio_sync_batch_status
  order by sync_batch.created_at desc
  limit 1
  for update;

  if active_batch_id is not null then
    select count(*)::integer into connection_count
    from public.zernio_sync_batch_items item
    where item.batch_id = active_batch_id;

    batch_id := active_batch_id;
    total_connections := connection_count;
    reused := true;
    correlation_id := active_correlation_id;
    return next;
    return;
  end if;

  insert into public.zernio_sync_batches (
    organization_id,
    requested_by,
    lock_holder,
    status,
    correlation_id
  ) values (
    p_organization_id,
    p_requested_by,
    p_lock_holder,
    'processing'::public.zernio_sync_batch_status,
    created_correlation_id
  )
  returning id into created_batch_id;

  insert into public.zernio_sync_batch_items (batch_id, organization_id, zernio_connection_id)
  select created_batch_id, p_organization_id, connection.id
  from public.zernio_connections connection
  where connection.organization_id = p_organization_id
    and connection.deleted_at is null
  order by connection.created_at, connection.id;
  get diagnostics connection_count = row_count;

  update public.zernio_sync_batches
  set total_connections = connection_count,
      status = case
        when connection_count = 0 then 'completed'::public.zernio_sync_batch_status
        else 'processing'::public.zernio_sync_batch_status
      end,
      completed_at = case when connection_count = 0 then timezone('utc', now()) else null end
  where id = created_batch_id;

  batch_id := created_batch_id;
  total_connections := connection_count;
  reused := false;
  correlation_id := created_correlation_id;
  return next;
end;
$$;

create or replace function public.schedule_zernio_duplicate_identity_disconnection(
  p_organization_id uuid,
  p_zernio_connection_id uuid,
  p_zernio_account_id text,
  p_username text,
  p_retained_profile_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  identity_value text := lower(nullif(trim(regexp_replace(p_username, '^@', '')), ''));
  connection_row public.zernio_connections%rowtype;
  retained_profile public.instagram_profiles%rowtype;
  incident_row public.zernio_profile_disconnection_incidents%rowtype;
  control_row public.zernio_sync_operational_controls%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  if identity_value is null or nullif(trim(p_zernio_account_id), '') is null then
    raise exception using errcode = '22023', message = 'Identidade ou accountId Zernio inválido.';
  end if;

  select * into control_row
  from public.zernio_sync_operational_controls
  where organization_id = p_organization_id;

  if found and not control_row.automatic_duplicate_removal_enabled then
    return jsonb_build_object(
      'scheduled', false,
      'reason', 'automatic_removal_frozen',
      'correlationId', control_row.freeze_correlation_id
    );
  end if;

  perform pg_advisory_xact_lock(hashtextextended(identity_value, 0));

  select * into connection_row from public.zernio_connections
  where id = p_zernio_connection_id and organization_id = p_organization_id and deleted_at is null
  for update;
  if not found then raise exception 'Conexão Zernio ativa não encontrada.'; end if;

  select * into retained_profile from public.instagram_profiles
  where id = p_retained_profile_id and provider = 'zernio' and deleted_at is null
  for update;
  if not found then raise exception 'Perfil canônico não encontrado.'; end if;
  if retained_profile.organization_id <> p_organization_id then
    raise exception 'Conflito entre organizações requer aprovação explícita; remoção automática bloqueada.';
  end if;
  if lower(trim(regexp_replace(retained_profile.username, '^@', ''))) <> identity_value then
    raise exception 'O perfil canônico não corresponde à identidade informada.';
  end if;
  if retained_profile.zernio_connection_id = p_zernio_connection_id
     and retained_profile.zernio_account_id = trim(p_zernio_account_id) then
    raise exception 'A conta excedente não pode ser o próprio perfil canônico.';
  end if;
  if exists (
    select 1 from public.publication_items item
    where item.organization_id = p_organization_id
      and item.profile_id = retained_profile.id
      and item.status in ('preparing', 'publishing')
  ) then
    return jsonb_build_object('scheduled', false, 'reason', 'active_publication');
  end if;

  insert into public.zernio_profile_disconnection_incidents (
    organization_id, profile_id, zernio_connection_id, zernio_account_id,
    username_snapshot, connection_label_snapshot, signal, source, error_code,
    error_message
  ) values (
    p_organization_id, null, p_zernio_connection_id, trim(p_zernio_account_id),
    identity_value, connection_row.label, 'duplicate_identity_auto_removed',
    'zernio_sync_worker', 'zernio_duplicate_identity_auto_removed',
    left(format('Remoção intencional: @%s já está preservado na chave %s (perfil %s).', identity_value, coalesce((select label from public.zernio_connections where id = retained_profile.zernio_connection_id), 'canônica'), retained_profile.id), 1200)
  ) on conflict (organization_id, zernio_connection_id, zernio_account_id) where signal = 'duplicate_identity_auto_removed' do update
    set updated_at = timezone('utc', now())
  returning * into incident_row;

  insert into public.zernio_profile_recycling_jobs (organization_id, incident_id)
  values (p_organization_id, incident_row.id)
  on conflict (incident_id) do nothing;

  return jsonb_build_object(
    'scheduled', true,
    'incidentId', incident_row.id,
    'retainedProfileId', retained_profile.id,
    'duplicateProfileId', null
  );
end;
$$;

revoke all on function public.set_zernio_automatic_duplicate_removal(uuid, boolean, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.set_zernio_automatic_duplicate_removal(uuid, boolean, text, uuid, uuid) to service_role;

revoke all on function public.enqueue_zernio_organization_sync_batch(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.enqueue_zernio_organization_sync_batch(uuid, uuid, uuid, uuid) to service_role;

revoke all on function public.schedule_zernio_duplicate_identity_disconnection(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.schedule_zernio_duplicate_identity_disconnection(uuid, uuid, text, text, uuid) to service_role;

notify pgrst, 'reload schema';
