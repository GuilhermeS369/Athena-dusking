-- 426 — story tem janela de atraso propria, medida em tentativas; falha retryavel
-- alem do corte deixa de ficar presa em 'failed'.
--
-- DECISAO DO DONO (09/09/2026). Story e 1 por perfil por dia: perder um por
-- soluco da Meta custa o dia inteiro daquele perfil. Reel dói menos, porque o
-- proximo vem em 1 h. Ele nao quer "insistir por horas"; quer insistir por um
-- numero de TENTATIVAS. Entao:
--
--   * reel (e qualquer formato sem entrada em
--     max_publication_lateness_seconds_by_format) continua com os 300 s da 405;
--   * story ganha 1 h de janela (`{"story": 3600}`), valida so enquanto
--     attempt_count < 5 -- o recuo da 420 (30 s -> 15 min) da ~15 min de
--     insistencia real, e a hora e o teto de seguranca se a Meta cair de vez;
--   * falha de conteudo continua terminal (nao entra aqui: nao tem retry).
--
-- O QUE ESTAVA ERRADO. Em 09/09/2026 as 06:23Z a Meta demorou >25 s para criar
-- 22 contêineres de story. A falha e retryavel e a 420 marcou retry para +90 s;
-- quando o retry venceu, o item ja tinha passado dos 300 s. O claim (405/425) o
-- excluia pelo corte -- certo -- mas expire_late_publication_items so encerrava
-- 'waiting'/'ready' e o arquivador (335) so arquiva falha terminal. Resultado:
-- 22 itens 'failed' com next_attempt_at no passado, para sempre, contando como
-- erro na tela e na rota de saude. Esta migration encerra esses como
-- publication_past_due (fora da janela do formato) e, dentro da janela, deixa o
-- claim tenta-los de novo.
--
-- Corpos identicos aos vigentes (425 e 405) fora dos trechos marcados com 426.

alter table public.publication_rate_limit_settings
  add column if not exists max_publication_lateness_seconds_by_format jsonb not null default '{"story": 3600}'::jsonb;

comment on column public.publication_rate_limit_settings.max_publication_lateness_seconds_by_format is
  '426: janela de atraso por formato (segundos), valida enquanto attempt_count < 5. Formato ausente usa max_publication_lateness_seconds. Padrao {"story": 3600}.';

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
  lateness_by_format jsonb;
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

  -- 426: janela propria por formato (hoje so story), valida enquanto o item ainda
  -- tiver tentativa sobrando. Menor valor entre as linhas habilitadas, chave a chave.
  select coalesce(jsonb_object_agg(fmt.key, fmt.min_value), '{}'::jsonb) into lateness_by_format
  from (
    select kv.key, min((kv.value)::integer) as min_value
    from public.publication_rate_limit_settings settings,
         jsonb_each_text(coalesce(settings.max_publication_lateness_seconds_by_format, '{}'::jsonb)) kv
    where settings.enabled
    group by kv.key
  ) fmt;

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
        -- 426: story tem janela propria (padrao 1 h) enquanto houver tentativa (< 5).
        -- O dono decidiu em 09/09/2026: story e 1 por perfil por dia; perder um
        -- por soluco da Meta custa o dia inteiro do perfil. Reel fica nos 300 s.
        or (
          (lateness_by_format ->> item.format::text) is not null
          and item.attempt_count < 5
          and item.execute_at >= timezone('utc', now())
            - make_interval(secs => (lateness_by_format ->> item.format::text)::integer)
        )
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

CREATE OR REPLACE FUNCTION public.expire_late_publication_items(p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  lateness_seconds integer;
  cutoff timestamptz;
  expired_count integer := 0;
  lateness_by_format jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode encerrar publicações vencidas.';
  end if;
  if p_limit not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'Limite inválido.';
  end if;

  select min(settings.max_publication_lateness_seconds) into lateness_seconds
  from public.publication_rate_limit_settings settings
  where settings.enabled
    and settings.max_publication_lateness_seconds is not null;

  if lateness_seconds is null then
    return jsonb_build_object('expired', 0, 'disabled', true);
  end if;
  cutoff := timezone('utc', now()) - make_interval(secs => lateness_seconds);

  -- 426: mesma janela por formato do claim.
  select coalesce(jsonb_object_agg(fmt.key, fmt.min_value), '{}'::jsonb) into lateness_by_format
  from (
    select kv.key, min((kv.value)::integer) as min_value
    from public.publication_rate_limit_settings settings,
         jsonb_each_text(coalesce(settings.max_publication_lateness_seconds_by_format, '{}'::jsonb)) kv
    where settings.enabled
    group by kv.key
  ) fmt;

  with alvos as (
    select item.id, item.status as previous_status
    from public.publication_items item
    where item.archived_at is null
      -- 426: tambem a falha RETRYAVEL cujo retry venceu depois do corte. Antes ela
      -- ficava 'failed' para sempre: o claim a excluia pelo corte e nada a encerrava
      -- (22 stories em 09/09/2026, 06:20Z).
      and (
        item.status in ('waiting', 'ready')
        or (item.status = 'failed' and item.next_attempt_at is not null)
      )
      and item.creation_id is null
      and item.execute_at is not null
      and item.execute_at < cutoff
      -- 426: formato com janela propria so vence depois da janela ou sem tentativa.
      and not (
        (lateness_by_format ->> item.format::text) is not null
        and item.attempt_count < 5
        and item.execute_at >= timezone('utc', now())
          - make_interval(secs => (lateness_by_format ->> item.format::text)::integer)
      )
      and (item.lease_until is null or item.lease_until <= timezone('utc', now()))
      and (item.dispatch_staged_until is null or item.dispatch_staged_until <= timezone('utc', now()))
    order by item.execute_at, item.id
    limit p_limit
    for update skip locked
  ), encerrados as (
    update public.publication_items item set
      status = 'ignored', claimed_by = null, lease_until = null, next_attempt_at = null,
      dispatch_staged_by = null, dispatch_staged_at = null, dispatch_staged_until = null,
      last_error_code = 'publication_past_due',
      last_error_message = 'Passou do horário agendado; não é publicada atrasada.'
    from alvos
    where item.id = alvos.id
    returning item.id, item.organization_id, item.status, alvos.previous_status
  ), eventos as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status,
      status, actor_label, error_code, error_message, metadata
    )
    select encerrados.organization_id, encerrados.id, 'ignored', encerrados.previous_status, 'ignored',
      'system: past-due', 'publication_past_due',
      'Passou do horário agendado; não é publicada atrasada.',
      jsonb_build_object('cutoff_at', cutoff, 'lateness_seconds', lateness_seconds)
    from encerrados
    returning publication_item_id
  )
  select count(*)::integer into expired_count from encerrados;

  delete from public.publication_profile_daily_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.status = 'ignored'
    and item.last_error_code = 'publication_past_due';

  delete from public.publication_dispatch_rate_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.status = 'ignored'
    and item.last_error_code = 'publication_past_due';

  return jsonb_build_object('expired', expired_count, 'cutoffAt', cutoff, 'latenessSeconds', lateness_seconds);
end;
$function$;
