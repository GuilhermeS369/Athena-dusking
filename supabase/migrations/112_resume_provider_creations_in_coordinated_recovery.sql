-- Itens que já receberam creation_id do provedor não devem ficar bloqueados no
-- slot em risco. Eles não iniciam uma nova publicação: o dispatcher apenas
-- retoma o polling/confirmação idempotente da criação já aceita.
create or replace function public.claim_publication_slot_recovery_items(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  id uuid,
  organization_id uuid,
  batch_id uuid,
  profile_id uuid,
  format public.publication_format,
  status public.publication_item_status,
  execute_at timestamptz,
  caption text,
  idempotency_key text,
  attempt_count integer,
  creation_id text,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  now_at timestamptz := timezone('utc', now());
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Limite de recuperação deve estar entre 1 e 100';
  end if;
  if p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 900 segundos';
  end if;

  return query
  with eligible as (
    select item_row.id, item_row.organization_id, item_row.execute_at, item_row.created_at,
      settings.max_items_per_cycle,
      row_number() over (
        partition by item_row.organization_id
        order by item_row.execute_at, item_row.created_at, item_row.id
      ) as organization_position
    from public.publication_items item_row
    join public.publication_slot_risk_incidents incident
      on incident.organization_id = item_row.organization_id
      and incident.batch_id = item_row.batch_id
      and incident.slot_execute_at = item_row.execute_at
      and incident.state = 'at_risk'
    join lateral (
      select setting.*
      from public.publication_slot_recovery_settings setting
      where setting.enabled
        and (setting.organization_id = item_row.organization_id or setting.organization_id is null)
      order by (setting.organization_id is not null) desc, setting.updated_at desc, setting.id desc
      limit 1
    ) settings on true
    where item_row.idempotency_key like 'bulk:%'
      and item_row.status in ('waiting', 'ready')
      and (item_row.next_attempt_at is null or item_row.next_attempt_at <= now_at)
      and (item_row.lease_until is null or item_row.lease_until <= now_at)
      and item_row.execute_at >= now_at - make_interval(secs => settings.max_recovery_delay_seconds)
      and (
        incident.next_slot_execute_at is null
        or incident.next_slot_execute_at >= now_at + make_interval(secs => settings.min_safe_window_seconds)
      )
  ), selected as (
    select eligible.id
    from eligible
    where eligible.organization_position <= eligible.max_items_per_cycle
    order by eligible.organization_position, eligible.execute_at, eligible.organization_id, eligible.id
    limit p_limit
  ), candidates as (
    select item_row.id
    from public.publication_items item_row
    join selected on selected.id = item_row.id
    for update of item_row skip locked
  ), claimed as (
    update public.publication_items item_row
    set status = 'preparing',
        claimed_by = trim(p_worker_id),
        lease_until = now_at + make_interval(secs => p_lease_seconds),
        next_attempt_at = null,
        attempt_count = item_row.attempt_count + case
          when item_row.creation_id is null or item_row.status = 'failed' then 1 else 0
        end,
        last_error_code = null,
        last_error_message = null
    from candidates
    where item_row.id = candidates.id
    returning item_row.id, item_row.organization_id, item_row.batch_id, item_row.profile_id,
      item_row.format, item_row.status, item_row.execute_at, item_row.caption,
      item_row.idempotency_key, item_row.attempt_count, item_row.creation_id, item_row.lease_until
  ), updated_incidents as (
    update public.publication_slot_risk_incidents incident
    set decision_reason = 'coordinated_recovery_in_progress',
        last_worker_id = trim(p_worker_id)
    where exists (
      select 1 from claimed
      where claimed.organization_id = incident.organization_id
        and claimed.batch_id = incident.batch_id
        and claimed.execute_at = incident.slot_execute_at
    )
      and incident.state = 'at_risk'
  ), updated_batches as (
    update public.publication_batches batch_row
    set status = 'processing'
    where batch_row.id in (select distinct claimed.batch_id from claimed)
      and batch_row.status in ('queued', 'validating')
  )
  select * from claimed;
end;
$$;

revoke all on function public.claim_publication_slot_recovery_items(text, integer, integer)
from public, anon, authenticated;
grant execute on function public.claim_publication_slot_recovery_items(text, integer, integer)
to service_role;

notify pgrst, 'reload schema';
