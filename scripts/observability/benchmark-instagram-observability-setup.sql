do $$
begin
  drop schema if exists instagram_observability_bench cascade;
  create schema instagram_observability_bench;

  create unlogged table instagram_observability_bench.events (
    id bigint generated always as identity primary key,
    organization_id integer not null,
    occurred_at timestamptz not null,
    domain text not null,
    severity text not null,
    treatment_state text not null,
    profile_id integer,
    connection_id integer,
    publication_format text,
    provider text,
    source_status text,
    worker_kind text,
    stable_code text not null,
    message text not null,
    search_document tsvector generated always as (to_tsvector('simple', message || ' ' || stable_code)) stored
  );

  insert into instagram_observability_bench.events (
    organization_id, occurred_at, domain, severity, treatment_state, profile_id,
    connection_id, publication_format, provider, source_status, worker_kind,
    stable_code, message
  )
  select
    1,
    now() - ((series % 1209600) * interval '1 second'),
    (array['publication','scheduling','connection','account','worker','analytics','media'])[1 + series % 7],
    (array['info','info','info','warning','error'])[1 + series % 5],
    (array['resolved','resolved','auto_recovering','action_required'])[1 + series % 4],
    1 + series % 2500,
    1 + series % 100,
    (array['story','reel','image','carousel'])[1 + series % 4],
    (array['zernio','meta_official'])[1 + series % 2],
    (array['queued','processing','published','failed','retrying'])[1 + series % 5],
    (array['publication','publication_planner','media_deletion','profile_analytics','zernio_sync'])[1 + series % 5],
    'bench_code_' || series % 120,
    'Evento sintético de observabilidade ' || series
  from generate_series(1, 2000000) series;

  create index events_org_time_idx on instagram_observability_bench.events (organization_id, occurred_at desc, id desc);
  create index events_profile_time_idx on instagram_observability_bench.events (organization_id, profile_id, occurred_at desc, id desc) where profile_id is not null;
  create index events_domain_time_idx on instagram_observability_bench.events (organization_id, domain, occurred_at desc, id desc);
  create index events_format_time_idx on instagram_observability_bench.events (organization_id, publication_format, occurred_at desc, id desc) where publication_format is not null;
  create index events_connection_time_idx on instagram_observability_bench.events (organization_id, connection_id, occurred_at desc, id desc) where connection_id is not null;
  create index events_search_idx on instagram_observability_bench.events using gin (search_document);

  create unlogged table instagram_observability_bench.queue_items (
    id bigint generated always as identity primary key,
    organization_id integer not null,
    profile_id integer not null,
    execute_at timestamptz not null,
    status text not null,
    retry_count integer not null
  );
  insert into instagram_observability_bench.queue_items (organization_id, profile_id, execute_at, status, retry_count)
  select 1, 1 + series % 2500, now() + ((series % 86400) * interval '1 second'),
    (array['scheduled','processing','retrying','published','failed'])[1 + series % 5], series % 4
  from generate_series(1, 50000) series;
  create index queue_org_status_time_idx on instagram_observability_bench.queue_items (organization_id, status, execute_at);

  analyze instagram_observability_bench.events;
  analyze instagram_observability_bench.queue_items;
end;
$$;
