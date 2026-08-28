\set ON_ERROR_STOP on
\timing on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('25900000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'observability-benchmark@example.invalid', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('25900000-0000-4000-8000-000000000002', 'Observability benchmark', 'observability-benchmark', '25900000-0000-4000-8000-000000000002');

insert into public.twitter_observability_events (
  occurred_at, organization_id, domain, severity, stage, event_type, stable_code,
  worker_name, http_status, provider_code, request_id, post_id, correlation_id,
  source_type, source_id, message, evidence
)
select
  timezone('utc', now()) - (generated.i % 7776000) * interval '1 second',
  '25900000-0000-4000-8000-000000000002'::uuid,
  (array['account','scheduling','publication','worker','connection','analytics','finance']::public.twitter_observability_domain[])[1 + generated.i % 7],
  case when generated.i % 1000 = 0 then 'error'::public.twitter_observability_severity else 'info'::public.twitter_observability_severity end,
  'benchmark_stage_' || generated.i % 8,
  case when generated.i % 1000 = 0 then 'benchmark_failure' else 'benchmark_activity' end,
  case when generated.i % 1000 = 0 then 'provider_timeout' else 'ok' end,
  'benchmark-worker-' || generated.i % 6,
  case when generated.i % 1000 = 0 then 503 else 200 end,
  case when generated.i % 1000 = 0 then 'timeout' else 'ok' end,
  'request-' || generated.i,
  'post-' || generated.i,
  'correlation-' || generated.i % 10000,
  'benchmark', generated.i::text,
  case when generated.i % 1000 = 0 then 'Falha sintética do provedor.' else 'Atividade sintética.' end,
  jsonb_build_object('sequence', generated.i, 'synthetic', true)
from generate_series(1, 2000000) generated(i);

analyze public.twitter_observability_events;
analyze public.twitter_observability_incidents;

do $$
declare total bigint; first_page integer;
begin
  select count(*) into total
  from public.twitter_observability_events
  where organization_id = '25900000-0000-4000-8000-000000000002';
  if total <> 2000000 then raise exception 'Esperados 2.000.000 eventos; obtidos %.', total; end if;

  select count(*) into first_page from (
    select id from public.twitter_observability_events
    where organization_id = '25900000-0000-4000-8000-000000000002'
      and domain = 'publication'
    order by occurred_at desc, id desc limit 50
  ) page;
  if first_page > 50 then raise exception 'Página excedeu 50 registros.'; end if;
end;
$$;

explain (analyze, buffers, format text)
select id, occurred_at, stable_code
from public.twitter_observability_events
where organization_id = '25900000-0000-4000-8000-000000000002'
  and domain = 'publication'
order by occurred_at desc, id desc
limit 50;

explain (analyze, buffers, format text)
select id, status, severity, last_seen_at
from public.twitter_observability_incidents
where organization_id = '25900000-0000-4000-8000-000000000002'
  and status in ('open', 'investigating')
order by severity desc, last_seen_at desc, id desc
limit 50;

rollback;
