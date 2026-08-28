begin;

select '1..3';

do $$
declare
  publication_definition text;
  sync_definition text;
  disconnection_definition text;
  anomaly_definition text;
begin
  publication_definition := lower(pg_get_functiondef(
    'public.project_publication_item_event_to_instagram_observability()'::regprocedure
  ));
  sync_definition := lower(pg_get_functiondef(
    'public.project_zernio_sync_log_to_instagram_observability()'::regprocedure
  ));
  disconnection_definition := lower(pg_get_functiondef(
    'public.project_zernio_disconnection_to_instagram_observability()'::regprocedure
  ));
  anomaly_definition := lower(pg_get_functiondef(
    'public.project_zernio_request_anomaly_to_instagram_observability()'::regprocedure
  ));

  if publication_definition not like '%exception when others%'
    or publication_definition not like '%::public.instagram_observability_severity%'
    or publication_definition not like '%::public.instagram_observability_treatment%' then
    raise exception 'Projeção de publicação não está tipada e isolada.';
  end if;
  if sync_definition not like '%exception when others%'
    or sync_definition not like '%::public.instagram_observability_severity%'
    or sync_definition not like '%::public.instagram_observability_treatment%' then
    raise exception 'Projeção de sincronização não está tipada e isolada.';
  end if;
  if disconnection_definition not like '%exception when others%'
    or disconnection_definition not like '%::public.instagram_observability_severity%'
    or disconnection_definition not like '%::public.instagram_observability_treatment%' then
    raise exception 'Projeção de desconexão não está tipada e isolada.';
  end if;
  if anomaly_definition not like '%exception when others%'
    or anomaly_definition not like '%::public.instagram_observability_domain%'
    or anomaly_definition not like '%::public.instagram_observability_severity%'
    or anomaly_definition not like '%::public.instagram_observability_treatment%' then
    raise exception 'Projeção de anomalia não está tipada e isolada.';
  end if;
end;
$$;
select 'ok 1 - projeções instaladas estão tipadas e isoladas';

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

create temporary table zernio_sync_projection_source_286 (
  id uuid primary key,
  created_at timestamptz not null,
  organization_id uuid,
  status text not null,
  error_code text,
  conflict_profile_id uuid,
  zernio_connection_id uuid,
  batch_id uuid,
  error_message text,
  synced_count integer,
  instagram_identity text
);
create trigger zernio_sync_projection_source_286_observability
after insert on zernio_sync_projection_source_286
for each row execute function public.project_zernio_sync_log_to_instagram_observability();

insert into zernio_sync_projection_source_286 (
  id, created_at, organization_id, status, error_code,
  error_message, synced_count, instagram_identity
) values (
  '28600000-0000-4000-8000-000000000002', now(),
  null, 'failed',
  'forced_projection_failure', 'Falha deliberada do teste.', 0, 'test'
);

do $$
begin
  if (select count(*) from zernio_sync_projection_source_286) <> 1 then
    raise exception 'Falha da observabilidade reverteu a origem autoritativa.';
  end if;
end;
$$;

select 'ok 2 - falha deliberada não reverte a origem autoritativa';

insert into zernio_sync_projection_source_286 (
  id, created_at, organization_id, status, error_code,
  error_message, synced_count, instagram_identity
)
select '28600000-0000-4000-8000-000000000003', now(), organization.id,
  'failed', 'smoke_286', 'Evento transacional da migration 286.', 0, 'test'
from public.organizations organization
order by organization.created_at
limit 1;

do $$
begin
  if not exists (
    select 1 from public.instagram_observability_events
    where source_type = 'zernio_sync_log_item'
      and source_id = '28600000-0000-4000-8000-000000000003'
      and severity = 'error'::public.instagram_observability_severity
      and treatment_state = 'action_required'::public.instagram_observability_treatment
  ) then
    raise exception 'Projeção normal não persistiu os enums esperados.';
  end if;
end;
$$;

select 'ok 3 - projeção normal persiste enums tipados';

rollback;
