-- FIFO durável por organização. Só existe um OAuth ativo por empresa e turnos
-- aguardando não precisam manter uma reserva de slot.

alter table public.zernio_oauth_turns
  alter column zernio_slot_reservation_id drop not null;

drop index if exists public.zernio_oauth_turns_one_active_profile_idx;

-- Repara eventuais turnos paralelos deixados pelo modelo anterior. Mantém
-- somente o mais antigo ativo; nenhum OAuth possivelmente exibido é reaberto.
with ranked as (
  select id,
         row_number() over (
           partition by organization_id
           order by coalesce(activated_at, created_at), created_at, id
         ) as active_rank
  from public.zernio_oauth_turns
  where status = 'active'
), closed as (
  update public.zernio_oauth_turns turn
  set status = 'expired', lease_expires_at = null,
      finished_at = timezone('utc', now()),
      terminal_reason = 'parallel_active_turn_repaired'
  from ranked
  where turn.id = ranked.id and ranked.active_rank > 1
  returning turn.zernio_slot_reservation_id
)
update public.zernio_connection_slot_reservations reservation
set released_at = timezone('utc', now()),
    release_reason = 'parallel_active_turn_repaired'
where reservation.id in (select zernio_slot_reservation_id from closed)
  and reservation.released_at is null;

create unique index zernio_oauth_turns_one_active_organization_idx
  on public.zernio_oauth_turns(organization_id)
  where status = 'active';

drop index if exists public.zernio_oauth_turns_fifo_idx;
create index zernio_oauth_turns_organization_fifo_idx
  on public.zernio_oauth_turns(organization_id, status, created_at, id);

create or replace function public.maintain_zernio_oauth_turn_queue(
  p_organization_id uuid,
  p_zernio_profile_id text,
  p_lease_seconds integer default 900
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  now_value timestamptz := timezone('utc', now());
  lease_seconds integer := greatest(120, least(coalesce(p_lease_seconds, 900), 1800));
  expired_reservation_ids uuid[];
  expired_intent_ids uuid[];
  expired_attempt_ids uuid[];
  promoted_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  -- profileId permanece na assinatura por compatibilidade; o lock é global na
  -- organização para impedir OAuth simultâneo em conexões diferentes.
  perform pg_advisory_xact_lock(hashtextextended(
    p_organization_id::text || ':zernio-oauth-organization', 0
  ));

  with expired as (
    update public.zernio_oauth_turns turn
    set status = 'expired', lease_expires_at = null, finished_at = now_value,
        terminal_reason = 'active_lease_expired'
    where turn.organization_id = p_organization_id
      and turn.status = 'active'
      and turn.lease_expires_at <= now_value
    returning turn.zernio_slot_reservation_id,
              turn.zernio_connection_intent_id,
              turn.attempt_id
  )
  select array_agg(zernio_slot_reservation_id) filter (where zernio_slot_reservation_id is not null),
         array_agg(zernio_connection_intent_id),
         array_agg(attempt_id) filter (where attempt_id is not null)
  into expired_reservation_ids, expired_intent_ids, expired_attempt_ids
  from expired;

  if coalesce(array_length(expired_reservation_ids, 1), 0) > 0 then
    update public.zernio_connection_slot_reservations
    set released_at = now_value, release_reason = 'oauth_turn_expired'
    where id = any(expired_reservation_ids) and released_at is null;
  end if;
  if coalesce(array_length(expired_intent_ids, 1), 0) > 0 then
    update public.zernio_connection_intents
    set status = 'expired',
        diagnostic = diagnostic || jsonb_build_object('oauthTurnExpiredAt', now_value)
    where id = any(expired_intent_ids)
      and status not in ('synced', 'empty', 'failed', 'expired');
  end if;
  if coalesce(array_length(expired_attempt_ids, 1), 0) > 0 then
    update public.zernio_connection_attempts
    set status = 'failed', failed_at = now_value,
        worker_status = case when worker_status in ('completed', 'conflict', 'failed') then worker_status else 'failed' end,
        worker_completed_at = coalesce(worker_completed_at, now_value),
        last_error_message = 'O turno OAuth expirou antes da conclusão.',
        diagnostic = diagnostic || jsonb_build_object('oauthTurnExpiredAt', now_value)
    where id = any(expired_attempt_ids)
      and status in ('started', 'redirected', 'callback_received');
  end if;

  if not exists (
    select 1 from public.zernio_oauth_turns turn
    where turn.organization_id = p_organization_id and turn.status = 'active'
  ) then
    select turn.id into promoted_id
    from public.zernio_oauth_turns turn
    where turn.organization_id = p_organization_id and turn.status = 'waiting'
    order by turn.created_at, turn.id
    for update skip locked
    limit 1;

    if promoted_id is not null then
      update public.zernio_oauth_turns
      set status = 'active', activated_at = now_value,
          lease_expires_at = now_value + make_interval(secs => lease_seconds)
      where id = promoted_id;
    end if;
  end if;
  return promoted_id;
end;
$$;

create or replace function public.enqueue_zernio_oauth_turn(
  p_organization_id uuid,
  p_zernio_connection_id uuid,
  p_zernio_profile_id text,
  p_intent_id uuid,
  p_reservation_id uuid,
  p_created_by uuid,
  p_lease_seconds integer default 900
)
returns table(turn_id uuid, turn_status text, queue_position integer, lease_expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare existing public.zernio_oauth_turns%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  if not exists (
    select 1 from public.zernio_connections connection
    where connection.id = p_zernio_connection_id
      and connection.organization_id = p_organization_id
      and connection.zernio_profile_id = trim(p_zernio_profile_id)
      and connection.deleted_at is null
  ) then
    raise exception using errcode = '22023', message = 'O profile Zernio não é o profile canônico da conexão.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_organization_id::text || ':zernio-oauth-organization', 0
  ));
  select * into existing from public.zernio_oauth_turns
  where zernio_connection_intent_id = p_intent_id;
  if not found then
    insert into public.zernio_oauth_turns (
      organization_id, zernio_connection_id, zernio_profile_id,
      zernio_connection_intent_id, zernio_slot_reservation_id, created_by, status
    ) values (
      p_organization_id, p_zernio_connection_id, trim(p_zernio_profile_id),
      p_intent_id, p_reservation_id, p_created_by, 'waiting'
    ) returning * into existing;
  elsif existing.organization_id <> p_organization_id
     or existing.created_by <> p_created_by then
    raise exception using errcode = '22023', message = 'O turno existente diverge da intenção solicitada.';
  end if;

  perform public.maintain_zernio_oauth_turn_queue(
    p_organization_id, trim(p_zernio_profile_id), p_lease_seconds
  );
  select * into existing from public.zernio_oauth_turns where id = existing.id;

  turn_id := existing.id;
  turn_status := existing.status;
  lease_expires_at := existing.lease_expires_at;
  if existing.status = 'waiting' then
    select count(*)::integer + 1 into queue_position
    from public.zernio_oauth_turns queued
    where queued.organization_id = existing.organization_id
      and queued.status = 'waiting'
      and (queued.created_at, queued.id) < (existing.created_at, existing.id);
  else queue_position := 0;
  end if;
  return next;
