-- O OAuth volta a ser paralelo. A exclusão por organização existe somente na
-- finalização pós-callback, com lease recuperável e um accountId por attempt.

drop index if exists public.zernio_oauth_turns_one_active_organization_idx;

-- Turnos que nunca chegaram ao Instagram pertencem ao modelo antigo. Eles são
-- encerrados para não manter intents e reservas órfãs depois do deploy.
with abandoned as (
  update public.zernio_oauth_turns turn
  set status = 'expired', lease_expires_at = null,
      finished_at = timezone('utc', now()),
      terminal_reason = 'pre_oauth_queue_removed'
  where turn.status = 'waiting'
  returning turn.zernio_connection_intent_id,
            turn.zernio_slot_reservation_id
)
update public.zernio_connection_intents intent
set status = 'expired',
    diagnostic = intent.diagnostic || jsonb_build_object(
      'expiredReason', 'pre_oauth_queue_removed',
      'expiredAt', timezone('utc', now())
    )
where intent.id in (select zernio_connection_intent_id from abandoned)
  and intent.status not in ('synced', 'empty', 'failed', 'expired');

update public.zernio_connection_slot_reservations reservation
set released_at = timezone('utc', now()),
    release_reason = 'pre_oauth_queue_removed'
where reservation.id in (
  select turn.zernio_slot_reservation_id
  from public.zernio_oauth_turns turn
  where turn.terminal_reason = 'pre_oauth_queue_removed'
)
and reservation.released_at is null;

create table if not exists public.zernio_addition_organization_locks (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  attempt_id uuid not null unique references public.zernio_connection_attempts(id) on delete cascade,
  worker_id text not null,
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.zernio_addition_account_claims (
  attempt_id uuid primary key references public.zernio_connection_attempts(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  zernio_connection_id uuid not null references public.zernio_connections(id) on delete cascade,
  zernio_profile_id text not null,
  zernio_account_id text not null unique,
  source text not null check (source in ('callback', 'fifo_fallback')),
  created_at timestamptz not null default timezone('utc', now()),
  check (char_length(trim(zernio_profile_id)) between 1 and 160),
  check (char_length(trim(zernio_account_id)) between 1 and 200)
);

create index if not exists zernio_addition_account_claims_connection_idx
  on public.zernio_addition_account_claims(organization_id, zernio_connection_id, created_at);

alter table public.zernio_addition_organization_locks enable row level security;
alter table public.zernio_addition_account_claims enable row level security;
revoke all on public.zernio_addition_organization_locks from public, anon, authenticated;
revoke all on public.zernio_addition_account_claims from public, anon, authenticated;
grant all on public.zernio_addition_organization_locks to service_role;
grant all on public.zernio_addition_account_claims to service_role;

create or replace function public.claim_zernio_connection_additions(
  p_worker_id text,
  p_limit integer default 5,
  p_lease_seconds integer default 180
)
returns table(attempt_id uuid, organization_id uuid, zernio_connection_id uuid, created_by uuid, attempt_count integer)
language plpgsql security definer set search_path = public as $$
declare
  selected_attempt public.zernio_connection_attempts%rowtype;
  lock_acquired boolean;
  claimed_count integer := 0;
  claim_limit integer := greatest(1, least(coalesce(p_limit, 5), 20));
  lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 180), 900));
  now_value timestamptz := timezone('utc', now());
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  delete from public.zernio_addition_organization_locks lock_row
  where lock_row.lease_expires_at <= now_value;

  for selected_attempt in
    select candidate.*
    from public.zernio_connection_attempts candidate
    where candidate.worker_status = 'pending'
       or (
         candidate.worker_status = 'processing'
         and candidate.worker_lease_expires_at <= now_value
       )
    order by candidate.callback_received_at, candidate.created_at, candidate.id
    for update skip locked
    limit 200
  loop
    exit when claimed_count >= claim_limit;
    lock_acquired := false;

    insert into public.zernio_addition_organization_locks (
      organization_id, attempt_id, worker_id, lease_expires_at
    ) values (
      selected_attempt.organization_id,
      selected_attempt.id,
      left(p_worker_id, 200),
      now_value + make_interval(secs => lease_seconds)
    )
    on conflict (organization_id) do update set
      attempt_id = excluded.attempt_id,
      worker_id = excluded.worker_id,
      lease_expires_at = excluded.lease_expires_at,
      updated_at = now_value
    where public.zernio_addition_organization_locks.lease_expires_at <= now_value
       or public.zernio_addition_organization_locks.attempt_id = selected_attempt.id
    returning true into lock_acquired;

    if coalesce(lock_acquired, false) then
      update public.zernio_connection_attempts attempt
      set worker_status = 'processing',
          worker_id = left(p_worker_id, 200),
          worker_lease_expires_at = now_value + make_interval(secs => lease_seconds),
          worker_attempt_count = attempt.worker_attempt_count + 1
      where attempt.id = selected_attempt.id
      returning attempt.id, attempt.organization_id,
                attempt.zernio_connection_id, attempt.created_by,
                attempt.worker_attempt_count
      into attempt_id, organization_id, zernio_connection_id,
           created_by, attempt_count;
      claimed_count := claimed_count + 1;
      return next;
    end if;
  end loop;
