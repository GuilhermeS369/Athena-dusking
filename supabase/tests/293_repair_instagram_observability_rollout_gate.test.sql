begin;

select '1..4';

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values (
  '29300000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'instagram-293@example.com', 'x', now(), now(), now()
);
insert into public.organizations (id, name, slug, created_by)
values (
  '29300000-0000-4000-8000-000000000002',
  'Instagram 293', 'instagram-293', '29300000-0000-4000-8000-000000000001'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

do $$
begin
  if to_regprocedure('public.instagram_record_observability_api_metric(uuid,text,integer,integer,integer,jsonb)') is null
    or to_regprocedure('public.maintain_instagram_legacy_log_retention_source(text,integer,integer)') is null then
    raise exception 'Funções novas de telemetria/retenção não foram instaladas.';
  end if;
end;
$$;
select 'ok 1 - funções segmentadas instaladas';

select public.instagram_record_observability_api_metric(
  '29300000-0000-4000-8000-000000000002', 'events_test_293', 200, 300, 1000,
  '{"context":100,"query":200}'::jsonb
);
select public.instagram_record_observability_api_metric(
  '29300000-0000-4000-8000-000000000002', 'events_test_293', 200, 1200, 2000,
  '{"context":200,"query":400}'::jsonb
);
do $$
declare metric public.instagram_observability_api_rollups_5m%rowtype;
begin
  select * into metric from public.instagram_observability_api_rollups_5m
  where organization_id = '29300000-0000-4000-8000-000000000002'
    and route = 'events_test_293';
  if metric.request_count <> 2 or metric.duration_le_300_count <> 1
    or metric.duration_le_3000_count <> 2
    or metric.stage_duration_ms_sum <> '{"context":300,"query":600}'::jsonb then
    raise exception 'Histograma ou soma por etapa incorretos: %', row_to_json(metric);
  end if;
end;
$$;
select 'ok 2 - telemetria agrega histograma e etapas';

insert into public.instagram_observability_events (
  occurred_at, organization_id, domain, severity, treatment_state, stage,
  event_type, stable_code, source_type, source_id, message
) values
  (timezone('utc', now()) - interval '14 days 10 minutes',
   '29300000-0000-4000-8000-000000000002', 'publication', 'info', 'resolved',
   'retention_test', 'expired', 'expired', 'test_293', 'expired', 'Expirado.'),
  (timezone('utc', now()) - interval '13 days',
   '29300000-0000-4000-8000-000000000002', 'publication', 'info', 'resolved',
   'retention_test', 'current', 'current', 'test_293', 'current', 'Atual.');
select public.maintain_instagram_observability(14, 7, false);
do $$
begin
  if exists (select 1 from public.instagram_observability_events where source_type = 'test_293' and source_id = 'expired')
    or not exists (select 1 from public.instagram_observability_events where source_type = 'test_293' and source_id = 'current') then
    raise exception 'Retenção da partição de borda removeu o conjunto incorreto.';
  end if;
end;
$$;
select 'ok 3 - retenção quente respeita cutoff exato';

insert into public.zernio_publication_request_anomalies (
  id, occurred_at, organization_id, correlation_id, operation, outcome,
  duration_ms, timeout_ms, provider_request_id, error_message, attempt_count
) values
  ('29300000-0000-4000-8000-000000000010', now(), '29300000-0000-4000-8000-000000000002',
   '29300000-0000-4000-8000-000000000011', 'get_post', 'network_error', 1000, 5000, 'request-a', 'fetch failed', 1),
  ('29300000-0000-4000-8000-000000000012', now() + interval '1 millisecond', '29300000-0000-4000-8000-000000000002',
   '29300000-0000-4000-8000-000000000013', 'get_post', 'network_error', 1200, 5000, 'request-b', 'fetch failed', 2);
do $$
begin
  if (select count(distinct fingerprint) from public.instagram_observability_events
      where source_type = 'zernio_publication_request_anomaly'
        and source_id in ('29300000-0000-4000-8000-000000000010','29300000-0000-4000-8000-000000000012')) <> 1 then
    raise exception 'Requests equivalentes ainda fragmentaram incidentes.';
  end if;
end;
$$;
select 'ok 4 - fingerprint ignora identificadores efêmeros';

rollback;
