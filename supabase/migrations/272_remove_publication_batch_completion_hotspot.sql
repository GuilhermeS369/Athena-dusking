-- Remove as duas linhas quentes por lote do caminho de conclusao individual.
-- Resultados terminais continuam duraveis, mas lote e circuit breaker sao
-- consolidados uma unica vez por ciclo do worker.

alter table public.publication_batch_terminal_outcomes
  add column if not exists reconciled_at timestamptz;

-- Resultados anteriores a esta migration ja foram aplicados pelo trigger antigo.
update public.publication_batch_terminal_outcomes
set reconciled_at = timezone('utc', now())
where reconciled_at is null;

create index if not exists publication_batch_terminal_outcomes_pending_idx
  on public.publication_batch_terminal_outcomes (created_at, batch_id)
  where reconciled_at is null;

create or replace function public.is_publication_infrastructure_error(
  p_error_code text,
  p_error_message text default null
)
returns boolean
language sql
immutable
parallel safe
as $$
  select lower(trim(coalesce(p_error_code, ''))) in (
    '57014', '40001', '40p01', '53300', '57p01', '57p02', '57p03',
    'publication_worker_cycle_failed', 'dispatcher_unexpected_error'
  ) or lower(coalesce(p_error_message, '')) similar to
    '%(statement timeout|canceling statement|deadlock detected|connection pool|database connection|supabase unavailable)%';
$$;

create or replace function public.apply_publication_batch_failure_circuit_breaker()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
begin
  if new.event_type not in ('published', 'failed') then return new; end if;

  select item.* into item_row
  from public.publication_items item
  where item.id = new.publication_item_id;
  if item_row.id is null then return new; end if;

  if new.event_type = 'failed' and (
    item_row.next_attempt_at is not null
    or public.is_publication_infrastructure_error(new.error_code, new.error_message)
  ) then
    return new;
  end if;

  -- Uma linha independente por item: nenhuma trava compartilhada por lote.
  insert into public.publication_batch_terminal_outcomes (
    publication_item_id, batch_id, organization_id, outcome, event_id, reconciled_at
  ) values (
    item_row.id, item_row.batch_id, item_row.organization_id,
    case when new.event_type = 'published' then 'published' else 'failed' end,
    new.id, null
  ) on conflict (publication_item_id) do nothing;

  return new;
end;
$$;

