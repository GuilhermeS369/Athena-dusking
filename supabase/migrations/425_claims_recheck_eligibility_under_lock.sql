-- 425 — os claims reconferem a elegibilidade dentro da trava.
--
-- Em claim_publication_items e claim_publication_preparation_items, quem e
-- elegivel era decidido no CTE `source`/`eligible` (foto do inicio da
-- transacao) e a trava `for update skip locked` vinha depois, SEM repetir as
-- condicoes. Com dois ou mais processos, o segundo claim via a linha ainda
-- livre na foto, esperava a trava e sobrescrevia o claim que o primeiro acabara
-- de commitar. O primeiro perdia o lease em silencio e levantava P0002 ("Item
-- nao esta sob lease deste worker") na reserva de capacidade ou na conclusao.
--
-- MEDIDO EM 07/09/2026, com tres publicadores no projeto novo: 79 P0002 no log
-- do Postgres em 2,5 h, ~40 por processo a cada 15 minutos nos logs da VPS;
-- zero duplicatas na Meta porque o lease e conferido logo antes de cada chamada
-- ao provedor -- o custo era claim desperdicado e erro em laco, nao post
-- repetido. Com um processo so o problema nao existe, por isso nunca apareceu.
--
-- `for update` em READ COMMITTED reavalia o WHERE na versao atual da linha
-- (EvalPlanQual): repetir as condicoes de lease/status aqui exclui o item que
-- outro processo levou entre a foto e a trava. Corpos identicos aos vigentes
-- (405 e 264) fora do CTE `locked`.

CREATE OR REPLACE FUNCTION public.claim_publication_items(p_worker_id text, p_limit integer DEFAULT 10, p_lease_seconds integer DEFAULT 120)
 RETURNS TABLE(id uuid, organization_id uuid, batch_id uuid, profile_id uuid, format publication_format, status publication_item_status, execute_at timestamp with time zone, caption text, idempotency_key text, attempt_count integer, creation_id text, lease_until timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  blocked_profile_ids uuid[];
  lateness_seconds integer;
  lateness_cutoff timestamptz;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'Somente service_role pode reivindicar publicações.'; end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120
    or p_limit not between 1 and 100 or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Parâmetros de claim inválidos.';
  end if;

  select coalesce(array_agg(profile.id), '{}'::uuid[]) into blocked_profile_ids
  from public.instagram_profiles profile
  join public.meta_apps app on app.id = profile.meta_app_id
  where profile.deleted_at is null
    and app.api_block_until is not null
    and app.api_block_until > timezone('utc', now());

  -- A linha global (organização e provedor nulos) é o padrão da instalação; uma
  -- linha por organização sobrepõe. Pega-se o menor limite entre as que valem,
  -- porque afrouxar sem querer é pior do que apertar sem querer.
  select min(settings.max_publication_lateness_seconds) into lateness_seconds
  from public.publication_rate_limit_settings settings
  where settings.enabled
    and settings.max_publication_lateness_seconds is not null;

  lateness_cutoff := case
    when lateness_seconds is null then null
    else timezone('utc', now()) - make_interval(secs => lateness_seconds)
  end;

  return query
  with source as (
    select item.id, item.organization_id, item.profile_id, item.execute_at, item.created_at,
      case when item.creation_id is not null then 0 else 1 end priority_band
    from public.publication_items item
    where item.archived_at is null
      and item.status in ('ready', 'waiting', 'preparing', 'failed')
      and (item.status <> 'failed' or (item.attempt_count < 5 and item.next_attempt_at is not null))
      and (item.execute_at is null or item.execute_at <= timezone('utc', now()))
      -- A trava de atraso. Item já aceito pelo provedor passa direto.
      and (
        lateness_cutoff is null
        or item.creation_id is not null
        or item.execute_at is null
        or item.execute_at >= lateness_cutoff
      )
      and (item.next_attempt_at is null or item.next_attempt_at <= timezone('utc', now()))
      and (item.lease_until is null or item.lease_until <= timezone('utc', now()))
      and (item.dispatch_staged_until is null or item.dispatch_staged_until <= timezone('utc', now()))
      and (item.pipeline_version = 1 or item.creation_id is not null or item.preparation_status = 'ready')
      and not (coalesce(item.zernio_recovery_count, 0) > 0 and item.creation_id is null)
      and not (item.profile_id = any(blocked_profile_ids))
      and (
        item.creation_id is not null
        or not exists (
          select 1 from public.publication_batch_circuit_breakers breaker
          where breaker.batch_id = item.batch_id and breaker.paused_at is not null
        )
      )
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
    -- RECONFERE SOB A TRAVA. O `source` acima e uma foto do inicio da transacao;
    -- `for update` reavalia estas condicoes na versao ATUAL da linha. Sem elas,
    -- um item que outro processo acabou de reivindicar (commit entre a foto e a
    -- trava) era reivindicado de novo, o primeiro perdia o lease sem saber e
    -- levantava P0002 na reserva ou na conclusao. Medido em 07/09/2026 com tres
    -- publicadores: ~40 P0002 por processo a cada 15 minutos.
    select item.id from public.publication_items item join selected on selected.id = item.id
    where item.archived_at is null
      and item.status in ('ready', 'waiting', 'preparing', 'failed')
      and (item.lease_until is null or item.lease_until <= timezone('utc', now()))
      and (item.next_attempt_at is null or item.next_attempt_at <= timezone('utc', now()))
      and (item.dispatch_staged_until is null or item.dispatch_staged_until <= timezone('utc', now()))
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
$function$;

CREATE OR REPLACE FUNCTION public.claim_publication_preparation_items(p_worker_id text, p_limit integer DEFAULT 50, p_lease_seconds integer DEFAULT 180, p_window_hours integer DEFAULT 24)
 RETURNS TABLE(id uuid, organization_id uuid, batch_id uuid, profile_id uuid, format publication_format, execute_at timestamp with time zone, caption text, idempotency_key text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Limite de preparação deve estar entre 1 e 500';
  end if;
  if p_lease_seconds not between 30 and 900 or p_window_hours not between 1 and 24 then
    raise exception using errcode = '22023', message = 'Janela ou lease de preparação inválido';
  end if;

  return query
  with eligible as (
    select item.id,
      row_number() over (partition by item.organization_id order by item.execute_at, item.created_at, item.id) as org_position,
      row_number() over (partition by item.profile_id order by item.execute_at, item.created_at, item.id) as profile_position
    from public.publication_items item
    where item.pipeline_version = 2
      and item.status in ('waiting', 'ready')
      and item.creation_id is null
      and (item.execute_at is null
        or item.execute_at <= timezone('utc', now()) + make_interval(hours => p_window_hours))
      and item.preparation_status in ('pending', 'blocked', 'preparing')
      and (item.next_preparation_at is null or item.next_preparation_at <= timezone('utc', now()))
      and (item.preparation_lease_until is null or item.preparation_lease_until <= timezone('utc', now()))
  ), selected as (
    select eligible.id from eligible
    order by eligible.profile_position, eligible.org_position, eligible.id
    limit p_limit
  ), locked as (
    -- Reconfere sob a trava, pelo mesmo motivo do claim de despacho (ver 425).
    select item.id from public.publication_items item
    join selected on selected.id = item.id
    where item.status in ('waiting', 'ready')
      and item.creation_id is null
      and item.preparation_status in ('pending', 'blocked', 'preparing')
      and (item.preparation_lease_until is null or item.preparation_lease_until <= timezone('utc', now()))
    for update of item skip locked
  ), claimed as (
    update public.publication_items item
    set preparation_status = 'preparing',
        preparation_claimed_by = trim(p_worker_id),
        preparation_lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds)
    from locked
    where item.id = locked.id
    returning item.*
  )
  select claimed.id, claimed.organization_id, claimed.batch_id, claimed.profile_id,
    claimed.format, claimed.execute_at, claimed.caption, claimed.idempotency_key
  from claimed;
end;
$function$;