end;
$$;

create or replace function public.get_zernio_oauth_turn_status(
  p_organization_id uuid,
  p_turn_id uuid,
  p_created_by uuid,
  p_lease_seconds integer default 900
)
returns table(turn_status text, queue_position integer, lease_expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare selected public.zernio_oauth_turns%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  select * into selected from public.zernio_oauth_turns
  where id = p_turn_id and organization_id = p_organization_id and created_by = p_created_by;
  if not found then
    raise exception using errcode = 'P0002', message = 'Turno OAuth não encontrado.';
  end if;
  perform public.maintain_zernio_oauth_turn_queue(
    selected.organization_id, selected.zernio_profile_id, p_lease_seconds
  );
  select * into selected from public.zernio_oauth_turns where id = p_turn_id;
  turn_status := selected.status;
  lease_expires_at := selected.lease_expires_at;
  if selected.status = 'waiting' then
    select count(*)::integer + 1 into queue_position
    from public.zernio_oauth_turns queued
    where queued.organization_id = selected.organization_id
      and queued.status = 'waiting'
      and (queued.created_at, queued.id) < (selected.created_at, selected.id);
  else queue_position := 0;
  end if;
  return next;
end;
$$;

create or replace function public.claim_zernio_oauth_turn_preparation(
  p_organization_id uuid,
  p_turn_id uuid,
  p_created_by uuid,
  p_lease_seconds integer default 900
)
returns table(claimed boolean, turn_status text, intent_id uuid, reservation_id uuid, connection_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  selected public.zernio_oauth_turns%rowtype;
  reserved record;
  canonical_profile_id text;
  lease_seconds integer := greatest(120, least(coalesce(p_lease_seconds, 900), 1800));
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  select * into selected from public.zernio_oauth_turns
  where id = p_turn_id and organization_id = p_organization_id and created_by = p_created_by;
  if not found then
    raise exception using errcode = 'P0002', message = 'Turno OAuth não encontrado.';
  end if;
  perform public.maintain_zernio_oauth_turn_queue(
    selected.organization_id, selected.zernio_profile_id, p_lease_seconds
  );
  select * into selected from public.zernio_oauth_turns where id = p_turn_id for update;

  if selected.status = 'active' and selected.preparation_started_at is null then
    if selected.zernio_slot_reservation_id is null then
      select * into reserved
      from public.reserve_zernio_connection_slot(
        selected.organization_id,
        selected.zernio_connection_id,
        selected.created_by,
        lease_seconds
      );

      select connection.zernio_profile_id into canonical_profile_id
      from public.zernio_connections connection
      where connection.id = reserved.zernio_connection_id
        and connection.organization_id = selected.organization_id
        and connection.deleted_at is null;
      if canonical_profile_id is null then
        raise exception using errcode = '22023', message = 'A conexão promovida não possui profile Zernio canônico.';
      end if;

      update public.zernio_connection_slot_reservations
      set zernio_connection_intent_id = selected.zernio_connection_intent_id
      where id = reserved.reservation_id;

      update public.zernio_connection_intents
      set resolved_connection_id = reserved.zernio_connection_id,
          reservation_id = reserved.reservation_id,
          status = 'reserved',
          diagnostic = diagnostic || jsonb_build_object(
            'fallbackUsed', reserved.fallback_used,
            'requestedConnectionId', selected.zernio_connection_id,
            'resolvedConnectionId', reserved.zernio_connection_id,
            'fallbackConnectionLabel', case when reserved.fallback_used then reserved.connection_label else null end,
            'slotReservedAfterQueuePromotionAt', timezone('utc', now())
          )
      where id = selected.zernio_connection_intent_id;

      update public.zernio_oauth_turns
      set zernio_connection_id = reserved.zernio_connection_id,
          zernio_profile_id = canonical_profile_id,
          zernio_slot_reservation_id = reserved.reservation_id
      where id = selected.id;
    end if;

    update public.zernio_oauth_turns turn
    set preparation_started_at = timezone('utc', now()),
        lease_expires_at = timezone('utc', now()) + make_interval(secs => lease_seconds)
    where turn.id = p_turn_id
      and turn.status = 'active'
      and turn.preparation_started_at is null
    returning turn.* into selected;
    claimed := found;
  else claimed := false;
  end if;

  if not claimed then
    select * into selected from public.zernio_oauth_turns where id = p_turn_id;
  end if;
  turn_status := selected.status;
  intent_id := selected.zernio_connection_intent_id;
  reservation_id := selected.zernio_slot_reservation_id;
  connection_id := selected.zernio_connection_id;
  return next;
end;
$$;

create or replace function public.finish_zernio_oauth_turn(
  p_organization_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_created_by uuid,
  p_terminal_status text,
  p_reason text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare selected public.zernio_oauth_turns%rowtype;
declare promoted uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  if p_terminal_status not in ('completed', 'failed') then
    raise exception using errcode = '22023', message = 'Status terminal inválido.';
  end if;
  select * into selected from public.zernio_oauth_turns
  where id = p_turn_id and organization_id = p_organization_id
    and created_by = p_created_by
    and ((p_attempt_id is null and attempt_id is null) or attempt_id = p_attempt_id);
  if not found then return null; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    selected.organization_id::text || ':zernio-oauth-organization', 0
  ));
  update public.zernio_oauth_turns
  set status = p_terminal_status, lease_expires_at = null,
      finished_at = timezone('utc', now()),
      terminal_reason = left(coalesce(p_reason, p_terminal_status), 200)
  where id = p_turn_id and status = 'active';
  if selected.zernio_slot_reservation_id is not null then
    update public.zernio_connection_slot_reservations
    set released_at = timezone('utc', now()),
        release_reason = left(coalesce(p_reason, p_terminal_status), 120)
    where id = selected.zernio_slot_reservation_id and released_at is null;
  end if;
  promoted := public.maintain_zernio_oauth_turn_queue(
    selected.organization_id, selected.zernio_profile_id, 900
  );
  return promoted;
end;
$$;

notify pgrst, 'reload schema';
