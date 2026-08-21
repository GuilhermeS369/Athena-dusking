-- Fila durável por profile canônico Zernio. Reservas continuam representando
-- slots distintos; esta fila serializa apenas o OAuth que reutiliza o mesmo
-- zernio_profile_id.

create table public.zernio_oauth_turns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  zernio_connection_id uuid not null references public.zernio_connections(id) on delete cascade,
  zernio_profile_id text not null check (char_length(trim(zernio_profile_id)) between 1 and 160),
  zernio_connection_intent_id uuid not null unique references public.zernio_connection_intents(id) on delete cascade,
  zernio_slot_reservation_id uuid not null unique references public.zernio_connection_slot_reservations(id) on delete restrict,
  attempt_id uuid unique references public.zernio_connection_attempts(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete restrict,
  status text not null default 'waiting' check (status in ('waiting', 'active', 'completed', 'failed', 'expired')),
  lease_expires_at timestamptz,
  activated_at timestamptz,
  preparation_started_at timestamptz,
  finished_at timestamptz,
  terminal_reason text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check ((status = 'active') = (lease_expires_at is not null and activated_at is not null)),
  check ((status in ('completed', 'failed', 'expired')) = (finished_at is not null))
);

create trigger zernio_oauth_turns_set_updated_at
before update on public.zernio_oauth_turns
for each row execute function public.set_updated_at();

create unique index zernio_oauth_turns_one_active_profile_idx
  on public.zernio_oauth_turns(organization_id, zernio_profile_id)
  where status = 'active';

create index zernio_oauth_turns_fifo_idx
  on public.zernio_oauth_turns(organization_id, zernio_profile_id, status, created_at, id);

alter table public.zernio_oauth_turns enable row level security;
create policy zernio_oauth_turns_select_owner
  on public.zernio_oauth_turns for select to authenticated
  using (
    created_by = (select auth.uid())
    and public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[])
  );

