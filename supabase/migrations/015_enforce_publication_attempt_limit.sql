-- Impede retries automáticos depois da segunda tentativa.

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
language plpgsql security definer set search_path = public
as $$
begin
  return query
  with candidates as (
    select item_row.id
    from public.publication_items as item_row
    where item_row.status in ('ready', 'waiting', 'preparing', 'failed')
      and item_row.attempt_count < 2
      and (item_row.execute_at is null or item_row.execute_at <= timezone('utc', now()))
      and (item_row.next_attempt_at is null or item_row.next_attempt_at <= timezone('utc', now()))
      and (item_row.lease_until is null or item_row.lease_until <= timezone('utc', now()))
    order by coalesce(item_row.execute_at, item_row.created_at), item_row.created_at, item_row.id
    for update skip locked limit p_limit
  ), claimed as (
    update public.publication_items as item_update
    set status = 'preparing', claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        next_attempt_at = null, attempt_count = item_update.attempt_count + 1
    from candidates
    where item_update.id = candidates.id
    returning item_update.id, item_update.organization_id, item_update.batch_id,
      item_update.profile_id, item_update.format, item_update.status,
      item_update.execute_at, item_update.caption, item_update.idempotency_key,
      item_update.attempt_count, item_update.creation_id, item_update.lease_until
  )
  select claimed.* from claimed;
end;
$$;

revoke all on function public.claim_publication_items(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_publication_items(text, integer, integer) to service_role;
