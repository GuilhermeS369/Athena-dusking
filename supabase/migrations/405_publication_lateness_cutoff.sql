-- Publicação que passou do horário não é enviada atrasada. Nunca.
--
-- A REGRA, dita pela operação em 06/09/2026: "se já passou do horário NÃO É PRA
-- POSTAR". O motivo é concreto e não é estético -- publicar de uma vez o que
-- ficou represado por horas é o padrão que faz o Instagram derrubar conta.
--
-- O QUE ACONTECEU HOJE. Três lotes ficaram congelados por um disjuntor durante
-- horas. Ao serem retomados, os 14 mil itens presos viraram fila liberada de
-- uma vez: em vinte minutos saíram 189 publicações com MAIS DE TRÊS HORAS de
-- atraso, a mais antiga com 603 minutos. O espaçamento por perfil segurou o
-- pior (no máximo 3 posts por conta em 20 min), mas o comportamento estava
-- errado do começo.
--
-- POR QUE NÃO HAVIA TRAVA. A migration 313 tinha exatamente esta: item sem
-- contêiner com mais de 60 segundos de atraso deixava de ser elegível. A 315 a
-- removeu de propósito, com a justificativa de que "backlog causado pela
-- capacidade do Athena nunca é descartado" -- e ela estava certa PARA AQUELE
-- caso: engasgo nosso não deve virar post perdido. Só que a mesma ausência de
-- trava transforma qualquer congelamento longo em enxurrada na retomada.
--
-- A TRAVA VOLTA CONFIGURÁVEL, e é isso que concilia as duas verdades: quem
-- opera decide quanto atraso ainda vale a pena, em vez de o número estar
-- escondido no meio de uma função.
--
-- O QUE O LIMITE MEDE, e a distinção decide se o número faz sentido: ele mede o
-- atraso para COMEÇAR o envio, não para terminar. Medido em janela saudável
-- (05/09, 17h-19h UTC, 2.818 publicações):
--
--   execute_at -> começou a enviar   p50  24s · p90  58s · p99 1228s
--   execute_at -> publicado          p50 275s · p90 770s · p99 1408s
--
-- A diferença entre as duas linhas é a Meta processando o vídeo, e nada aqui
-- controla isso. Com o corte em 300s, um reel decidido no segundo 290 ainda
-- pode aparecer publicado oito minutos depois do horário -- e isso não é atraso
-- do agendador, é o contêiner. Cortar por `published_at` seria medir a régua
-- errada e jogar fora post que saiu na hora certa.
--
-- O PADRÃO É 300s porque p90 do início de envio é 58s: 300 cobre com folga a
-- operação normal e corta a cauda de congestionamento de onda. Em 60s -- o
-- valor original da 313 -- cerca de 10% dos itens de uma onda grande seriam
-- descartados. `null` desliga a trava e restaura o comportamento da 315.
alter table public.publication_rate_limit_settings
  add column if not exists max_publication_lateness_seconds integer default 300
    check (max_publication_lateness_seconds is null
      or max_publication_lateness_seconds between 30 and 86400);

comment on column public.publication_rate_limit_settings.max_publication_lateness_seconds is
  'Atraso máximo, em segundos, para COMEÇAR a enviar uma publicação. Passou disso, ela não é mais reivindicada. Nulo desliga a trava.';

-- Itens já aceitos pelo provedor (`creation_id` preenchido) NUNCA entram nesta
-- conta: eles já foram enviados, e não reconciliá-los criaria post duplicado ou
-- fantasma. A trava é sobre o que ainda não saiu.
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
language plpgsql
security definer
set search_path = public
as $$
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

-- Varredura que encerra o que passou da trava.
--
-- Sem ela, o item apenas deixa de ser reivindicado e fica em `waiting` para
-- sempre: invisível para o despachante e visível para todo o resto como
-- "vencido". Foi um item nessa situação que travou a observabilidade inteira
-- ontem, e a lição está escrita na migration 395 -- trabalho fora de disputa
-- não pode continuar contando como atraso.
create or replace function public.expire_late_publication_items(
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  lateness_seconds integer;
  cutoff timestamptz;
  expired_count integer := 0;
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

  with alvos as (
    select item.id
    from public.publication_items item
    where item.archived_at is null
      and item.status in ('waiting', 'ready')
      and item.creation_id is null
      and item.execute_at is not null
      and item.execute_at < cutoff
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
    returning item.id, item.organization_id, item.status
  ), eventos as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status,
      status, actor_label, error_code, error_message, metadata
    )
    select encerrados.organization_id, encerrados.id, 'ignored', 'waiting', 'ignored',
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
$$;

revoke all on function public.claim_publication_items(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_publication_items(text, integer, integer) to service_role;
revoke all on function public.expire_late_publication_items(integer) from public, anon, authenticated;
grant execute on function public.expire_late_publication_items(integer) to service_role;

notify pgrst, 'reload schema';