end;
$$;

create or replace function public.release_zernio_addition_organization_lock(
  p_attempt_id uuid,
  p_worker_id text
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare released boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  delete from public.zernio_addition_organization_locks lock_row
  where lock_row.attempt_id = p_attempt_id
    and lock_row.worker_id = left(p_worker_id, 200)
  returning true into released;
  return coalesce(released, false);
end;
$$;

create or replace function public.claim_zernio_addition_account(
  p_attempt_id uuid,
  p_worker_id text,
  p_zernio_account_id text,
  p_source text
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare selected public.zernio_connection_attempts%rowtype;
declare claimed boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  if p_source not in ('callback', 'fifo_fallback')
     or nullif(trim(p_zernio_account_id), '') is null then
    raise exception using errcode = '22023', message = 'Claim de conta Zernio inválido.';
  end if;

  select attempt.* into selected
  from public.zernio_connection_attempts attempt
  join public.zernio_addition_organization_locks lock_row
    on lock_row.attempt_id = attempt.id
   and lock_row.worker_id = left(p_worker_id, 200)
   and lock_row.lease_expires_at > timezone('utc', now())
  where attempt.id = p_attempt_id
    and attempt.worker_status = 'processing'
  for update of attempt;
  if not found then return false; end if;

  insert into public.zernio_addition_account_claims (
    attempt_id, organization_id, zernio_connection_id,
    zernio_profile_id, zernio_account_id, source
  ) values (
    selected.id, selected.organization_id, selected.zernio_connection_id,
    selected.zernio_profile_id, trim(p_zernio_account_id), p_source
  )
  on conflict do nothing
  returning true into claimed;

  if claimed then return true; end if;
  return exists (
    select 1 from public.zernio_addition_account_claims account_claim
    where account_claim.attempt_id = selected.id
      and account_claim.zernio_account_id = trim(p_zernio_account_id)
  );
end;
$$;

-- A reserva acontece no worker, depois do callback, e somente na conexão na
-- qual o OAuth já foi autorizado. Não há fallback silencioso entre API keys.
create or replace function public.reserve_zernio_addition_finalization_slot(
  p_attempt_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns table(reservation_id uuid, zernio_connection_id uuid, connection_label text)
language plpgsql security definer set search_path = public as $$
declare selected public.zernio_connection_attempts%rowtype;
declare existing public.zernio_connection_slot_reservations%rowtype;
declare final_reservation_id uuid;
declare selected_label text;
declare selected_limit integer;
declare occupied integer;
declare lease_seconds integer := greatest(120, least(coalesce(p_lease_seconds, 900), 1800));
declare now_value timestamptz := timezone('utc', now());
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  select attempt.* into selected
  from public.zernio_connection_attempts attempt
  join public.zernio_addition_organization_locks lock_row
    on lock_row.attempt_id = attempt.id
   and lock_row.worker_id = left(p_worker_id, 200)
   and lock_row.lease_expires_at > now_value
  where attempt.id = p_attempt_id
    and attempt.worker_status = 'processing'
  for update of attempt;
  if not found then
    raise exception using errcode = 'P0002', message = 'Attempt final não está sob lease deste worker.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(selected.organization_id::text || ':zernio-slot', 0));

  if selected.zernio_slot_reservation_id is not null then
    select * into existing from public.zernio_connection_slot_reservations reservation
    where reservation.id = selected.zernio_slot_reservation_id;
    if found and existing.released_at is null and existing.expires_at > now_value then
      final_reservation_id := existing.id;
      reservation_id := final_reservation_id;
      zernio_connection_id := existing.zernio_connection_id;
      select label into connection_label from public.zernio_connections where id = existing.zernio_connection_id;
      return next;
      return;
    end if;
  end if;

  select connection.label, connection.instagram_slot_limit
  into selected_label, selected_limit
  from public.zernio_connections connection
  where connection.id = selected.zernio_connection_id
    and connection.organization_id = selected.organization_id
    and connection.deleted_at is null
    and connection.status in ('online', 'no_data');
  if not found then
    raise exception using errcode = 'P0002', message = 'Conexão Zernio ativa da autorização não encontrada.';
  end if;

  select
    (select count(*) from public.instagram_profiles profile
     where profile.organization_id = selected.organization_id
       and profile.provider = 'zernio'
       and profile.zernio_connection_id = selected.zernio_connection_id
       and profile.deleted_at is null)
    +
    (select count(*) from public.zernio_connection_slot_reservations reservation
     where reservation.organization_id = selected.organization_id
       and reservation.zernio_connection_id = selected.zernio_connection_id
       and reservation.released_at is null
       and reservation.expires_at > now_value)
  into occupied;

  if occupied >= selected_limit then
    raise exception using errcode = 'P0001', message = 'A chave Zernio autorizada não possui slot livre para a confirmação final.';
  end if;

  select * into existing
  from public.zernio_connection_slot_reservations reservation
  where reservation.zernio_connection_intent_id = selected.zernio_connection_intent_id
  for update;

  if found then
    update public.zernio_connection_slot_reservations reservation
    set organization_id = selected.organization_id,
        zernio_connection_id = selected.zernio_connection_id,
        reserved_by = selected.created_by,
        requested_connection_id = selected.zernio_connection_id,
        expires_at = now_value + make_interval(secs => lease_seconds),
        released_at = null,
        release_reason = null
    where reservation.id = existing.id
    returning reservation.id into final_reservation_id;
  else
    insert into public.zernio_connection_slot_reservations (
      organization_id, zernio_connection_id, reserved_by,
      requested_connection_id, zernio_connection_intent_id, expires_at
    ) values (
      selected.organization_id, selected.zernio_connection_id, selected.created_by,
      selected.zernio_connection_id, selected.zernio_connection_intent_id,
      now_value + make_interval(secs => lease_seconds)
    ) returning id into final_reservation_id;
  end if;

  update public.zernio_connection_attempts
  set zernio_slot_reservation_id = final_reservation_id
  where id = selected.id;
  update public.zernio_connection_intents
  set reservation_id = final_reservation_id,
      resolved_connection_id = selected.zernio_connection_id
  where id = selected.zernio_connection_intent_id;

  reservation_id := final_reservation_id;
  zernio_connection_id := selected.zernio_connection_id;
  connection_label := selected_label;
  return next;
end;
$$;

create or replace function public.get_zernio_connection_addition_queue_position(
  p_organization_id uuid,
  p_attempt_id uuid,
  p_created_by uuid
)
returns integer
language plpgsql security definer set search_path = public as $$
declare selected public.zernio_connection_attempts%rowtype;
declare queue_position integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  select * into selected from public.zernio_connection_attempts attempt
  where attempt.id = p_attempt_id
    and attempt.organization_id = p_organization_id
    and attempt.created_by = p_created_by;
  if not found or selected.worker_status <> 'pending' then return 0; end if;

  select count(*)::integer + 1 into queue_position
  from public.zernio_connection_attempts queued
  where queued.organization_id = selected.organization_id
    and queued.worker_status in ('pending', 'processing')
    and (
      queued.worker_status = 'processing'
      or (queued.callback_received_at, queued.created_at, queued.id)
         < (selected.callback_received_at, selected.created_at, selected.id)
    );
  return queue_position;
end;
$$;

revoke all on function public.claim_zernio_connection_additions(text, integer, integer) from public, anon, authenticated;
revoke all on function public.release_zernio_addition_organization_lock(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_zernio_addition_account(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.reserve_zernio_addition_finalization_slot(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.get_zernio_connection_addition_queue_position(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_zernio_connection_additions(text, integer, integer) to service_role;
grant execute on function public.release_zernio_addition_organization_lock(uuid, text) to service_role;
grant execute on function public.claim_zernio_addition_account(uuid, text, text, text) to service_role;
grant execute on function public.reserve_zernio_addition_finalization_slot(uuid, text, integer) to service_role;
grant execute on function public.get_zernio_connection_addition_queue_position(uuid, uuid, uuid) to service_role;

notify pgrst, 'reload schema';
