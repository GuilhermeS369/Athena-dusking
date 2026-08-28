create index if not exists publication_items_observability_queue_summary_idx
  on public.publication_items (organization_id, status)
  include (lease_until, next_attempt_at, execute_at)
  where archived_at is null
    and status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended');
