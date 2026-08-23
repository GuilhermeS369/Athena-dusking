-- Analytics X: reserva conservadora para fan-out e liquidação somente por uso comprovado.
-- Aditiva para dados; substitui apenas os RPCs exclusivos do módulo X.

alter table public.twitter_analytics_items
  add column unit_cost_micros bigint,
  add column reserved_units integer,
  add column settled_units integer not null default 0,
  add column released_micros bigint not null default 0,
  add column billing_contract_version integer not null default 1;

update public.twitter_analytics_items
set unit_cost_micros = amount_micros,
    reserved_units = 1;

alter table public.twitter_analytics_items
  alter column unit_cost_micros set not null,
  alter column reserved_units set not null,
  alter column billing_contract_version set default 2,
  drop constraint twitter_analytics_items_amount_micros_check,
  add constraint twitter_analytics_items_unit_cost_check
    check (unit_cost_micros in (5000, 10000)),
  add constraint twitter_analytics_items_reserved_units_check
    check (reserved_units between 1 and 9),
  add constraint twitter_analytics_items_amount_fanout_check
    check (amount_micros = unit_cost_micros * reserved_units),
  add constraint twitter_analytics_items_settled_units_check
    check (settled_units between 0 and reserved_units),
  add constraint twitter_analytics_items_released_micros_check
    check (released_micros between 0 and amount_micros),
  add constraint twitter_analytics_items_resource_fanout_check
    check (
      (resource_type = 'post' and category = 'post_read' and unit_cost_micros = 5000 and reserved_units = 9)
      or
      (resource_type = 'profile' and category = 'user_read_follow_article' and unit_cost_micros = 10000 and reserved_units = 1)
      or billing_contract_version = 1
    ) not valid;

-- Uma conexão com resultado incerto bloqueia novas leituras até reconciliação.
create unique index twitter_analytics_one_unresolved_connection
  on public.twitter_analytics_items (connection_id)
  where status in ('processing', 'outcome_unknown');

