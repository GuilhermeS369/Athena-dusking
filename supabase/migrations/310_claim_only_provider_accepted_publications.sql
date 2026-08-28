-- Claim exclusivo para reconciliar criações já aceitas pelo provedor.
-- Nunca inclui item sem creation_id e, portanto, nunca inicia postagem nova.

create or replace function public.claim_provider_accepted_publication_items(
  p_worker_id text,
  p_limit integer default 4,
  p_lease_seconds integer default 120
) returns table (
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
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_limit not between 1 and 20 or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Limite ou lease de reconciliação inválido';
  end if;

  return query
  with eligible as (
    select item.id, item.organization_id, item.profile_id, item.execute_at, item.created_at,
      row_number() over (
        partition by item.organization_id
        order by coalesce(item.execute_at, item.created_at), item.profile_id, item.id
      ) as org_position,
      row_number() over (
        partition by item.profile_id
        order by coalesce(item.execute_at, item.created_at), item.id
      ) as profile_position
    from public.publication_items item
    where item.creation_id is not null
      and item.status in ('ready', 'waiting', 'preparing', 'failed')
      and (item.status <> 'failed' or (item.attempt_count < 5 and item.next_attempt_at is not null))
      and (item.execute_at is null or item.execute_at <= timezone('utc', now()))
      and (item.next_attempt_at is null or item.next_attempt_at <= timezone('utc', now()))
      and (item.lease_until is null or item.lease_until <= timezone('utc', now()))
  ), selected as (
    select eligible.id
    from eligible
    order by eligible.profile_position, eligible.org_position,
      coalesce(eligible.execute_at, eligible.created_at), eligible.organization_id, eligible.id
    limit p_limit
  ), locked as (
    select item.id
    from public.publication_items item
    join selected on selected.id = item.id
    where item.creation_id is not null
    for update of item skip locked
  ), claimed as (
    update public.publication_items item
    set status = 'preparing',
        claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        next_attempt_at = null,
        attempt_count = item.attempt_count + case when item.status = 'failed' then 1 else 0 end
    from locked
    where item.id = locked.id and item.creation_id is not null
    returning item.id, item.organization_id, item.batch_id, item.profile_id,
      item.format, item.status, item.execute_at, item.caption, item.idempotency_key,
      item.attempt_count, item.creation_id, item.lease_until
  )
  select * from claimed;
end;
$$;

revoke all on function public.claim_provider_accepted_publication_items(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_provider_accepted_publication_items(text, integer, integer)
  to service_role;

notify pgrst, 'reload schema';
