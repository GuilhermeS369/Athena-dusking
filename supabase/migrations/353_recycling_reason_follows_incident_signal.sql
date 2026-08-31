-- complete_zernio_profile_recycling passa a descrever o motivo real da remocao.
--
-- A funcao fecha o ciclo de qualquer remocao Zernio, e gravava um motivo fixo:
-- "Conta desconectada na Zernio e removida automaticamente". Isso era verdade
-- quando o unico caminho ate aqui era a queda detectada por worker. Desde a
-- migration 342 existe o caminho do operador, e o perfil que a pessoa mandou
-- excluir ficava marcado como se a Zernio o tivesse derrubado.
--
-- O rastro auditavel nunca esteve errado: o incidente ao lado sempre guardou
-- signal e source corretos. Errado estava o campo desnormalizado no perfil, que
-- e justamente o que alguem le primeiro ao investigar "por que este perfil
-- sumiu" meses depois.
--
-- O motivo agora sai do proprio sinal do incidente. O corpo restante e o mesmo
-- da migration 127, verificado byte a byte contra a funcao em producao antes de
-- ser reescrito aqui.
--
-- Os textos dos itens de publicacao tambem passam a acompanhar o sinal. Na
-- pratica eles raramente se aplicam no caminho do operador: a contencao da 342
-- ja moveu os itens para 'ignored' no momento do enfileiramento, e o bloco
-- abaixo so alcanca itens em waiting/ready/preparing/publishing/failed/suspended.
-- Ficam corretos de qualquer forma, para o dia em que um item escapar da
-- contencao e cair aqui.

