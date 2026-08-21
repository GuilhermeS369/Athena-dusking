-- Reduz leituras de histórico transferidas à aplicação. As funções retornam
-- somente agregados autorizados para a organização ativa.

create index if not exists publication_batches_org_created_page_idx
  on public.publication_batches (organization_id, created_at desc, id desc);

create index if not exists publication_items_org_batch_status_execute_idx
  on public.publication_items (organization_id, batch_id, status, execute_at);

create index if not exists publication_item_media_item_position_idx
  on public.publication_item_media (publication_item_id, position);

create or replace function public.get_media_publication_states(
  p_organization_id uuid,
  p_media_asset_ids uuid[]
)
returns table (
  media_asset_id uuid,
  scheduled_count integer,
  next_scheduled_at timestamptz,
  has_published boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    link.media_asset_id,
    count(*) filter (
      where item.status in ('waiting', 'ready', 'preparing', 'publishing')
    )::integer as scheduled_count,
    min(item.execute_at) filter (
      where item.status in ('waiting', 'ready', 'preparing', 'publishing')
    ) as next_scheduled_at,
    coalesce(bool_or(item.status = 'published' or item.published_at is not null), false) as has_published
  from public.publication_item_media link
  join public.publication_items item
    on item.id = link.publication_item_id
   and item.organization_id = link.organization_id
  where link.organization_id = p_organization_id
    and link.media_asset_id = any(p_media_asset_ids)
    and public.is_organization_member(p_organization_id)
  group by link.media_asset_id;
$$;

create or replace function public.get_profile_publication_metrics(
  p_organization_id uuid
)
returns table (
  profile_id uuid,
  format public.publication_format,
  status public.publication_item_status,
  total integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    item.profile_id,
    item.format,
    item.status,
    count(*)::integer as total
  from public.publication_items item
  where item.organization_id = p_organization_id
    and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'published')
    and public.is_organization_member(p_organization_id)
  group by item.profile_id, item.format, item.status;
$$;

create or replace function public.get_publication_health_summary(
  p_organization_id uuid
)
returns table (
  status public.publication_item_status,
  total integer,
  expired_leases integer,
  due_retries integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    item.status,
    count(*)::integer as total,
    count(*) filter (
      where item.lease_until is not null and item.lease_until <= timezone('utc', now())
    )::integer as expired_leases,
    count(*) filter (
      where item.status = 'failed'
        and item.next_attempt_at is not null
        and item.next_attempt_at <= timezone('utc', now())
    )::integer as due_retries
  from public.publication_items item
  where item.organization_id = p_organization_id
    and item.status in ('waiting', 'preparing', 'publishing', 'failed')
    and public.is_organization_member(p_organization_id)
  group by item.status;
$$;

revoke all on function public.get_media_publication_states(uuid, uuid[]) from public, anon;
revoke all on function public.get_profile_publication_metrics(uuid) from public, anon;
revoke all on function public.get_publication_health_summary(uuid) from public, anon;
grant execute on function public.get_media_publication_states(uuid, uuid[]) to authenticated, service_role;
grant execute on function public.get_profile_publication_metrics(uuid) to authenticated, service_role;
grant execute on function public.get_publication_health_summary(uuid) to authenticated, service_role;
