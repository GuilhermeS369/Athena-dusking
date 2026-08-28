-- Executar somente em PostgreSQL local/isolado depois do arquivo de setup.
explain (analyze, buffers, format text)
select id, occurred_at, domain, severity, stable_code, message
from instagram_observability_bench.events
where organization_id = 1 and profile_id = 1733 and publication_format = 'story'
  and occurred_at >= now() - interval '14 days'
order by occurred_at desc, id desc limit 50;

explain (analyze, buffers, format text)
select id, occurred_at, stable_code, message
from instagram_observability_bench.events
where organization_id = 1 and domain = 'connection' and connection_id = 42
  and occurred_at >= now() - interval '7 days'
order by occurred_at desc, id desc limit 50;

explain (analyze, buffers, format text)
select id, occurred_at, stable_code, message
from instagram_observability_bench.events
where organization_id = 1 and search_document @@ plainto_tsquery('simple', 'observabilidade 1999999')
order by occurred_at desc, id desc limit 50;

explain (analyze, buffers, format text)
select status, count(*), count(*) filter (where execute_at < now()) as overdue
from instagram_observability_bench.queue_items
where organization_id = 1 and status in ('scheduled','processing','retrying')
group by status;

-- Limpeza segura: drop schema instagram_observability_bench cascade;