create or replace function public.maintain_zernio_oauth_turn_queue(
  p_organization_id uuid,
  p_zernio_profile_id text,
  p_lease_seconds integer default 900
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  now_value timestamptz := timezone('utc', now());
  normalized_lease_seconds integer := greatest(120, least(coalesce(p_lease_seconds, 900), 1800));
  expired_reservation_ids uuid[];
  expired_intent_ids uuid[];
  expired_attempt_ids uuid[];
  promoted_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_organization_id::text || ':zernio-oauth:' || trim(p_zernio_profile_id), 0
  ));

  -- Uma reserva que tenha sido encerrada por outra rotina não pode conservar
  -- lugar nem ser promovida. O encerramento é local e não toca a Zernio.
  with invalid_waiting as (
    update public.zernio_oauth_turns turn
    set status = 'expired', finished_at = now_value,
        terminal_reason = 'slot_reservation_expired'
    from public.zernio_connection_slot_reservations reservation
    where turn.organization_id = p_organization_id
      and turn.zernio_profile_id = trim(p_zernio_profile_id)
      and turn.status = 'waiting'
      and reservation.id = turn.zernio_slot_reservation_id
      and (reservation.released_at is not null or reservation.expires_at <= now_value)
    returning turn.zernio_connection_intent_id
  )
  update public.zernio_connection_intents intent
  set status = 'expired', diagnostic = intent.diagnostic || jsonb_build_object('oauthWaitingReservationExpiredAt', now_value)
  where intent.id in (select zernio_connection_intent_id from invalid_waiting)
    and intent.status not in ('synced', 'empty', 'failed', 'expired');

  with expired as (
    update public.zernio_oauth_turns turn
    set status = 'expired', lease_expires_at = null, finished_at = now_value,
        terminal_reason = 'active_lease_expired'
    where turn.organization_id = p_organization_id
      and turn.zernio_profile_id = trim(p_zernio_profile_id)
      and turn.status = 'active'
      and turn.lease_expires_at <= now_value
    returning turn.zernio_slot_reservation_id, turn.zernio_connection_intent_id, turn.attempt_id
  )
  select array_agg(zernio_slot_reservation_id), array_agg(zernio_connection_intent_id), array_agg(attempt_id)
  into expired_reservation_ids, expired_intent_ids, expired_attempt_ids
  from expired;

  if coalesce(array_length(expired_reservation_ids, 1), 0) > 0 then
    update public.zernio_connection_slot_reservations
    set released_at = now_value, release_reason = 'oauth_turn_expired'
    where id = any(expired_reservation_ids) and released_at is null;

    update public.zernio_connection_intents
    set status = 'expired', diagnostic = diagnostic || jsonb_build_object('oauthTurnExpiredAt', now_value)
    where id = any(expired_intent_ids)
      and status not in ('synced', 'empty', 'failed', 'expired');

    update public.zernio_connection_attempts
    set status = 'failed', failed_at = now_value,
        last_error_message = 'O turno OAuth expirou antes da conclusão.',
        diagnostic = diagnostic || jsonb_build_object('oauthTurnExpiredAt', now_value)
    where id = any(coalesce(expired_attempt_ids, '{}'::uuid[]))
      and status in ('started', 'redirected', 'callback_received');
  end if;

  if not exists (
    select 1 from public.zernio_oauth_turns turn
    where turn.organization_id = p_organization_id
      and turn.zernio_profile_id = trim(p_zernio_profile_id)
      and turn.status = 'active'
  ) then
    select turn.id into promoted_id
    from public.zernio_oauth_turns turn
    where turn.organization_id = p_organization_id
      and turn.zernio_profile_id = trim(p_zernio_profile_id)
      and turn.status = 'waiting'
    order by turn.created_at, turn.id
    for update skip locked
    limit 1;

    if promoted_id is not null then
      update public.zernio_oauth_turns
      set status = 'active', activated_at = now_value,
          lease_expires_at = now_value + make_interval(secs => normalized_lease_seconds)
      where id = promoted_id;

      update public.zernio_connection_slot_reservations reservation
      set expires_at = now_value + make_interval(secs => normalized_lease_seconds)
      from public.zernio_oauth_turns turn
      where turn.id = promoted_id
        and reservation.id = turn.zernio_slot_reservation_id
        and reservation.released_at is null;
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
declare
  existing public.zernio_oauth_turns%rowtype;
  inserted_turn_id uuid;
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
  if not exists (
    select 1 from public.zernio_connection_slot_reservations reservation
    where reservation.id = p_reservation_id
      and reservation.organization_id = p_organization_id
      and reservation.zernio_connection_id = p_zernio_connection_id
      and reservation.released_at is null
      and reservation.expires_at > timezone('utc', now())
  ) then
    raise exception using errcode = '22023', message = 'A reserva ativa não pertence à conexão do turno.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_organization_id::text || ':zernio-oauth:' || trim(p_zernio_profile_id), 0
  ));

  select * into existing from public.zernio_oauth_turns where zernio_connection_intent_id = p_intent_id;
  if found then
    if existing.organization_id <> p_organization_id
       or existing.zernio_connection_id <> p_zernio_connection_id
       or existing.zernio_profile_id <> trim(p_zernio_profile_id)
       or existing.zernio_slot_reservation_id <> p_reservation_id
       or existing.created_by <> p_created_by then
      raise exception using errcode = '22023', message = 'O turno existente diverge da intenção solicitada.';
    end if;
  else
    insert into public.zernio_oauth_turns (
      organization_id, zernio_connection_id, zernio_profile_id,
      zernio_connection_intent_id, zernio_slot_reservation_id, created_by
    ) values (
      p_organization_id, p_zernio_connection_id, trim(p_zernio_profile_id),
      p_intent_id, p_reservation_id, p_created_by
    ) returning id into inserted_turn_id;
    select * into existing from public.zernio_oauth_turns where id = inserted_turn_id;
  end if;

  inserted_turn_id := existing.id;
  perform public.maintain_zernio_oauth_turn_queue(p_organization_id, trim(p_zernio_profile_id), p_lease_seconds);
  select * into existing from public.zernio_oauth_turns turn where turn.id = inserted_turn_id;

  turn_id := existing.id;
  turn_status := existing.status;
  lease_expires_at := existing.lease_expires_at;
  if existing.status = 'waiting' then
    select count(*)::integer + 1 into queue_position
    from public.zernio_oauth_turns queued
    where queued.organization_id = existing.organization_id
      and queued.zernio_profile_id = existing.zernio_profile_id
      and queued.status = 'waiting'
      and (queued.created_at, queued.id) < (existing.created_at, existing.id);
  else
    queue_position := 0;
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
  if not found then raise exception using errcode = 'P0002', message = 'Turno OAuth não encontrado.'; end if;
  perform public.maintain_zernio_oauth_turn_queue(selected.organization_id, selected.zernio_profile_id, p_lease_seconds);
  select * into selected from public.zernio_oauth_turns where id = p_turn_id;
  turn_status := selected.status;
  lease_expires_at := selected.lease_expires_at;
  if selected.status = 'waiting' then
    select count(*)::integer + 1 into queue_position
    from public.zernio_oauth_turns queued
    where queued.organization_id = selected.organization_id
      and queued.zernio_profile_id = selected.zernio_profile_id
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
declare selected public.zernio_oauth_turns%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  select * into selected from public.zernio_oauth_turns
  where id = p_turn_id and organization_id = p_organization_id and created_by = p_created_by;
  if not found then raise exception using errcode = 'P0002', message = 'Turno OAuth não encontrado.'; end if;
  perform public.maintain_zernio_oauth_turn_queue(selected.organization_id, selected.zernio_profile_id, p_lease_seconds);

  update public.zernio_oauth_turns turn
  set preparation_started_at = timezone('utc', now()),
      lease_expires_at = timezone('utc', now()) + make_interval(secs => greatest(120, least(coalesce(p_lease_seconds, 900), 1800)))
  where turn.id = p_turn_id and turn.status = 'active' and turn.preparation_started_at is null
  returning turn.* into selected;

  claimed := found;
  if not claimed then select * into selected from public.zernio_oauth_turns where id = p_turn_id; end if;
  turn_status := selected.status;
  intent_id := selected.zernio_connection_intent_id;
  reservation_id := selected.zernio_slot_reservation_id;
  connection_id := selected.zernio_connection_id;
  return next;