create or replace function public.complete_zernio_profile_recycling(
  p_job_id uuid, p_worker_id text, p_remote_outcome text,
  p_http_status integer default null, p_request_id text default null,
  p_error_code text default null, p_error_message text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  job_row public.zernio_profile_recycling_jobs%rowtype;
  incident_row public.zernio_profile_disconnection_incidents%rowtype;
  removal_code text;
  removal_message text;
  profile_row public.instagram_profiles%rowtype;
  ignored_count integer := 0;
  plan_count integer := 0;
  retry_seconds integer;
  affected_batch uuid;
  dead_letter_reason text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  if p_remote_outcome not in ('remote_deleted', 'already_disconnected_404', 'retryable_error', 'terminal_error') then
    raise exception using errcode = '22023', message = 'Resultado remoto inválido.';
  end if;

  select job.* into job_row
  from public.zernio_profile_recycling_jobs job
  where job.id = p_job_id
    and job.claimed_by = trim(p_worker_id)
    and job.lease_until > timezone('utc', now())
    and job.status = 'processing'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Job não está sob lease deste worker.';
  end if;

  select incident.* into incident_row
  from public.zernio_profile_disconnection_incidents incident
  where incident.id = job_row.incident_id
    and incident.organization_id = job_row.organization_id
  for update;

  -- O motivo vem do sinal, nao de uma constante: o mesmo fechamento serve para
  -- queda detectada por worker, duplicidade e exclusao pedida pelo operador.
  if incident_row.signal = 'operator_requested' then
    removal_code := 'profile_removed_by_operator';
    removal_message := 'Perfil excluido pelo operador no painel; conta removida da Zernio.';
  elsif incident_row.signal = 'duplicate_identity_auto_removed' then
    removal_code := 'zernio_duplicate_identity_removed';
    removal_message := 'Copia duplicada removida da Zernio automaticamente.';
  else
    removal_code := 'zernio_account_disconnected';
    removal_message := 'Conta desconectada na Zernio e removida automaticamente.';
  end if;

  if p_remote_outcome in ('retryable_error', 'terminal_error') then
    if p_remote_outcome = 'terminal_error' or job_row.attempt_count >= job_row.max_attempts then
      dead_letter_reason := case
        when p_remote_outcome = 'terminal_error' then 'terminal_error'
        else 'max_attempts_exhausted'
      end;

      update public.zernio_profile_recycling_jobs set
        status = 'dead_letter', claimed_by = null, lease_until = null,
        last_http_status = p_http_status,
        last_request_id = left(nullif(trim(p_request_id), ''), 160),
        last_error_code = left(coalesce(nullif(trim(p_error_code), ''), dead_letter_reason), 120),
        last_error_message = left(coalesce(nullif(trim(p_error_message), ''), 'Falha terminal ao remover conta Zernio.'), 1200),
        last_outcome = p_remote_outcome,
        dead_letter_at = timezone('utc', now()),
        deferred_reason = dead_letter_reason
      where id = job_row.id;

      update public.zernio_profile_disconnection_incidents set
        state = 'dead_letter', remote_http_status = p_http_status,
        remote_request_id = left(nullif(trim(p_request_id), ''), 160),
        remote_result = p_remote_outcome,
        defer_reason = dead_letter_reason,
        finalized_at = timezone('utc', now())
      where id = incident_row.id;

      insert into public.zernio_profile_recycling_job_events (
        organization_id, job_id, incident_id, event_type,
        previous_status, status, attempt_count, reason, metadata
      ) values (
        job_row.organization_id, job_row.id, incident_row.id,
        'dead_lettered', 'processing', 'dead_letter', job_row.attempt_count,
        left(coalesce(nullif(trim(p_error_message), ''), dead_letter_reason), 1200),
        jsonb_build_object('httpStatus', p_http_status, 'errorCode', p_error_code, 'classification', dead_letter_reason)
      );

      return jsonb_build_object(
        'completed', false, 'deadLettered', true,
        'reason', dead_letter_reason, 'attemptCount', job_row.attempt_count
      );
    end if;

    retry_seconds := least(
      3600,
      60 * power(2, least(job_row.attempt_count - 1, 6))::integer
        + floor(random() * 31)::integer
    );

    update public.zernio_profile_recycling_jobs set
      status = 'retry_pending', claimed_by = null, lease_until = null,
      next_attempt_at = timezone('utc', now()) + make_interval(secs => retry_seconds),
      last_http_status = p_http_status,
      last_request_id = left(nullif(trim(p_request_id), ''), 160),
      last_error_code = left(nullif(trim(p_error_code), ''), 120),
      last_error_message = left(nullif(trim(p_error_message), ''), 1200),
      last_outcome = p_remote_outcome,
      deferred_reason = 'retryable_error'
    where id = job_row.id;

    update public.zernio_profile_disconnection_incidents set
      state = 'retry_scheduled', remote_http_status = p_http_status,
      remote_request_id = left(nullif(trim(p_request_id), ''), 160),
      remote_result = p_remote_outcome,
      defer_reason = 'retryable_error'
    where id = incident_row.id;

    insert into public.zernio_profile_recycling_job_events (
      organization_id, job_id, incident_id, event_type,
      previous_status, status, attempt_count, reason, metadata
    ) values (
      job_row.organization_id, job_row.id, incident_row.id,
      'retry_scheduled', 'processing', 'retry_pending', job_row.attempt_count,
      left(nullif(trim(p_error_message), ''), 1200),
      jsonb_build_object('retryAtSeconds', retry_seconds, 'httpStatus', p_http_status, 'errorCode', p_error_code)
    );

    return jsonb_build_object(
      'completed', false, 'deadLettered', false,
      'retryAtSeconds', retry_seconds, 'attemptCount', job_row.attempt_count
    );
  end if;

  select profile.* into profile_row
  from public.instagram_profiles profile
  where profile.id = incident_row.profile_id
    and profile.organization_id = incident_row.organization_id
  for update;

  if found and profile_row.deleted_at is null then
    with targets as (
      select item.id, item.status as previous_status
      from public.publication_items item
      where item.organization_id = incident_row.organization_id
        and item.profile_id = incident_row.profile_id
        and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')
      for update
    ), ignored as (
      update public.publication_items item set
        status = 'ignored', claimed_by = null, lease_until = null,
        next_attempt_at = null, attempt_count = 0,
        last_error_code = removal_code,
        last_error_message = removal_message
      from targets where item.id = targets.id
      returning item.id, targets.previous_status
    ), logged as (
      insert into public.publication_item_events (
        organization_id, publication_item_id, event_type, previous_status,
        status, actor_label, error_code, error_message, metadata
      )
      select incident_row.organization_id, ignored.id, 'cancelled',
        ignored.previous_status, 'ignored', 'system: zernio-profile-recycling',
        removal_code, removal_message,
        jsonb_build_object('incident_id', incident_row.id)
      from ignored returning publication_item_id
    ) select count(*)::integer into ignored_count from logged;

    ignored_count := ignored_count + 1;
    delete from public.publication_profile_daily_reservations reservation
    using public.publication_items item
    where reservation.publication_item_id = item.id
      and item.organization_id = incident_row.organization_id
      and item.profile_id = incident_row.profile_id
      and item.status = 'ignored';
    delete from public.publication_dispatch_rate_reservations reservation
    using public.publication_items item
    where reservation.publication_item_id = item.id
      and item.organization_id = incident_row.organization_id
      and item.profile_id = incident_row.profile_id
      and item.status = 'ignored';
    update public.bulk_publication_generation_chunks chunk set
      status = 'cancelled', completed_at = coalesce(completed_at, timezone('utc', now())),
      claimed_by = null, lease_until = null
    where chunk.organization_id = incident_row.organization_id
      and chunk.profile_id = incident_row.profile_id
      and chunk.status in ('queued', 'processing', 'failed', 'paused');
    update public.bulk_publication_profile_horizons horizon set
      status = 'cancelled', released_at = coalesce(released_at, timezone('utc', now()))
    where horizon.organization_id = incident_row.organization_id
      and horizon.profile_id = incident_row.profile_id
      and horizon.status = 'active';
    with updated_plans as (
      update public.bulk_publication_plan_profiles plan_profile set
        status = 'cancelled', suspended_at = coalesce(suspended_at, timezone('utc', now())),
        suspension_reason = removal_message
      where plan_profile.organization_id = incident_row.organization_id
        and plan_profile.profile_id = incident_row.profile_id
        and plan_profile.status in ('queued', 'generating', 'suspended')
      returning plan_profile.id
    ) select count(*)::integer into plan_count from updated_plans;
    delete from public.profile_group_members
    where organization_id = incident_row.organization_id
      and profile_id = incident_row.profile_id;
    update public.instagram_profiles set
      deleted_at = timezone('utc', now()), status = 'offline',
      last_error_code = removal_code,
      last_error_message = removal_message
    where id = profile_row.id and organization_id = profile_row.organization_id;
  end if;

  for affected_batch in
    select distinct item.batch_id
    from public.publication_items item
    where item.organization_id = incident_row.organization_id
      and item.profile_id = incident_row.profile_id
  loop
    perform public.sync_publication_batch_status(affected_batch);
  end loop;

  update public.zernio_profile_disconnection_incidents set
    state = 'completed',
    remote_http_status = coalesce(p_http_status, case when p_remote_outcome = 'already_disconnected_404' then 404 else 200 end),
    remote_request_id = left(nullif(trim(p_request_id), ''), 160),
    remote_result = p_remote_outcome,
    remote_completed_at = timezone('utc', now()),
    finalized_at = timezone('utc', now()),
    ignored_item_count = ignored_count,
    interrupted_plan_count = plan_count,
    defer_reason = null
  where id = incident_row.id;

  update public.zernio_profile_recycling_jobs set
    status = 'completed', claimed_by = null, lease_until = null,
    completed_at = timezone('utc', now()),
    last_http_status = coalesce(p_http_status, case when p_remote_outcome = 'already_disconnected_404' then 404 else 200 end),
    last_request_id = left(nullif(trim(p_request_id), ''), 160),
    last_error_code = null, last_error_message = null,
    last_outcome = p_remote_outcome, deferred_reason = null
  where id = job_row.id;

  insert into public.zernio_profile_recycling_job_events (
    organization_id, job_id, incident_id, event_type,
    previous_status, status, attempt_count, metadata
  ) values (
    job_row.organization_id, job_row.id, incident_row.id,
    'completed', 'processing', 'completed', job_row.attempt_count,
    jsonb_build_object('outcome', p_remote_outcome, 'httpStatus', p_http_status)
  );

  return jsonb_build_object(
    'completed', true, 'incidentId', incident_row.id,
    'ignoredItemCount', ignored_count, 'interruptedPlanCount', plan_count,
    'outcome', p_remote_outcome
  );
end;
$$;
revoke all on function public.complete_zernio_profile_recycling(uuid, text, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_zernio_profile_recycling(uuid, text, text, integer, text, text, text) to service_role;

notify pgrst, 'reload schema';
