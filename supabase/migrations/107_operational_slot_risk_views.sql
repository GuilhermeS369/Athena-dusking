-- Leituras segregadas para a observabilidade de slots. Operadores veem apenas
-- o impacto de sua organização; telemetria identificável do worker permanece
-- exclusiva do superusuário do sistema.

create or replace function public.get_publication_slot_risk_incidents(
  p_organization_id uuid,
  p_limit integer default 20
)
returns table (
  id uuid,
  batch_id uuid,
  batch_name text,
  state text,
  slot_execute_at timestamptz,
  affected_item_count integer,
  overdue_seconds integer,
  next_slot_execute_at timestamptz,
  decision_reason text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    incident.id,
    incident.batch_id,
    coalesce(batch.name, 'Lote sem nome') as batch_name,
    incident.state,
    incident.slot_execute_at,
    incident.affected_item_count,
    incident.overdue_seconds,
    incident.next_slot_execute_at,
    incident.decision_reason,
    incident.created_at,
    incident.updated_at
  from public.publication_slot_risk_incidents incident
  join public.publication_batches batch on batch.id = incident.batch_id
  where incident.organization_id = p_organization_id
    and (auth.role() = 'service_role' or public.is_organization_member(p_organization_id))
  order by case incident.state when 'at_risk' then 1 when 'recovered' then 2 else 3 end,
    incident.slot_execute_at desc, incident.id desc
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

create or replace function public.get_publication_worker_cycle_observability(
  p_limit integer default 30
)
returns table (
  worker_id text,
  phase text,
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer,
  error_code text,
  error_message text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    event.worker_id,
    event.phase,
    event.started_at,
    event.completed_at,
    event.duration_ms,
    event.error_code,
    event.error_message,
    event.created_at
  from public.publication_worker_cycle_events event
  where public.is_system_super_user()
  order by event.created_at desc, event.id desc
  limit greatest(1, least(coalesce(p_limit, 30), 100));
$$;

revoke all on function public.get_publication_slot_risk_incidents(uuid, integer) from public, anon;
revoke all on function public.get_publication_worker_cycle_observability(integer) from public, anon, authenticated;
grant execute on function public.get_publication_slot_risk_incidents(uuid, integer) to authenticated, service_role;
grant execute on function public.get_publication_worker_cycle_observability(integer) to authenticated, service_role;
