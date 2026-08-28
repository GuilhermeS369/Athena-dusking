-- Mantém o relatório agregado de /operacao abaixo do statement_timeout mesmo
-- quando a janela recente já contém dezenas de milhares de itens e eventos.

create index if not exists publication_items_dispatch_telemetry_published_idx
  on public.publication_items (organization_id, published_at desc, profile_id)
  include (execute_at)
  where status = 'published';

create index if not exists publication_items_dispatch_telemetry_failed_idx
  on public.publication_items (organization_id, updated_at desc, profile_id)
  where status = 'failed';

create index if not exists publication_item_events_dispatch_telemetry_idx
  on public.publication_item_events (organization_id, created_at desc)
  include (publication_item_id, event_type, error_code, error_message);

create index if not exists publication_worker_cycles_dispatch_telemetry_idx
  on public.publication_worker_cycle_events (worker_kind, created_at desc)
  include (phase, duration_ms, metadata);
