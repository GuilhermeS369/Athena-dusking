-- Separa recuperação de execução já iniciada de recuperação indevida de horário.
-- Invariantes:
--   * falha terminal sem next_attempt_at nunca volta ao claim;
--   * creation_id existente continua elegível para polling/reconciliação;
--   * recuperação Zernio que exigiria uma segunda criação fica bloqueada;
--   * slot bulk vencido sem criação externa é ignorado, sem alterar execute_at;
--   * itens futuros não satisfazem o corte temporal e não são atualizados.

create or replace function public.claim_publication_items(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  id uuid,
  organization_id uuid,
  batch_id uuid,
  profile_id uuid,
  format public.publication_format,
  status public.publication_item_status,
  execute_at timestamptz,
  caption text,
  idempotency_key text,
  attempt_count integer,
  creation_id text,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Limite de claim deve estar entre 1 e 100';
  end if;
  if p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 900 segundos';
  end if;

  return query
  with eligible as (
    select
      item_row.id,
      item_row.organization_id,
      item_row.execute_at,
      item_row.created_at,
      row_number() over (
        partition by item_row.organization_id
        order by coalesce(item_row.execute_at, item_row.created_at), item_row.created_at, item_row.id
      ) as organization_position
    from public.publication_items item_row
    where item_row.status in ('ready', 'waiting', 'preparing', 'failed')
      and (
        item_row.status <> 'failed'
        or (
          item_row.attempt_count < 5
          and item_row.next_attempt_at is not null
        )
      )
      and (item_row.execute_at is null or item_row.execute_at <= timezone('utc', now()))
      and (item_row.next_attempt_at is null or item_row.next_attempt_at <= timezone('utc', now()))
      and (item_row.lease_until is null or item_row.lease_until <= timezone('utc', now()))
      -- Um recovery Zernio legado sem creation_id exigiria uma segunda criação.
      -- Ele permanece fora do claim para atenção terminal, sem chamada externa.
      and not (
        coalesce(item_row.zernio_recovery_count, 0) > 0
        and item_row.creation_id is null
      )
      and not exists (
        select 1
        from public.publication_batch_circuit_breakers breaker
        where breaker.batch_id = item_row.batch_id
          and breaker.paused_at is not null
      )
      and not (
        item_row.creation_id is null
        and item_row.idempotency_key like 'bulk:%'
        and exists (
          select 1
          from public.publication_slot_risk_incidents risk
          where risk.organization_id = item_row.organization_id
            and risk.batch_id = item_row.batch_id
            and risk.slot_execute_at = item_row.execute_at
            and risk.state = 'at_risk'
        )
      )
  ), selected as (
    select eligible.id
    from eligible
    order by eligible.organization_position,
      coalesce(eligible.execute_at, eligible.created_at),
      eligible.organization_id,
      eligible.id
    limit p_limit
  ), candidates as (
    select item_row.id
    from public.publication_items item_row
    join selected on selected.id = item_row.id
    for update of item_row skip locked
  ), claimed as (
    update public.publication_items item_row
    set status = 'preparing',
        claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        next_attempt_at = null,
        attempt_count = item_row.attempt_count + case
          when item_row.creation_id is null or item_row.status = 'failed' then 1
          else 0
        end
    from candidates
    where item_row.id = candidates.id
    returning item_row.id, item_row.organization_id, item_row.batch_id, item_row.profile_id,
      item_row.format, item_row.status, item_row.execute_at, item_row.caption,
      item_row.idempotency_key, item_row.attempt_count, item_row.creation_id, item_row.lease_until
  ), updated_batches as (
    update public.publication_batches batch_row
    set status = 'processing'
    where batch_row.id in (select distinct claimed.batch_id from claimed)
      and batch_row.status in ('queued', 'validating')
  )
  select * from claimed;
end;
$$;

create or replace function public.recover_missed_publication_slots(
  p_max_items integer default 100,
  p_grace_seconds integer default 120,
  p_worker_id text default null,
  p_cycle_correlation_id uuid default null
)
returns table (
  id uuid,
  organization_id uuid,
  profile_id uuid,
  previous_execute_at timestamptz,
  execute_at timestamptz,
  outcome text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  item_row public.publication_items%rowtype;
  candidate_window_start timestamptz;
  candidate_minute timestamptz;
  recovered_at timestamptz := timezone('utc', now());
begin
  if p_max_items not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Limite de recuperação deve estar entre 1 e 500';
  end if;
  if p_grace_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Margem de atraso deve estar entre 30 e 3600 segundos';
  end if;

  for item_row in
    select item_source.*
    from public.publication_items item_source
    where item_source.status in ('waiting', 'ready')
      and item_source.execute_at is not null
      and item_source.execute_at <= recovered_at - make_interval(secs => p_grace_seconds)
      and (item_source.next_attempt_at is null or item_source.next_attempt_at <= recovered_at)
      and (item_source.lease_until is null or item_source.lease_until <= recovered_at)
      and item_source.creation_id is null
    order by item_source.execute_at, item_source.created_at, item_source.id
    for update skip locked
    limit p_max_items
  loop
    id := item_row.id;
    organization_id := item_row.organization_id;
    profile_id := item_row.profile_id;
    previous_execute_at := item_row.execute_at;

    if item_row.idempotency_key like 'bulk:%' then
      update public.publication_items item_update
      set status = 'ignored',
          claimed_by = null,
          lease_until = null,
          next_attempt_at = null,
          last_error_code = 'missed_bulk_slot_expired',
          last_error_message = 'O horário coletivo venceu sem início no provedor; a postagem não será enviada atrasada.'
      where item_update.id = item_row.id
        and item_update.status in ('waiting', 'ready')
        and item_update.creation_id is null
        and item_update.execute_at <= recovered_at - make_interval(secs => p_grace_seconds);

      if found then
        perform public.log_publication_item_event(
          item_row.id,
          'ignored',
          item_row.status,
          'ignored',
          null,
          coalesce(left(nullif(trim(p_worker_id), ''), 120), 'system: missed-bulk-slot-expiry'),
          'missed_bulk_slot_expired',
          'O horário coletivo venceu sem início no provedor; a postagem não será enviada atrasada.',
          jsonb_build_object(
            'previous_execute_at', item_row.execute_at,
            'decided_at', recovered_at,
            'grace_seconds', p_grace_seconds,
            'cycle_correlation_id', p_cycle_correlation_id
          )
        );
        perform public.sync_publication_batch_status(item_row.batch_id);
      end if;

      update public.publication_slot_risk_incidents incident
      set state = 'ignored',
          decision_reason = 'expired_without_provider_creation',
          resolved_at = recovered_at,
          last_worker_id = left(nullif(trim(p_worker_id), ''), 120),
          last_cycle_correlation_id = p_cycle_correlation_id
      where incident.organization_id = item_row.organization_id
        and incident.batch_id = item_row.batch_id
        and incident.slot_execute_at = item_row.execute_at
        and incident.state = 'at_risk'
        and not exists (
          select 1
          from public.publication_items remaining
          where remaining.organization_id = incident.organization_id
            and remaining.batch_id = incident.batch_id
            and remaining.execute_at = incident.slot_execute_at
            and remaining.idempotency_key like 'bulk:%'
            and remaining.status in ('waiting', 'ready')
            and remaining.creation_id is null
        );

      execute_at := item_row.execute_at;
      outcome := 'ignored_bulk_slot_expired';
      return next;
      continue;
    end if;

    -- Publicações não coletivas preservam o comportamento anterior: um único
    -- reagendamento para a mesma faixa diária e atenção após a segunda perda.
    if item_row.missed_schedule_recovery_count >= 1 then
      update public.publication_items item_update
      set status = 'failed',
          claimed_by = null,
          lease_until = null,
          next_attempt_at = null,
          last_error_code = 'missed_schedule_requires_attention',
          last_error_message = 'A publicação voltou a perder o horário após um reagendamento automático e precisa de intervenção manual.'
      where item_update.id = item_row.id;

      perform public.log_publication_item_event(
        item_row.id, 'failed', item_row.status, 'failed', null,
        'system: missed-schedule-recovery', 'missed_schedule_requires_attention',
        'A publicação voltou a perder o horário após um reagendamento automático e precisa de intervenção manual.',
        jsonb_build_object('previous_execute_at', item_row.execute_at, 'recovery_count', item_row.missed_schedule_recovery_count)
      );
      perform public.sync_publication_batch_status(item_row.batch_id);

      execute_at := item_row.execute_at;
      outcome := 'requires_attention';
      return next;
      continue;
    end if;

    candidate_window_start := (
      ((item_row.execute_at at time zone 'America/Sao_Paulo')::date + 1)
      + date_trunc('hour', item_row.execute_at at time zone 'America/Sao_Paulo')::time
      + make_interval(mins => (extract(minute from item_row.execute_at at time zone 'America/Sao_Paulo')::integer / 10) * 10)
    ) at time zone 'America/Sao_Paulo';

    loop
      exit when candidate_window_start > recovered_at
        and not exists (
          select 1
          from public.publication_items occupied
          where occupied.organization_id = item_row.organization_id
            and occupied.profile_id = item_row.profile_id
            and occupied.execute_at >= candidate_window_start
            and occupied.execute_at < candidate_window_start + interval '10 minutes'
            and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
        );
      candidate_window_start := candidate_window_start + interval '1 day';
    end loop;

    perform pg_advisory_xact_lock(hashtextextended(item_row.profile_id::text, 0));
    loop
      candidate_minute := null;
      select candidate.minute_start into candidate_minute
      from (
        select candidate_window_start + make_interval(mins => minute_offset) as minute_start
        from generate_series(1, 9) minute_offset
      ) candidate
      where not exists (
        select 1
        from public.publication_items occupied
        where occupied.organization_id = item_row.organization_id
          and occupied.profile_id = item_row.profile_id
          and date_trunc('minute', occupied.execute_at) = candidate.minute_start
          and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
      )
      order by random()
      limit 1;

      exit when candidate_minute is not null;
      candidate_window_start := candidate_window_start + interval '1 day';
    end loop;

    update public.publication_items item_update
    set execute_at = candidate_minute + make_interval(secs => floor(random() * 60)::integer),
        status = 'waiting',
        claimed_by = null,
        lease_until = null,
        next_attempt_at = null,
        missed_schedule_recovery_count = 1,
        last_error_code = 'missed_schedule_recovered',
        last_error_message = 'O worker não iniciou a publicação no horário previsto; ela foi reagendada automaticamente uma única vez.'
    where item_update.id = item_row.id
    returning item_update.execute_at into execute_at;

    perform public.log_publication_item_event(
      item_row.id, 'processing_deferred', item_row.status, 'waiting', null,
      'system: missed-schedule-recovery', 'missed_schedule_recovered',
      'O worker não iniciou a publicação no horário previsto; ela foi reagendada automaticamente uma única vez.',
      jsonb_build_object('previous_execute_at', item_row.execute_at, 'rescheduled_execute_at', execute_at, 'recovery_count', 1)
    );
    perform public.sync_publication_batch_status(item_row.batch_id);

    outcome := 'rescheduled_once';
    return next;
  end loop;
end;
$$;

-- Compatibilidade segura com workers antigos durante o rollout: uma chamada
-- ao RPC legado não limpa creation_id nem agenda uma segunda criação.
create or replace function public.schedule_zernio_media_download_recovery(
  p_item_id uuid,
  p_worker_id text,
  p_creation_id text,
  p_error_code text,
  p_error_message text,
  p_url_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return jsonb_build_object(
    'scheduled', false,
    'reason', 'automatic_recreation_disabled',
    'itemId', p_item_id
  );
end;
$$;

-- Compatibilidade segura com workers que ainda possuem recoveryLimit > 0:
-- nenhum slot vencido é entregue para publicação coordenada.
create or replace function public.claim_publication_slot_recovery_items(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  id uuid,
  organization_id uuid,
  batch_id uuid,
  profile_id uuid,
  format public.publication_format,
  status public.publication_item_status,
  execute_at timestamptz,
  caption text,
  idempotency_key text,
  attempt_count integer,
  creation_id text,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Limite de recuperação deve estar entre 1 e 100';
  end if;
  if p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 900 segundos';
  end if;
  return;
end;
$$;

-- Quarentena única de itens legados que já estavam entre a primeira criação
-- e a criação substituta. Não altera execute_at e não chama provedor.
do $$
declare
  unsafe_item record;
begin
  for unsafe_item in
    with candidates as (
      select item.id, item.batch_id, item.status as previous_status
      from public.publication_items item
      where coalesce(item.zernio_recovery_count, 0) > 0
        and item.creation_id is null
        and item.status in ('waiting', 'ready', 'preparing', 'failed')
        and item.last_error_code is distinct from 'zernio_automatic_recreation_disabled'
      for update
    ), quarantined as (
      update public.publication_items item
      set status = 'failed',
          claimed_by = null,
          lease_until = null,
          next_attempt_at = null,
          last_error_code = 'zernio_automatic_recreation_disabled',
          last_error_message = 'A criação original exige reconciliação manual; uma segunda postagem automática foi bloqueada.'
      from candidates
      where item.id = candidates.id
      returning item.id, item.batch_id, candidates.previous_status
    )
    select quarantined.id, quarantined.batch_id, quarantined.previous_status
    from quarantined
  loop
    perform public.log_publication_item_event(
      unsafe_item.id,
      'failed',
      unsafe_item.previous_status,
      'failed',
      null,
      'system: safe-zernio-recreation-quarantine',
      'zernio_automatic_recreation_disabled',
      'A criação original exige reconciliação manual; uma segunda postagem automática foi bloqueada.',
      jsonb_build_object('migration', '195_safe_publication_retry_and_expired_bulk_slots')
    );
    perform public.sync_publication_batch_status(unsafe_item.batch_id);
  end loop;
end;
$$;

revoke all on function public.claim_publication_items(text, integer, integer) from public, anon, authenticated;
revoke all on function public.recover_missed_publication_slots(integer, integer, text, uuid) from public, anon, authenticated;
revoke all on function public.schedule_zernio_media_download_recovery(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.claim_publication_slot_recovery_items(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_publication_items(text, integer, integer) to service_role;
grant execute on function public.recover_missed_publication_slots(integer, integer, text, uuid) to service_role;
grant execute on function public.schedule_zernio_media_download_recovery(uuid, text, text, text, text, text) to service_role;
grant execute on function public.claim_publication_slot_recovery_items(text, integer, integer) to service_role;

notify pgrst, 'reload schema';