create or replace function public.reconcile_publication_batch_runtime(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target record;
  failure_count integer;
  was_paused boolean;
  reconciled_batches integer := 0;
  newly_paused_batches integer := 0;
  reconciled_outcomes integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Acao permitida somente ao worker.';
  end if;
  if p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Limite de reconciliacao invalido.';
  end if;

  for target in
    select outcome.batch_id, min(outcome.created_at) as first_pending_at
    from public.publication_batch_terminal_outcomes outcome
    where outcome.reconciled_at is null
    group by outcome.batch_id
    order by min(outcome.created_at), outcome.batch_id
    limit p_limit
  loop
    -- Evita que dois workers consolidem o mesmo lote. A trava ocorre uma vez
    -- por lote/ciclo, nunca uma vez por publicacao.
    if not pg_try_advisory_xact_lock(hashtextextended(target.batch_id::text, 272)) then
      continue;
    end if;

    insert into public.publication_batch_circuit_breakers (batch_id, organization_id)
    select batch.id, batch.organization_id
    from public.publication_batches batch
    where batch.id = target.batch_id
    on conflict (batch_id) do nothing;

    select breaker.paused_at is not null into was_paused
    from public.publication_batch_circuit_breakers breaker
    where breaker.batch_id = target.batch_id
    for update;

    with latest_success as (
      select success.created_at, success.event_id
      from public.publication_batch_terminal_outcomes success
      where success.batch_id = target.batch_id and success.outcome = 'published'
      order by success.created_at desc, success.event_id desc
      limit 1
    )
    select count(*)::integer into failure_count
    from public.publication_batch_terminal_outcomes outcome
    left join latest_success on true
    where outcome.batch_id = target.batch_id
      and outcome.outcome = 'failed'
      and (
        latest_success.created_at is null
        or (outcome.created_at, outcome.event_id) > (latest_success.created_at, latest_success.event_id)
      );

    update public.publication_batch_circuit_breakers breaker
    set consecutive_failures = failure_count,
        last_failure_item_id = case when failure_count > 0 then (
          select failed.publication_item_id
          from public.publication_batch_terminal_outcomes failed
          where failed.batch_id = target.batch_id and failed.outcome = 'failed'
          order by failed.created_at desc, failed.publication_item_id desc
          limit 1
        ) else null end,
        paused_at = case
          when breaker.paused_at is not null then breaker.paused_at
          when failure_count >= 5 then timezone('utc', now())
          else null
        end,
        paused_reason = case
          when breaker.paused_at is not null then breaker.paused_reason
          when failure_count >= 5 then 'O lote foi pausado apos 5 publicacoes distintas com falha terminal consecutiva. Corrija a causa e use Continuar lote.'
          else null
        end,
        updated_at = timezone('utc', now())
    where breaker.batch_id = target.batch_id;

    if not coalesce(was_paused, false) and failure_count >= 5 then
      newly_paused_batches := newly_paused_batches + 1;
    end if;

    perform public.sync_publication_batch_status(target.batch_id);

    with marked as (
      update public.publication_batch_terminal_outcomes outcome
      set reconciled_at = timezone('utc', now())
      where outcome.batch_id = target.batch_id
        and outcome.reconciled_at is null
      returning 1
    ) select count(*) into failure_count from marked;

    reconciled_outcomes := reconciled_outcomes + failure_count;
    reconciled_batches := reconciled_batches + 1;
  end loop;

  return jsonb_build_object(
    'reconciledBatches', reconciled_batches,
    'newlyPausedBatches', newly_paused_batches,
    'reconciledOutcomes', reconciled_outcomes
  );
end;
$$;

revoke all on function public.is_publication_infrastructure_error(text, text) from public, anon, authenticated;
grant execute on function public.is_publication_infrastructure_error(text, text) to service_role;
revoke all on function public.reconcile_publication_batch_runtime(integer) from public, anon, authenticated;
grant execute on function public.reconcile_publication_batch_runtime(integer) to service_role;

create or replace function public.defer_publication_infrastructure_failure(
  p_item_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_delay_seconds integer default 30
)
returns table (id uuid, status public.publication_item_status, creation_id text, next_attempt_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  updated_row public.publication_items%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Acao permitida somente ao worker.';
  end if;
  if p_delay_seconds not between 15 and 900 then
    raise exception using errcode = '22023', message = 'Intervalo de retry de infraestrutura invalido.';
  end if;
  if not public.is_publication_infrastructure_error(p_error_code, p_error_message) then
    raise exception using errcode = '22023', message = 'Erro informado nao e de infraestrutura.';
  end if;

  select item.* into item_row
  from public.publication_items item
  where item.id = p_item_id
    and item.claimed_by = trim(p_worker_id)
    and item.lease_until > timezone('utc', now())
    and item.status in ('preparing', 'publishing')
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Item nao esta sob lease deste worker';
  end if;

  update public.publication_items item
  set status = 'waiting',
      claimed_by = null,
      lease_until = null,
      next_attempt_at = timezone('utc', now()) + make_interval(secs => p_delay_seconds),
      attempt_count = greatest(0, item.attempt_count - case when item.creation_id is null then 1 else 0 end),
      last_error_code = left(coalesce(nullif(trim(p_error_code), ''), 'infrastructure_retry'), 120),
      last_error_message = left(nullif(trim(p_error_message), ''), 1200)
  where item.id = item_row.id
  returning item.* into updated_row;

  perform public.log_publication_item_event(
    updated_row.id, 'processing_deferred', item_row.status, updated_row.status,
    null, trim(p_worker_id), updated_row.last_error_code, updated_row.last_error_message,
    jsonb_build_object(
      'reason', 'infrastructure_retry',
      'creation_id_preserved', updated_row.creation_id is not null,
      'next_attempt_at', updated_row.next_attempt_at
    )
  );

  return query select updated_row.id, updated_row.status, updated_row.creation_id, updated_row.next_attempt_at;
end;
$$;

revoke all on function public.defer_publication_infrastructure_failure(uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.defer_publication_infrastructure_failure(uuid, text, text, text, integer) to service_role;

-- Mantem a conclusao por item O(1). O status do lote e o circuit breaker sao
-- atualizados por reconcile_publication_batch_runtime().
create or replace function public.complete_publication_item(
  p_item_id uuid,
  p_worker_id text,
  p_outcome text,
  p_meta_media_id text default null,
  p_error_code text default null,
  p_error_message text default null,
  p_retryable boolean default false,
  p_max_attempts integer default 5
)
returns table (id uuid, status public.publication_item_status, attempt_count integer, next_attempt_at timestamptz, published_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  updated_row public.publication_items%rowtype;
  retry_delay_seconds integer;
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then raise exception using errcode = '22023', message = 'Identificador de worker invalido'; end if;
  if p_outcome not in ('published', 'failed', 'removed') then raise exception using errcode = '22023', message = 'Resultado de publicacao invalido'; end if;
  if p_max_attempts not between 1 and 20 then raise exception using errcode = '22023', message = 'Maximo de tentativas deve estar entre 1 e 20'; end if;

  select item_source.* into item_row from public.publication_items as item_source
  where item_source.id = p_item_id and item_source.claimed_by = trim(p_worker_id)
    and item_source.lease_until > timezone('utc', now()) and item_source.status in ('preparing', 'publishing')
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Item nao esta sob lease deste worker'; end if;

  if p_outcome = 'published' then
    update public.publication_items as item_update
    set status = 'published', meta_media_id = coalesce(nullif(trim(p_meta_media_id), ''), item_update.meta_media_id),
        published_at = timezone('utc', now()), claimed_by = null, lease_until = null, next_attempt_at = null,
        last_error_code = null, last_error_message = null
    where item_update.id = item_row.id returning item_update.* into updated_row;
    update public.media_assets as asset
    set first_published_at = coalesce(asset.first_published_at, timezone('utc', now()))
    from public.publication_item_media as item_media
    where item_media.publication_item_id = item_row.id and item_media.media_asset_id = asset.id
      and asset.organization_id = item_row.organization_id;
  elsif p_outcome = 'removed' then
    update public.publication_items as item_update
    set status = 'removed', cancelled_at = timezone('utc', now()), claimed_by = null, lease_until = null,
        next_attempt_at = null, creation_id = null,
        last_error_code = left(coalesce(nullif(trim(p_error_code), ''), 'media_deleted'), 120),
        last_error_message = left(coalesce(nullif(trim(p_error_message), ''), 'Midia apagada.'), 1200)
    where item_update.id = item_row.id returning item_update.* into updated_row;
  elsif p_retryable and item_row.attempt_count < p_max_attempts then
    retry_delay_seconds := (60 * power(2, least(item_row.attempt_count - 1, 6)))::integer + floor(random() * 31)::integer;
    update public.publication_items as item_update
    set status = 'failed', claimed_by = null, lease_until = null,
        next_attempt_at = timezone('utc', now()) + make_interval(secs => retry_delay_seconds),
        last_error_code = left(nullif(trim(p_error_code), ''), 120), last_error_message = left(nullif(trim(p_error_message), ''), 1200)
    where item_update.id = item_row.id returning item_update.* into updated_row;
  else
    update public.publication_items as item_update
    set status = 'failed', claimed_by = null, lease_until = null, next_attempt_at = null,
        last_error_code = left(nullif(trim(p_error_code), ''), 120), last_error_message = left(nullif(trim(p_error_message), ''), 1200)
    where item_update.id = item_row.id returning item_update.* into updated_row;
  end if;

  delete from public.publication_profile_daily_reservations as reservation where reservation.publication_item_id = item_row.id;
  update public.publication_zernio_recoveries recovery
  set completed_at = timezone('utc', now())
  where recovery.publication_item_id = updated_row.id and recovery.completed_at is null
    and updated_row.next_attempt_at is null and updated_row.status in ('published', 'failed', 'removed');

  perform public.log_publication_item_event(
    updated_row.id,
    case when updated_row.status = 'published' then 'published'::public.publication_item_event_type
      when updated_row.status = 'removed' then 'cancelled'::public.publication_item_event_type else 'failed'::public.publication_item_event_type end,
    item_row.status, updated_row.status, null, trim(p_worker_id),
    case when updated_row.status in ('failed', 'removed') then updated_row.last_error_code else null end,
    case when updated_row.status in ('failed', 'removed') then updated_row.last_error_message else null end,
    jsonb_build_object('attempt_count', updated_row.attempt_count, 'next_attempt_at', updated_row.next_attempt_at)
  );

  return query select result_item.id, result_item.status, result_item.attempt_count, result_item.next_attempt_at, result_item.published_at
  from public.publication_items as result_item where result_item.id = updated_row.id;
end;
$$;

revoke all on function public.complete_publication_item(uuid, text, text, text, text, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.complete_publication_item(uuid, text, text, text, text, text, boolean, integer) to service_role;

create or replace function public.get_paused_publication_batch_alerts(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with authorized as (
    select p_organization_id as organization_id
    where auth.role() = 'service_role' or public.is_organization_member(p_organization_id)
  ), paused as (
    select breaker.batch_id, batch.name, breaker.consecutive_failures,
      breaker.paused_at, breaker.paused_reason, breaker.last_failure_item_id,
      count(item.id) filter (where item.archived_at is null and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed'))::integer as blocked_items,
      count(distinct item.profile_id) filter (where item.archived_at is null and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed'))::integer as blocked_profiles,
      min(item.execute_at) filter (where item.archived_at is null and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')) as next_execute_at
    from public.publication_batch_circuit_breakers breaker
    join public.publication_batches batch on batch.id = breaker.batch_id
    join authorized auth_org on auth_org.organization_id = breaker.organization_id
    left join public.publication_items item on item.batch_id = breaker.batch_id
    where breaker.paused_at is not null
    group by breaker.batch_id, batch.name, breaker.consecutive_failures,
      breaker.paused_at, breaker.paused_reason, breaker.last_failure_item_id
  )
  select jsonb_build_object(
    'snapshotAt', timezone('utc', now()),
    'total', count(*) filter (where paused.blocked_items > 0),
    'blockedItems', coalesce(sum(paused.blocked_items) filter (where paused.blocked_items > 0), 0),
    'batches', coalesce(jsonb_agg(jsonb_build_object(
      'batchId', paused.batch_id,
      'name', paused.name,
      'consecutiveFailures', paused.consecutive_failures,
      'pausedAt', paused.paused_at,
      'reason', paused.paused_reason,
      'lastFailureItemId', paused.last_failure_item_id,
      'blockedItems', paused.blocked_items,
      'blockedProfiles', paused.blocked_profiles,
      'nextExecuteAt', paused.next_execute_at
    ) order by paused.paused_at desc) filter (where paused.blocked_items > 0), '[]'::jsonb)
  ) from paused;
$$;

revoke all on function public.get_paused_publication_batch_alerts(uuid) from public, anon;
grant execute on function public.get_paused_publication_batch_alerts(uuid) to authenticated, service_role;
