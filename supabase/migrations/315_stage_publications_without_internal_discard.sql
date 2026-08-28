-- Reserva antecipadamente publicações na fila do worker sem entregá-las ao
-- provedor. Backlog causado pela capacidade do Athena nunca é descartado.

alter table public.publication_items
  add column if not exists dispatch_staged_by text,
  add column if not exists dispatch_staged_at timestamptz,
  add column if not exists dispatch_staged_until timestamptz;

create index if not exists publication_items_dispatch_staging_candidate_idx
  on public.publication_items (execute_at, organization_id, profile_id, id)
  include (created_at, batch_id, pipeline_version, preparation_status, status)
  where archived_at is null
    and creation_id is null
    and status in ('ready', 'waiting', 'preparing', 'failed');

create index if not exists publication_items_dispatch_staging_lease_idx
  on public.publication_items (dispatch_staged_until, dispatch_staged_by, execute_at, id)
  where dispatch_staged_by is not null;

create or replace function public.claim_publication_dispatch_staging_items(
  p_worker_id text,
  p_limit integer default 250,
  p_stage_lease_seconds integer default 1200,
  p_window_seconds integer default 600
)
returns table (
  id uuid, organization_id uuid, batch_id uuid, profile_id uuid,
  format public.publication_format, status public.publication_item_status,
  execute_at timestamptz, caption text, idempotency_key text,
  attempt_count integer, creation_id text, dispatch_staged_until timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode preparar o despacho.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120
    or p_limit not between 1 and 500
    or p_stage_lease_seconds not between 120 and 7200
    or p_window_seconds not between 60 and 3600 then
    raise exception using errcode = '22023', message = 'Parâmetros de staging inválidos.';
  end if;

  return query
  with source as (
    select item.id, item.organization_id, item.profile_id, item.execute_at, item.created_at
    from public.publication_items item
    where item.archived_at is null
      and item.creation_id is null
      and item.status in ('ready', 'waiting', 'preparing', 'failed')
      and (item.status <> 'failed' or (item.attempt_count < 5 and item.next_attempt_at is not null))
      and item.execute_at is not null
      and item.execute_at > timezone('utc', now())
      and item.execute_at <= timezone('utc', now()) + make_interval(secs => p_window_seconds)
      and (item.next_attempt_at is null or item.next_attempt_at <= timezone('utc', now()))
      and (item.lease_until is null or item.lease_until <= timezone('utc', now()))
      and (item.dispatch_staged_until is null or item.dispatch_staged_until <= timezone('utc', now()))
      and (item.pipeline_version = 1 or item.preparation_status = 'ready')
      and coalesce(item.zernio_recovery_count, 0) <= 0
      and not (
        item.pipeline_version = 1
        and item.idempotency_key like 'bulk:%'
        and exists (
          select 1 from public.publication_slot_risk_incidents risk
          where risk.organization_id = item.organization_id
            and risk.batch_id = item.batch_id
            and risk.slot_execute_at = item.execute_at
            and risk.state = 'at_risk'
        )
      )
      and not exists (
        select 1 from public.publication_batch_circuit_breakers breaker
        where breaker.batch_id = item.batch_id and breaker.paused_at is not null
      )
  ), fair as (
    select source.*,
      row_number() over (partition by source.organization_id order by source.execute_at, source.id) org_position,
      row_number() over (partition by source.profile_id order by source.execute_at, source.id) profile_position
    from source
  ), selected as (
    select fair.id from fair
    order by fair.profile_position, fair.org_position, fair.execute_at, fair.organization_id, fair.id
    limit p_limit
  ), locked as (
    select item.id from public.publication_items item
    join selected on selected.id = item.id
    for update of item skip locked
  ), staged as (
    update public.publication_items item
    set dispatch_staged_by = trim(p_worker_id),
        dispatch_staged_at = timezone('utc', now()),
        dispatch_staged_until = timezone('utc', now()) + make_interval(secs => p_stage_lease_seconds)
    from locked where item.id = locked.id
    returning item.*
  )
  select staged.id, staged.organization_id, staged.batch_id, staged.profile_id,
    staged.format, staged.status, staged.execute_at, staged.caption, staged.idempotency_key,
    staged.attempt_count, staged.creation_id, staged.dispatch_staged_until
  from staged;
end;
$$;

create or replace function public.activate_staged_publication_items(
  p_worker_id text,
  p_item_ids uuid[],
  p_lease_seconds integer default 300
)
returns table (
  id uuid, organization_id uuid, batch_id uuid, profile_id uuid,
  format public.publication_format, status public.publication_item_status,
  execute_at timestamptz, caption text, idempotency_key text,
  attempt_count integer, creation_id text, lease_until timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode ativar o despacho.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120
    or coalesce(array_length(p_item_ids, 1), 0) not between 1 and 500
    or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Parâmetros de ativação inválidos.';
  end if;

  return query
  with selected as (
    select item.id from public.publication_items item
    where item.id = any(p_item_ids)
      and item.archived_at is null
      and item.creation_id is null
      and item.dispatch_staged_by is not null
      and item.dispatch_staged_until > timezone('utc', now())
      and item.execute_at <= timezone('utc', now())
      and item.status in ('ready', 'waiting', 'preparing', 'failed')
      and (item.lease_until is null or item.lease_until <= timezone('utc', now()))
    for update skip locked
  ), activated as (
    update public.publication_items item
    set status = 'preparing', claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        next_attempt_at = null, attempt_count = item.attempt_count + 1,
        active_claim_consumed_attempt = true,
        dispatch_staged_by = null, dispatch_staged_at = null, dispatch_staged_until = null
    from selected where item.id = selected.id
    returning item.*
  ), already_active as (
    select item.* from public.publication_items item
    where item.id = any(p_item_ids)
      and item.claimed_by = trim(p_worker_id)
      and item.lease_until > timezone('utc', now())
      and item.status in ('preparing', 'publishing')
      and not exists (select 1 from activated where activated.id = item.id)
  ), rows as (
    select * from activated union all select * from already_active
  )
  select rows.id, rows.organization_id, rows.batch_id, rows.profile_id,
    rows.format, rows.status, rows.execute_at, rows.caption, rows.idempotency_key,
    rows.attempt_count, rows.creation_id, rows.lease_until
  from rows order by rows.execute_at, rows.organization_id, rows.profile_id, rows.id;
end;
$$;

create or replace function public.release_publication_dispatch_staging(
  p_worker_id text,
  p_item_ids uuid[]
) returns integer
language plpgsql security definer set search_path = public as $$
declare affected integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode liberar staging.';
  end if;
  update public.publication_items item
  set dispatch_staged_by = null, dispatch_staged_at = null, dispatch_staged_until = null
  where item.id = any(p_item_ids) and item.dispatch_staged_by = trim(p_worker_id);
  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Claim de contingência: mantém criações aceitas prioritárias e nunca elimina
-- um item apenas porque a capacidade interna demorou mais que o horário.
create or replace function public.claim_publication_items(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  id uuid, organization_id uuid, batch_id uuid, profile_id uuid,
  format public.publication_format, status public.publication_item_status,
  execute_at timestamptz, caption text, idempotency_key text,
  attempt_count integer, creation_id text, lease_until timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'Somente service_role pode reivindicar publicações.'; end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120
    or p_limit not between 1 and 100 or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Parâmetros de claim inválidos.';
  end if;

  return query
  with source as (
    select item.id, item.organization_id, item.profile_id, item.execute_at, item.created_at,
      case when item.creation_id is not null then 0 else 1 end priority_band
    from public.publication_items item
    where item.archived_at is null
      and item.status in ('ready', 'waiting', 'preparing', 'failed')
      and (item.status <> 'failed' or (item.attempt_count < 5 and item.next_attempt_at is not null))
      and (item.execute_at is null or item.execute_at <= timezone('utc', now()))
      and (item.next_attempt_at is null or item.next_attempt_at <= timezone('utc', now()))
      and (item.lease_until is null or item.lease_until <= timezone('utc', now()))
      and (item.dispatch_staged_until is null or item.dispatch_staged_until <= timezone('utc', now()))
      and (item.pipeline_version = 1 or item.creation_id is not null or item.preparation_status = 'ready')
      and not (coalesce(item.zernio_recovery_count, 0) > 0 and item.creation_id is null)
      and not exists (select 1 from public.publication_batch_circuit_breakers breaker where breaker.batch_id = item.batch_id and breaker.paused_at is not null)
      and not (
        item.pipeline_version = 1
        and item.creation_id is null
        and item.idempotency_key like 'bulk:%'
        and exists (
          select 1 from public.publication_slot_risk_incidents risk
          where risk.organization_id = item.organization_id
            and risk.batch_id = item.batch_id
            and risk.slot_execute_at = item.execute_at
            and risk.state = 'at_risk'
        )
      )
  ), fair as (
    select source.*,
      row_number() over (partition by source.organization_id order by source.priority_band, coalesce(source.execute_at, source.created_at), source.id) org_position,
      row_number() over (partition by source.profile_id order by source.priority_band, coalesce(source.execute_at, source.created_at), source.id) profile_position
    from source
  ), selected as (
    select fair.id from fair order by fair.priority_band, fair.profile_position, fair.org_position,
      coalesce(fair.execute_at, fair.created_at), fair.organization_id, fair.id limit p_limit
  ), locked as (
    select item.id from public.publication_items item join selected on selected.id = item.id
    for update of item skip locked
  ), claimed as (
    update public.publication_items item
    set status = 'preparing', claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        next_attempt_at = null,
        attempt_count = item.attempt_count + case when item.creation_id is null or item.status = 'failed' then 1 else 0 end,
        active_claim_consumed_attempt = item.creation_id is null or item.status = 'failed',
        dispatch_staged_by = null, dispatch_staged_at = null, dispatch_staged_until = null
    from locked where item.id = locked.id returning item.*
  ), updated_batches as (
    update public.publication_batches batch set status = 'processing'
    where batch.id in (select distinct claimed.batch_id from claimed) and batch.status in ('queued', 'validating')
  )
  select claimed.id, claimed.organization_id, claimed.batch_id, claimed.profile_id,
    claimed.format, claimed.status, claimed.execute_at, claimed.caption, claimed.idempotency_key,
    claimed.attempt_count, claimed.creation_id, claimed.lease_until from claimed;
end;
$$;

-- Um runtime antigo não pode continuar descartando itens enquanto o novo
-- worker é implantado. Limpezas manuais explícitas continuam disponíveis.
create or replace function public.ignore_overdue_unstarted_publications(
  p_before timestamptz,
  p_limit integer default 50,
  p_reason text default 'operator_overdue_backlog_cleanup'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  item_row public.publication_items%rowtype;
  affected integer := 0;
  affected_ids uuid[] := '{}'::uuid[];
  affected_batch_ids uuid[] := '{}'::uuid[];
  batch_id_value uuid;
  decided_at timestamptz := timezone('utc', now());
  reason_value text := left(coalesce(nullif(trim(p_reason), ''), 'operator_overdue_backlog_cleanup'), 120);
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode encerrar backlog vencido.';
  end if;
  if p_reason = 'automatic_expired_unstarted_publication' then
    return jsonb_build_object('ignored', 0, 'itemIds', '[]'::jsonb, 'batchIds', '[]'::jsonb,
      'cutoffAt', p_before, 'decidedAt', timezone('utc', now()), 'automaticDiscardDisabled', true);
  end if;
  if p_before is null or p_before > decided_at or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Corte ou limite inválido.';
  end if;

  for item_row in
    select item.*
    from public.publication_items item
    where item.archived_at is null
      and item.pipeline_version = 2
      and item.status in ('waiting', 'ready')
      and item.execute_at is not null
      and item.execute_at < p_before
      and item.creation_id is null
      and (item.lease_until is null or item.lease_until <= decided_at)
      and (item.dispatch_staged_until is null or item.dispatch_staged_until <= decided_at)
    order by item.execute_at, item.organization_id, item.profile_id, item.id
    for update skip locked
    limit p_limit
  loop
    update public.publication_items item
    set status = 'ignored', claimed_by = null, lease_until = null, next_attempt_at = null,
        dispatch_staged_by = null, dispatch_staged_at = null, dispatch_staged_until = null,
        last_error_code = reason_value,
        last_error_message = 'O operador encerrou explicitamente esta publicação vencida; ela não será enviada atrasada.'
    where item.id = item_row.id
      and item.status in ('waiting', 'ready')
      and item.creation_id is null;

    if found then
      delete from public.publication_profile_daily_reservations where publication_item_id = item_row.id;
      delete from public.publication_dispatch_rate_reservations where publication_item_id = item_row.id;
      perform public.log_publication_item_event(
        item_row.id, 'ignored', item_row.status, 'ignored', null,
        'operator: overdue-cleanup', reason_value,
        'O operador encerrou explicitamente esta publicação vencida; ela não será enviada atrasada.',
        jsonb_build_object('execute_at', item_row.execute_at, 'cutoff_at', p_before,
          'decided_at', decided_at, 'provider_creation_absent', true, 'explicit_operator_action', true)
      );
      affected := affected + 1;
      affected_ids := array_append(affected_ids, item_row.id);
      if not item_row.batch_id = any(affected_batch_ids) then
        affected_batch_ids := array_append(affected_batch_ids, item_row.batch_id);
      end if;
    end if;
  end loop;

  foreach batch_id_value in array affected_batch_ids loop
    perform public.sync_publication_batch_status(batch_id_value);
  end loop;

  return jsonb_build_object('ignored', affected, 'itemIds', affected_ids,
    'batchIds', affected_batch_ids, 'cutoffAt', p_before, 'decidedAt', decided_at,
    'automaticDiscardDisabled', false);
end;
$$;

revoke all on function public.claim_publication_dispatch_staging_items(text,integer,integer,integer) from public, anon, authenticated;
revoke all on function public.activate_staged_publication_items(text,uuid[],integer) from public, anon, authenticated;
revoke all on function public.release_publication_dispatch_staging(text,uuid[]) from public, anon, authenticated;
revoke all on function public.claim_publication_items(text,integer,integer) from public, anon, authenticated;
revoke all on function public.ignore_overdue_unstarted_publications(timestamptz,integer,text) from public, anon, authenticated;
grant execute on function public.claim_publication_dispatch_staging_items(text,integer,integer,integer) to service_role;
grant execute on function public.activate_staged_publication_items(text,uuid[],integer) to service_role;
grant execute on function public.release_publication_dispatch_staging(text,uuid[]) to service_role;
grant execute on function public.claim_publication_items(text,integer,integer) to service_role;
grant execute on function public.ignore_overdue_unstarted_publications(timestamptz,integer,text) to service_role;

notify pgrst, 'reload schema';
