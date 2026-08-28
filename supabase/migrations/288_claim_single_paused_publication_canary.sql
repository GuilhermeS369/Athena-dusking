-- Permite um canário explícito e auditável sem reabrir o lote inteiro.
-- Uso exclusivo do service_role durante rollout controlado.

create or replace function public.claim_single_paused_publication_canary(
  p_item_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 180
)
returns table (
  id uuid, organization_id uuid, batch_id uuid, profile_id uuid,
  format public.publication_format, status public.publication_item_status,
  execute_at timestamptz, caption text, idempotency_key text,
  attempt_count integer, creation_id text, lease_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Canário permitido somente ao worker.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Lease de canário inválido.';
  end if;

  return query
  with locked as (
    select item.id
    from public.publication_items item
    where item.id = p_item_id
      and item.status in ('waiting', 'ready')
      and item.creation_id is null
      and item.execute_at <= timezone('utc', now())
      and (item.lease_until is null or item.lease_until <= timezone('utc', now()))
      and (item.pipeline_version = 1 or item.preparation_status = 'ready')
      and exists (
        select 1 from public.publication_batch_circuit_breakers breaker
        where breaker.batch_id = item.batch_id and breaker.paused_at is not null
      )
    for update of item skip locked
  ), claimed as (
    update public.publication_items item
    set status = 'preparing', claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        next_attempt_at = null,
        attempt_count = item.attempt_count + 1
    from locked
    where item.id = locked.id
    returning item.id, item.organization_id, item.batch_id, item.profile_id,
      item.format, item.status, item.execute_at, item.caption, item.idempotency_key,
      item.attempt_count, item.creation_id, item.lease_until
  )
  select * from claimed;
end;
$$;

revoke all on function public.claim_single_paused_publication_canary(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_single_paused_publication_canary(uuid, text, integer)
  to service_role;