create or replace function public.twitter_confirm_analytics_job(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_idempotency_key text,
  p_quote_digest text,
  p_rate_card_version integer,
  p_wallet_snapshots jsonb,
  p_resources jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  existing public.twitter_analytics_jobs;
  job public.twitter_analytics_jobs;
  card public.twitter_rate_cards;
  resource jsonb;
  normalized jsonb := '[]'::jsonb;
  row record;
  wallet public.twitter_wallets;
  expected_version bigint;
  reservation jsonb;
  reservation_id uuid;
  total bigint := 0;
  count_resources integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception using errcode = '42501'; end if;
  select * into existing from public.twitter_analytics_jobs where organization_id = p_organization_id and idempotency_key = trim(p_idempotency_key);
  if found then return jsonb_build_object('jobId', existing.id, 'idempotentReplay', true, 'reservedMicros', existing.reserved_micros); end if;
  if jsonb_typeof(p_resources) <> 'array' or jsonb_array_length(p_resources) = 0 or jsonb_array_length(p_resources) > 1000 then
    raise exception using errcode = '22023', message = 'Recursos de analytics inválidos.';
  end if;
  select * into card from public.twitter_rate_cards where active and version = p_rate_card_version;
  if not found then raise exception using errcode = '40001', message = 'Tabela de preços mudou; revise novamente.'; end if;

  for resource in select value from jsonb_array_elements(p_resources) loop
    if resource ->> 'type' = 'post' then
      select jsonb_build_object(
        'resource_type', 'post', 'resource_key', 'post:' || i.id,
        'identity_id', i.identity_id, 'connection_id', i.connection_id, 'profile_id', i.profile_id,
        'publication_item_id', i.id, 'zernio_post_id', a.post_id, 'category', 'post_read',
        'unit_cost_micros', r.unit_cost_micros, 'reserved_units', 9,
        'amount_micros', r.unit_cost_micros * 9
      ) into resource
      from public.twitter_publication_items i
      join lateral (
        select pa.post_id from public.twitter_publication_attempts pa
        where pa.item_id = i.id and pa.status = 'published' and pa.post_id is not null
        order by pa.created_at desc limit 1
      ) a on true
      join public.twitter_cost_rates r on r.rate_card_id = card.id and r.category = 'post_read'
      where i.id = (resource ->> 'id')::uuid and i.organization_id = p_organization_id and i.status = 'published';
    elsif resource ->> 'type' = 'profile' then
      select jsonb_build_object(
        'resource_type', 'profile', 'resource_key', 'profile:' || p.id,
        'identity_id', c.identity_id, 'connection_id', e.connection_id, 'profile_id', p.id,
        'publication_item_id', null, 'zernio_post_id', null, 'category', 'user_read_follow_article',
        'unit_cost_micros', r.unit_cost_micros, 'reserved_units', 1,
        'amount_micros', r.unit_cost_micros
      ) into resource
      from public.twitter_profiles p
      join public.twitter_profile_connection_epochs e on e.id = p.current_epoch_id
      join public.twitter_connections c on c.id = e.connection_id
      join public.twitter_cost_rates r on r.rate_card_id = card.id and r.category = 'user_read_follow_article'
      where p.id = (resource ->> 'id')::uuid and p.organization_id = p_organization_id
        and p.deleted_at is null and e.ended_at is null and c.deleted_at is null;
    else
      raise exception using errcode = '22023', message = 'Tipo de analytics inválido.';
    end if;
    if resource is null then raise exception using errcode = '22023', message = 'Recurso de analytics indisponível.'; end if;
    normalized := normalized || jsonb_build_array(resource);
    total := total + (resource ->> 'amount_micros')::bigint;
    count_resources := count_resources + 1;
  end loop;

  if (select count(distinct value ->> 'resource_key') from jsonb_array_elements(normalized)) <> count_resources then
    raise exception using errcode = '22023', message = 'Recursos duplicados.';
  end if;

  insert into public.twitter_analytics_jobs(
    organization_id, resource_count, reserved_micros, rate_card_id, rate_card_version,
    quote_digest, idempotency_key, created_by
  ) values (
    p_organization_id, count_resources, total, card.id, card.version,
    p_quote_digest, trim(p_idempotency_key), p_actor_user_id
  ) returning * into job;

  for row in
    select x.identity_id, x.connection_id, x.category, sum(x.amount_micros)::bigint cost
    from jsonb_to_recordset(normalized) as x(
      identity_id uuid, connection_id uuid, category public.twitter_price_category, amount_micros bigint
    ) group by x.identity_id, x.connection_id, x.category order by x.identity_id, x.category
  loop
    select * into wallet from public.twitter_wallets where identity_id = row.identity_id and organization_id = p_organization_id for update;
    if not found then raise exception using errcode = 'P0002', message = 'Carteira de analytics ausente.'; end if;
    select (s ->> 'walletVersion')::bigint into expected_version from jsonb_array_elements(p_wallet_snapshots) s where s ->> 'identityId' = row.identity_id::text;
    if expected_version is null or expected_version <> wallet.version then raise exception using errcode = '40001', message = 'Carteira mudou; revise novamente.'; end if;
    if wallet.posted_balance_micros - wallet.reserved_micros - row.cost < 5000000 then
      raise exception using errcode = 'P0001', message = 'Piso protegido de US$ 5,00 impede esta análise.';
    end if;
    reservation := public.twitter_create_wallet_reservation(
      p_organization_id, row.identity_id, row.connection_id, card.version, row.category,
      'analytics', job.id, row.cost, wallet.version,
      'analytics:' || job.id || ':' || row.identity_id || ':' || row.category
    );
    reservation_id := (reservation ->> 'reservationId')::uuid;
    insert into public.twitter_analytics_job_reservations values(job.id, reservation_id, row.identity_id, row.category);
    select * into wallet from public.twitter_wallets where identity_id = row.identity_id for update;
    p_wallet_snapshots := coalesce((
      select jsonb_agg(case when s ->> 'identityId' = row.identity_id::text then jsonb_set(s, '{walletVersion}', to_jsonb(wallet.version)) else s end)
      from jsonb_array_elements(p_wallet_snapshots) s
    ), '[]');
  end loop;

  insert into public.twitter_analytics_items(
    job_id, organization_id, resource_type, resource_key, identity_id, connection_id,
    profile_id, publication_item_id, zernio_post_id, category, amount_micros,
    unit_cost_micros, reserved_units, billing_contract_version
  )
  select job.id, p_organization_id, x.resource_type, x.resource_key, x.identity_id,
    x.connection_id, x.profile_id, x.publication_item_id, x.zernio_post_id,
    x.category, x.amount_micros, x.unit_cost_micros, x.reserved_units, 2
  from jsonb_to_recordset(normalized) as x(
    resource_type public.twitter_analytics_resource_type, resource_key text, identity_id uuid,
    connection_id uuid, profile_id uuid, publication_item_id uuid, zernio_post_id text,
    category public.twitter_price_category, amount_micros bigint, unit_cost_micros bigint,
    reserved_units integer
  );
  return jsonb_build_object('jobId', job.id, 'resourceCount', count_resources, 'reservedMicros', total, 'idempotentReplay', false);
end $$;

create or replace function public.twitter_claim_analytics_items(p_worker_id text, p_limit integer)
returns table(
  item_id uuid, attempt_id uuid, organization_id uuid, job_id uuid,
  resource_type public.twitter_analytics_resource_type, resource_id uuid,
  profile_id uuid, connection_id uuid, zernio_post_id text, amount_micros bigint
) language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception using errcode = '42501'; end if;
  return query
  with candidates as (
    select i.id from public.twitter_analytics_items i
    where i.status = 'reserved'
      and i.id = (
        select queued.id from public.twitter_analytics_items queued
        where queued.connection_id = i.connection_id and queued.status = 'reserved'
        order by queued.created_at, queued.id limit 1
      )
      and not exists (
        select 1 from public.twitter_analytics_items a
        where a.connection_id = i.connection_id and a.status in ('processing', 'outcome_unknown')
      )
    order by i.created_at, i.id for update skip locked
    limit least(greatest(p_limit, 1), 50)
  ), updated as (
    update public.twitter_analytics_items i
    set status = 'processing', claimed_at = timezone('utc', now()), claimed_by = p_worker_id,
        attempt_count = attempt_count + 1
    from candidates c where i.id = c.id returning i.*
  ), attempts(attempt_id_value, attempt_item_id) as (
    insert into public.twitter_analytics_attempts(organization_id, item_id, attempt_number, worker_id, idempotency_key)
    select u.organization_id, u.id, u.attempt_count, p_worker_id,
      'analytics-attempt:' || u.id || ':' || u.attempt_count from updated u
    returning public.twitter_analytics_attempts.id, public.twitter_analytics_attempts.item_id
  )
  update public.twitter_analytics_jobs j
  set status = 'processing', started_at = coalesce(j.started_at, timezone('utc', now()))
  from updated u where j.id = u.job_id
  returning u.id,
    (select attempts.attempt_id_value from attempts where attempts.attempt_item_id = u.id),
    u.organization_id, u.job_id, u.resource_type,
    case when u.resource_type = 'post' then u.publication_item_id else u.profile_id end,
    u.profile_id, u.connection_id, u.zernio_post_id, u.amount_micros;
end $$;

drop function public.twitter_complete_analytics_item(uuid,text,text,jsonb,timestamptz,integer,text,text,text,jsonb);

create function public.twitter_complete_analytics_item(
  p_attempt_id uuid,
  p_resolution text,
  p_idempotency_key text,
  p_metrics jsonb default '{}'::jsonb,
  p_provider_updated_at timestamptz default null,
  p_http_status integer default null,
  p_provider_code text default null,
  p_request_id text default null,
  p_message text default null,
  p_evidence jsonb default '{}'::jsonb,
  p_billed_units integer default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a public.twitter_analytics_attempts;
  i public.twitter_analytics_items;
  r public.twitter_wallet_reservations;
  released bigint := 0;
  settled bigint := 0;
  merged_evidence jsonb;
  snapshot_metrics jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception using errcode = '42501'; end if;
  if p_resolution not in ('succeeded', 'failed', 'outcome_unknown') then raise exception using errcode = '22023'; end if;
  if exists(select 1 from public.twitter_analytics_result_events where idempotency_key = p_idempotency_key) then
    return jsonb_build_object('idempotentReplay', true);
  end if;

  select * into a from public.twitter_analytics_attempts where id = p_attempt_id for update;
  if not found then raise exception using errcode = 'P0002'; end if;
  select * into i from public.twitter_analytics_items where id = a.item_id for update;
  if i.status in ('succeeded', 'failed', 'cancelled') then
    raise exception using errcode = '55000', message = 'Item de analytics já possui resultado terminal.';
  end if;
  select wr.* into r
  from public.twitter_analytics_job_reservations jr
  join public.twitter_wallet_reservations wr on wr.id = jr.reservation_id
  where jr.job_id = i.job_id and jr.identity_id = i.identity_id and jr.category = i.category
  for update;

  merged_evidence := coalesce(a.evidence, '{}'::jsonb) || coalesce(p_evidence, '{}'::jsonb);

  if p_resolution = 'succeeded' then
    if p_billed_units is null or p_billed_units < 0 or p_billed_units > i.reserved_units then
      raise exception using errcode = '22023', message = 'Unidades cobradas excedem a reserva do recurso.';
    end if;
    settled := i.unit_cost_micros * p_billed_units;
    released := i.amount_micros - settled;
    if settled > 0 then
      perform public.twitter_settle_wallet_reservation(
        r.id, settled, p_idempotency_key || ':debit',
        jsonb_build_object('analyticsItemId', i.id, 'attemptId', a.id, 'billedUnits', p_billed_units)
      );
    end if;
    if released > 0 then
      update public.twitter_wallet_reservations
      set remaining_micros = remaining_micros - released,
          released_micros = released_micros + released,
          status = case
            when remaining_micros - released = 0 and settled_micros > 0 then 'settled'::public.twitter_reservation_status
            when remaining_micros - released = 0 then 'released'::public.twitter_reservation_status
            else 'partially_settled'::public.twitter_reservation_status
          end,
          outcome_unknown_at = null,
          resolved_at = case when remaining_micros - released = 0 then timezone('utc', now()) else resolved_at end
      where id = r.id;
      update public.twitter_wallets
      set reserved_micros = reserved_micros - released, version = version + 1
      where identity_id = r.identity_id;
      insert into public.twitter_reservation_events(
        reservation_id, organization_id, event_type, amount_micros, idempotency_key, reason, metadata
      ) values (
        r.id, i.organization_id, 'released', released, p_idempotency_key || ':release',
        'Excedente da reserva de analytics não utilizado.',
        jsonb_build_object('analyticsItemId', i.id, 'reservedUnits', i.reserved_units, 'billedUnits', p_billed_units)
      );
    end if;
    snapshot_metrics := case
      when coalesce(p_metrics, '{}'::jsonb) <> '{}'::jsonb then p_metrics
      else coalesce(a.evidence -> 'pendingMetrics', '{}'::jsonb)
    end;
    insert into public.twitter_analytics_snapshots(
      organization_id, analytics_item_id, resource_type, profile_id, publication_item_id,
      metrics, provider_updated_at
    ) values (
      i.organization_id, i.id, i.resource_type, i.profile_id, i.publication_item_id,
      snapshot_metrics, p_provider_updated_at
    );
    update public.twitter_analytics_items
    set status = 'succeeded', result_code = p_provider_code, error_message = null,
        settled_units = p_billed_units, released_micros = released
    where id = i.id;
    update public.twitter_analytics_attempts set status = 'succeeded', finished_at = timezone('utc', now()) where id = a.id;
  elsif p_resolution = 'failed' then
    released := i.amount_micros;
    update public.twitter_wallet_reservations
    set remaining_micros = remaining_micros - released,
        released_micros = released_micros + released,
        status = case
          when remaining_micros - released = 0 and settled_micros > 0 then 'settled'::public.twitter_reservation_status
          when remaining_micros - released = 0 then 'released'::public.twitter_reservation_status
          else 'partially_settled'::public.twitter_reservation_status
        end,
        outcome_unknown_at = null,
        resolved_at = case when remaining_micros - released = 0 then timezone('utc', now()) else resolved_at end
    where id = r.id;
    update public.twitter_wallets set reserved_micros = reserved_micros - released, version = version + 1 where identity_id = r.identity_id;
    insert into public.twitter_reservation_events(
      reservation_id, organization_id, event_type, amount_micros, idempotency_key, reason, metadata
    ) values (
      r.id, i.organization_id, 'released', released, p_idempotency_key || ':release', p_message,
      jsonb_build_object('analyticsItemId', i.id, 'reservedUnits', i.reserved_units)
    );
    update public.twitter_analytics_items
    set status = 'failed', result_code = p_provider_code, error_message = left(p_message, 1000),
        settled_units = 0, released_micros = released
    where id = i.id;
    update public.twitter_analytics_attempts set status = 'failed', finished_at = timezone('utc', now()) where id = a.id;
  else
    update public.twitter_analytics_items set status = 'outcome_unknown', result_code = p_provider_code, error_message = left(p_message, 1000) where id = i.id;
    update public.twitter_analytics_attempts set status = 'outcome_unknown', finished_at = timezone('utc', now()) where id = a.id;
  end if;

  merged_evidence := merged_evidence || jsonb_build_object(
    'reservedUnits', i.reserved_units, 'billedUnits', p_billed_units,
    'unitCostMicros', i.unit_cost_micros, 'settledMicros', settled, 'releasedMicros', released
  );
  update public.twitter_analytics_attempts
  set http_status = p_http_status, provider_code = p_provider_code, request_id = p_request_id,
      error_message = left(p_message, 1000), evidence = merged_evidence
  where id = a.id;
  insert into public.twitter_analytics_result_events(
    organization_id, item_id, attempt_id, resolution, amount_micros, idempotency_key, evidence
  ) values (
    i.organization_id, i.id, a.id, p_resolution, settled, p_idempotency_key, merged_evidence
  );

  update public.twitter_analytics_jobs j
  set status = case
    when exists(select 1 from public.twitter_analytics_items x where x.job_id = j.id and x.status in ('reserved','processing')) then 'processing'::public.twitter_analytics_job_status
    when exists(select 1 from public.twitter_analytics_items x where x.job_id = j.id and x.status = 'outcome_unknown') then 'outcome_unknown'::public.twitter_analytics_job_status
    when exists(select 1 from public.twitter_analytics_items x where x.job_id = j.id and x.status = 'succeeded')
      and exists(select 1 from public.twitter_analytics_items x where x.job_id = j.id and x.status in ('failed','cancelled')) then 'partially_succeeded'::public.twitter_analytics_job_status
    when not exists(select 1 from public.twitter_analytics_items x where x.job_id = j.id and x.status <> 'succeeded') then 'succeeded'::public.twitter_analytics_job_status
    else 'failed'::public.twitter_analytics_job_status
  end,
  finished_at = case when not exists(select 1 from public.twitter_analytics_items x where x.job_id = j.id and x.status in ('reserved','processing')) then timezone('utc', now()) else null end
  where j.id = i.job_id;

  return jsonb_build_object(
    'itemId', i.id, 'settledMicros', settled, 'releasedMicros', released,
    'settledUnits', coalesce(p_billed_units, 0), 'resolution', p_resolution, 'idempotentReplay', false
  );
end $$;

revoke all on function public.twitter_confirm_analytics_job(uuid,uuid,text,text,integer,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.twitter_confirm_analytics_job(uuid,uuid,text,text,integer,jsonb,jsonb) to service_role;
revoke all on function public.twitter_claim_analytics_items(text,integer) from public, anon, authenticated;
grant execute on function public.twitter_claim_analytics_items(text,integer) to service_role;
revoke all on function public.twitter_complete_analytics_item(uuid,text,text,jsonb,timestamptz,integer,text,text,text,jsonb,integer) from public, anon, authenticated;
grant execute on function public.twitter_complete_analytics_item(uuid,text,text,jsonb,timestamptz,integer,text,text,text,jsonb,integer) to service_role;
