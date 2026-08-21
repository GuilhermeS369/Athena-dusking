-- Perfis removidos durante uma recuperação coordenada terminam o item como
-- ignored/removed. Esses resultados são finais e não podem manter o incidente
-- em at_risk indefinidamente; somente estados ainda operacionais bloqueiam a
-- conclusão do slot.
create or replace function public.finalize_publication_slot_recovery_incidents(
  p_worker_id text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_count integer;
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;

  with resolved as (
    update public.publication_slot_risk_incidents incident
    set state = 'recovered',
        decision_reason = 'coordinated_recovery_completed',
        last_worker_id = trim(p_worker_id),
        resolved_at = timezone('utc', now())
    where incident.state = 'at_risk'
      and incident.decision_reason = 'coordinated_recovery_in_progress'
      and not exists (
        select 1
        from public.publication_items item_row
        where item_row.organization_id = incident.organization_id
          and item_row.batch_id = incident.batch_id
          and item_row.execute_at = incident.slot_execute_at
          and item_row.idempotency_key like 'bulk:%'
          and item_row.status not in ('published', 'ignored', 'removed', 'cancelled')
      )
    returning incident.id
  )
  select count(*)::integer into resolved_count from resolved;

  return resolved_count;
end;
$$;

revoke all on function public.finalize_publication_slot_recovery_incidents(text)
from public, anon, authenticated;
grant execute on function public.finalize_publication_slot_recovery_incidents(text)
to service_role;

notify pgrst, 'reload schema';
