-- O DELETE de um account ID compartilhado é global. A confirmação remota já
-- lê as duas chaves; esta RPC persiste exatamente essas contagens antes da
-- finalização local para que o Bulk libere os slots imediatamente.

create or replace function public.record_zernio_shared_global_removal_inventory(
  p_incident_id uuid,
  p_job_id uuid,
  p_worker_id text,
  p_snapshot_at timestamptz,
  p_retained_instagram_count integer,
  p_removed_instagram_count integer
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  incident_row public.zernio_profile_disconnection_incidents%rowtype;
  job_row public.zernio_profile_recycling_jobs%rowtype;
  updated_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao endpoint administrativo.';
  end if;
  if p_snapshot_at is null
    or p_snapshot_at < timezone('utc', now()) - interval '10 minutes'
    or p_retained_instagram_count < 0
    or p_removed_instagram_count < 0 then
    raise exception using errcode = '22023', message = 'Snapshot remoto inválido ou vencido.';
  end if;

  select incident.* into incident_row
  from public.zernio_profile_disconnection_incidents incident
  where incident.id = p_incident_id
    and incident.signal = 'duplicate_identity_auto_removed'
    and incident.retained_zernio_account_id is not null
    and incident.retained_zernio_account_id = incident.removed_zernio_account_id
  for update;
  if not found then raise exception 'Incidente global compartilhado não encontrado.'; end if;

  select job.* into job_row
  from public.zernio_profile_recycling_jobs job
  where job.id = p_job_id
    and job.incident_id = incident_row.id
    and job.claimed_by = trim(p_worker_id)
    and job.lease_until > timezone('utc', now())
    and job.status = 'processing'
  for update;
  if not found then raise exception 'Job não está sob lease deste executor administrativo.'; end if;

  update public.zernio_connections connection set
    remote_instagram_account_count = case
      when connection.id = incident_row.retained_zernio_connection_id then p_retained_instagram_count
      when connection.id = incident_row.removed_zernio_connection_id then p_removed_instagram_count
    end,
    remote_inventory_checked_at = p_snapshot_at,
    remote_inventory_error_code = null,
    remote_inventory_error_message = null,
    last_checked_at = p_snapshot_at,
    last_success_at = p_snapshot_at
  where connection.organization_id = incident_row.organization_id
    and connection.deleted_at is null
    and connection.id in (
      incident_row.retained_zernio_connection_id,
      incident_row.removed_zernio_connection_id
    );
  get diagnostics updated_count = row_count;
  if updated_count <> 2 then
    raise exception 'As duas conexões do incidente não foram atualizadas.';
  end if;

  return jsonb_build_object(
    'recorded', true,
    'snapshotAt', p_snapshot_at,
    'retainedInstagramCount', p_retained_instagram_count,
    'removedInstagramCount', p_removed_instagram_count
  );
end;
$$;

revoke all on function public.record_zernio_shared_global_removal_inventory(
  uuid, uuid, text, timestamptz, integer, integer
) from public, anon, authenticated;
grant execute on function public.record_zernio_shared_global_removal_inventory(
  uuid, uuid, text, timestamptz, integer, integer
) to service_role;

-- Repara somente snapshots que ainda são anteriores à remoção global já
-- concluída. A condição temporal torna o reparo seguro e idempotente.
with removed_accounts as (
  select
    incident.retained_zernio_connection_id as connection_id,
    incident.remote_completed_at
  from public.zernio_profile_disconnection_incidents incident
  where incident.state = 'completed'
    and incident.error_code = 'zernio_shared_account_globally_removed'
    and incident.remote_result in ('remote_deleted', 'already_disconnected_404')
    and incident.retained_zernio_account_id = incident.removed_zernio_account_id
    and incident.remote_completed_at is not null
  union all
  select
    incident.removed_zernio_connection_id,
    incident.remote_completed_at
  from public.zernio_profile_disconnection_incidents incident
  where incident.state = 'completed'
    and incident.error_code = 'zernio_shared_account_globally_removed'
    and incident.remote_result in ('remote_deleted', 'already_disconnected_404')
    and incident.retained_zernio_account_id = incident.removed_zernio_account_id
    and incident.remote_completed_at is not null
), stale_removals as (
  select
    connection.id as connection_id,
    count(*)::integer as removed_count,
    max(removed.remote_completed_at) as latest_removal_at
  from public.zernio_connections connection
  join removed_accounts removed on removed.connection_id = connection.id
  where connection.remote_instagram_account_count is not null
    and connection.remote_inventory_checked_at < removed.remote_completed_at
  group by connection.id
)
update public.zernio_connections connection set
  remote_instagram_account_count = greatest(
    0,
    connection.remote_instagram_account_count - stale.removed_count
  ),
  remote_inventory_checked_at = stale.latest_removal_at,
  remote_inventory_error_code = null,
  remote_inventory_error_message = null
from stale_removals stale
where connection.id = stale.connection_id;

notify pgrst, 'reload schema';
