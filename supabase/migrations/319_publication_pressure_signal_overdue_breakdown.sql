-- Fase 2 de plans/plano-correcao-deadlock-staging-criticaldelay-2026-08-28.md:
-- o sinal de pressão passa a expor a causa do atraso (itens já aceitos pelo
-- provedor, competindo por capacidade de despacho, vs. itens não iniciados,
-- que só o próprio staging resolve), para que cada consumidor decida se deve
-- mesmo ceder ou se cederia indefinidamente ao atraso que só ele resolve.

create or replace function public.get_publication_generation_pressure_signal(
  p_critical_delay_seconds integer default 60
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  oldest_due_at timestamptz;
  checked_at timestamptz := timezone('utc', now());
  has_overdue_accepted boolean := false;
  has_overdue_unstarted boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode consultar pressão global.';
  end if;
  if p_critical_delay_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Limite de atraso crítico inválido.';
  end if;

  select item.execute_at into oldest_due_at
  from public.publication_items item
  where item.archived_at is null
    and item.pipeline_version = 2
    and item.status in ('waiting', 'ready')
    and item.execute_at is not null
    and item.execute_at <= checked_at - make_interval(secs => p_critical_delay_seconds)
  order by item.execute_at, item.id
  limit 1;

  if oldest_due_at is not null then
    select
      exists (
        select 1 from public.publication_items item
        where item.archived_at is null
          and item.pipeline_version = 2
          and item.status in ('waiting', 'ready')
          and item.execute_at is not null
          and item.execute_at <= checked_at - make_interval(secs => p_critical_delay_seconds)
          and item.creation_id is not null
      ),
      exists (
        select 1 from public.publication_items item
        where item.archived_at is null
          and item.pipeline_version = 2
          and item.status in ('waiting', 'ready')
          and item.execute_at is not null
          and item.execute_at <= checked_at - make_interval(secs => p_critical_delay_seconds)
          and item.creation_id is null
      )
    into has_overdue_accepted, has_overdue_unstarted;
  end if;

  return jsonb_build_object(
    'criticalDelay', oldest_due_at is not null,
    'oldestDueAt', oldest_due_at,
    'overdueCurrent', case when oldest_due_at is null then 0 else 1 end,
    'overdueAccepted', has_overdue_accepted,
    'overdueUnstarted', has_overdue_unstarted,
    'checkedAt', checked_at
  );
end;
$$;

revoke all on function public.get_publication_generation_pressure_signal(integer)
  from public, anon, authenticated;
grant execute on function public.get_publication_generation_pressure_signal(integer)
  to service_role;

notify pgrst, 'reload schema';
