-- Publicações que nunca chegaram ao provedor deixam de ser elegíveis para
-- envio após 60 segundos. Criações já aceitas continuam sempre elegíveis para
-- reconciliação, evitando duplicidade e falsos negativos.

create or replace function public.claim_publication_items(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  id uuid, organization_id uuid, batch_id uuid, profile_id uuid,
  format public.publication_format, status public.publication_item_status,
  execute_at timestamptz, caption text, idempotency_key text,
  attempt_count integer, creation_id text, lease_until timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode reivindicar publicações.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_limit not between 1 and 100 or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Limite ou lease de claim inválido';
  end if;

  return query
  with eligible_source as (
    select item.id, item.organization_id, item.profile_id, item.execute_at, item.created_at,
      case when item.creation_id is not null then 0 else 1 end as priority_band
    from public.publication_items item
    where item.status in ('ready', 'waiting', 'preparing', 'failed')
      and (item.status <> 'failed' or (item.attempt_count < 5 and item.next_attempt_at is not null))
      and (item.execute_at is null or item.execute_at <= timezone('utc', now()))
      and (
        item.creation_id is not null
        or item.execute_at is null
        or item.execute_at >= timezone('utc', now()) - interval '60 seconds'
      )
      and (item.next_attempt_at is null or item.next_attempt_at <= timezone('utc', now()))
      and (item.lease_until is null or item.lease_until <= timezone('utc', now()))
      and (item.pipeline_version = 1 or item.creation_id is not null or item.preparation_status = 'ready')
      and not (coalesce(item.zernio_recovery_count, 0) > 0 and item.creation_id is null)
      and not exists (
        select 1 from public.publication_batch_circuit_breakers breaker
        where breaker.batch_id = item.batch_id and breaker.paused_at is not null
      )
      and not (
        item.pipeline_version = 1 and item.creation_id is null
        and item.idempotency_key like 'bulk:%'
        and exists (
          select 1 from public.publication_slot_risk_incidents risk
          where risk.organization_id = item.organization_id
            and risk.batch_id = item.batch_id
            and risk.slot_execute_at = item.execute_at and risk.state = 'at_risk'
        )
      )
  ), eligible as (
    select source.*,
      row_number() over (partition by source.organization_id order by source.priority_band, coalesce(source.execute_at, source.created_at), source.id) as org_position,
      row_number() over (partition by source.profile_id order by source.priority_band, coalesce(source.execute_at, source.created_at), source.id) as profile_position
    from eligible_source source
  ), selected as (
    select eligible.id from eligible
    order by eligible.priority_band, eligible.profile_position, eligible.org_position,
      coalesce(eligible.execute_at, eligible.created_at), eligible.organization_id, eligible.id
    limit p_limit
  ), locked as (
    select item.id from public.publication_items item
    join selected on selected.id = item.id
    for update of item skip locked
  ), claimed as (
    update public.publication_items item
    set status = 'preparing', claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        next_attempt_at = null,
        attempt_count = item.attempt_count + case when item.creation_id is null or item.status = 'failed' then 1 else 0 end
    from locked where item.id = locked.id
    returning item.id, item.organization_id, item.batch_id, item.profile_id,
      item.format, item.status, item.execute_at, item.caption, item.idempotency_key,
      item.attempt_count, item.creation_id, item.lease_until
  ), updated_batches as (
    update public.publication_batches batch set status = 'processing'
    where batch.id in (select distinct claimed.batch_id from claimed)
      and batch.status in ('queued', 'validating')
  )
  select * from claimed;
end;
$$;

revoke all on function public.claim_publication_items(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_publication_items(text, integer, integer)
  to service_role;

notify pgrst, 'reload schema';
