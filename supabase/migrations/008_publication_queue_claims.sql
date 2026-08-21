-- Athena Scheduler: claim concorrente e leases curtos para workers de publicação.
-- Estas funções são exclusivas do worker com service_role; nunca devem ser
-- chamadas pelo navegador ou por uma sessão autenticada comum.

create or replace function public.claim_publication_items(
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
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;

  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Limite de claim deve estar entre 1 e 100';
  end if;

  if p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 900 segundos';
  end if;

  return query
  with candidates as (
    select item_row.id
    from public.publication_items item_row
    where item_row.status in ('ready', 'waiting', 'preparing', 'failed')
      and (item_row.execute_at is null or item_row.execute_at <= timezone('utc', now()))
      and (item_row.next_attempt_at is null or item_row.next_attempt_at <= timezone('utc', now()))
      and (item_row.lease_until is null or item_row.lease_until <= timezone('utc', now()))
    order by coalesce(item_row.execute_at, item_row.created_at), item_row.created_at, item_row.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.publication_items item_row
    set
      status = 'preparing',
      claimed_by = trim(p_worker_id),
      lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
      next_attempt_at = null,
      attempt_count = item_row.attempt_count + 1
    from candidates
    where item_row.id = candidates.id
    returning
      item_row.id,
      item_row.organization_id,
      item_row.batch_id,
      item_row.profile_id,
      item_row.format,
      item_row.status,
      item_row.execute_at,
      item_row.caption,
      item_row.idempotency_key,
      item_row.attempt_count,
      item_row.creation_id,
      item_row.lease_until
  ), updated_batches as (
    update public.publication_batches batch_row
    set status = 'processing'
    where batch_row.id in (select distinct batch_id from claimed)
      and batch_row.status in ('queued', 'validating')
  )
  select * from claimed;
end;
$$;

create or replace function public.renew_publication_item_lease(
  p_item_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  renewed_count bigint;
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;

  if p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 900 segundos';
  end if;

  update public.publication_items
  set lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds)
  where id = p_item_id
    and claimed_by = trim(p_worker_id)
    and status in ('preparing', 'publishing')
    and lease_until > timezone('utc', now());

  get diagnostics renewed_count = row_count;
  return renewed_count > 0;
end;
$$;

revoke all on function public.claim_publication_items(text, integer, integer) from public, anon, authenticated;
revoke all on function public.renew_publication_item_lease(uuid, text, integer) from public, anon, authenticated;

grant execute on function public.claim_publication_items(text, integer, integer) to service_role;
grant execute on function public.renew_publication_item_lease(uuid, text, integer) to service_role;