end;
$$;

create or replace function public.attach_zernio_oauth_turn_attempt(
  p_organization_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid
)
returns boolean language plpgsql security definer set search_path = public as $$
declare attached boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  update public.zernio_oauth_turns
  set attempt_id = p_attempt_id
  where id = p_turn_id and organization_id = p_organization_id
    and status = 'active' and preparation_started_at is not null
    and (attempt_id is null or attempt_id = p_attempt_id)
  returning true into attached;
  return coalesce(attached, false);
end;
$$;

create or replace function public.validate_zernio_oauth_turn(
  p_organization_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_created_by uuid,
  p_lease_seconds integer default 900
)
returns boolean language plpgsql security definer set search_path = public as $$
declare selected public.zernio_oauth_turns%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  select * into selected from public.zernio_oauth_turns
  where id = p_turn_id and organization_id = p_organization_id and created_by = p_created_by;
  if not found then return false; end if;
  perform public.maintain_zernio_oauth_turn_queue(selected.organization_id, selected.zernio_profile_id, p_lease_seconds);
  update public.zernio_oauth_turns
  set lease_expires_at = timezone('utc', now()) + make_interval(secs => greatest(120, least(coalesce(p_lease_seconds, 900), 1800)))
  where id = p_turn_id and status = 'active' and attempt_id = p_attempt_id;
  return found;
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
  where id = p_turn_id
    and organization_id = p_organization_id
    and created_by = p_created_by
    and (
      (p_attempt_id is null and attempt_id is null)
      or attempt_id = p_attempt_id
    );
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    selected.organization_id::text || ':zernio-oauth:' || selected.zernio_profile_id, 0
  ));
  update public.zernio_oauth_turns
  set status = p_terminal_status, lease_expires_at = null,
      finished_at = timezone('utc', now()), terminal_reason = left(coalesce(p_reason, p_terminal_status), 200)
  where id = p_turn_id and status = 'active';
  update public.zernio_connection_slot_reservations
  set released_at = timezone('utc', now()), release_reason = left(coalesce(p_reason, p_terminal_status), 120)
  where id = selected.zernio_slot_reservation_id and released_at is null;
  promoted := public.maintain_zernio_oauth_turn_queue(selected.organization_id, selected.zernio_profile_id, 900);
  return promoted;
end;
$$;

revoke all on public.zernio_oauth_turns from public, anon, authenticated;
grant select on public.zernio_oauth_turns to authenticated;
grant all on public.zernio_oauth_turns to service_role;
revoke all on function public.maintain_zernio_oauth_turn_queue(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.enqueue_zernio_oauth_turn(uuid, uuid, text, uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.get_zernio_oauth_turn_status(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.claim_zernio_oauth_turn_preparation(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.attach_zernio_oauth_turn_attempt(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.validate_zernio_oauth_turn(uuid, uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.finish_zernio_oauth_turn(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.maintain_zernio_oauth_turn_queue(uuid, text, integer) to service_role;
grant execute on function public.enqueue_zernio_oauth_turn(uuid, uuid, text, uuid, uuid, uuid, integer) to service_role;
grant execute on function public.get_zernio_oauth_turn_status(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.claim_zernio_oauth_turn_preparation(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.attach_zernio_oauth_turn_attempt(uuid, uuid, uuid) to service_role;
grant execute on function public.validate_zernio_oauth_turn(uuid, uuid, uuid, uuid, integer) to service_role;
grant execute on function public.finish_zernio_oauth_turn(uuid, uuid, uuid, uuid, text, text) to service_role;

notify pgrst, 'reload schema';
