-- A adição de contas passa a ser concluída de forma assíncrona pela VPS.
-- Reservas continuam limitando a capacidade de cada chave; turnos OAuth não
-- serializam mais celulares que já possuem slots distintos reservados.

drop index if exists public.zernio_oauth_turns_one_active_profile_idx;

-- Turnos antigos que estavam apenas esperando são promovidos: cada um já tem
-- uma reserva de slot própria e não deve depender de uma tela de espera.
update public.zernio_oauth_turns turn
set status = 'active', activated_at = coalesce(activated_at, timezone('utc', now())),
    lease_expires_at = timezone('utc', now()) + interval '30 minutes'
from public.zernio_connection_slot_reservations reservation
where turn.status = 'waiting'
  and reservation.id = turn.zernio_slot_reservation_id
  and reservation.released_at is null
  and reservation.expires_at > timezone('utc', now());

alter table public.zernio_connection_attempts
  add column if not exists worker_status text not null default 'not_ready'
    check (worker_status in ('not_ready', 'pending', 'processing', 'completed', 'conflict', 'failed')),
  add column if not exists worker_id text,
  add column if not exists worker_lease_expires_at timestamptz,
  add column if not exists worker_attempt_count integer not null default 0 check (worker_attempt_count >= 0),
  add column if not exists worker_error_code text,
  add column if not exists worker_error_stage text,
  add column if not exists worker_completed_at timestamptz,
  add column if not exists correlation_id uuid not null default gen_random_uuid();

create index if not exists zernio_connection_attempts_worker_claim_idx
  on public.zernio_connection_attempts(worker_status, worker_lease_expires_at, callback_received_at, created_at)
  where worker_status in ('pending', 'processing');

create index if not exists zernio_connection_attempts_org_history_idx
  on public.zernio_connection_attempts(organization_id, created_at desc);

update public.zernio_connection_attempts
set worker_status = case
  when status = 'callback_received' then 'pending'
  when status in ('synced', 'empty') then 'completed'
  when status = 'failed' then 'failed'
  else 'not_ready'
end;

-- Uma intenção aberta não depende da chave aleatória criada pelo navegador.
-- O lock evita que refresh/duplo clique crie uma segunda reserva para o mesmo
-- usuário e destino enquanto a primeira solicitação ainda está viva.
create or replace function public.claim_zernio_connection_intent(
  p_organization_id uuid,
  p_created_by uuid,
  p_idempotency_key text,
  p_requested_connection_id uuid,
  p_requested_group_id uuid default null
)
returns table(intent_id uuid, intent_status text, reused boolean)
language plpgsql security definer set search_path = public as $$
declare existing public.zernio_connection_intents%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  if char_length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 160 then
    raise exception using errcode = '22023', message = 'Chave de idempotência inválida.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_organization_id::text || ':zernio-add:' || p_created_by::text || ':' || p_requested_connection_id::text, 0
  ));

  select * into existing
  from public.zernio_connection_intents intent
  where intent.organization_id = p_organization_id
    and intent.created_by = p_created_by
    and intent.requested_connection_id = p_requested_connection_id
    and intent.requested_group_id is not distinct from p_requested_group_id
    and intent.status in ('started', 'reserved', 'redirected', 'callback_received')
    and intent.expires_at > timezone('utc', now())
  order by intent.created_at desc
  limit 1
  for update;

  if found then
    intent_id := existing.id;
    intent_status := existing.status;
    reused := true;
    return next;
    return;
  end if;

  insert into public.zernio_connection_intents (
    organization_id, created_by, idempotency_key, requested_connection_id, requested_group_id
  ) values (
    p_organization_id, p_created_by, trim(p_idempotency_key), p_requested_connection_id, p_requested_group_id
  ) returning id, status into intent_id, intent_status;
  reused := false;
  return next;
end;
$$;

-- Todo turno com slot reservado fica ativo imediatamente. A capacidade real é
-- protegida pela reserva atômica; não existe mais página de espera no celular.
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
declare normalized_lease_seconds integer := greatest(120, least(coalesce(p_lease_seconds, 900), 1800));
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':zernio-intent:' || p_intent_id::text, 0));

  select * into existing from public.zernio_oauth_turns where zernio_connection_intent_id = p_intent_id;
  if not found then
    insert into public.zernio_oauth_turns (
      organization_id, zernio_connection_id, zernio_profile_id,
      zernio_connection_intent_id, zernio_slot_reservation_id, created_by,
      status, activated_at, lease_expires_at
    ) values (
      p_organization_id, p_zernio_connection_id, trim(p_zernio_profile_id),
      p_intent_id, p_reservation_id, p_created_by,
      'active', timezone('utc', now()), timezone('utc', now()) + make_interval(secs => normalized_lease_seconds)
    ) returning * into existing;
  end if;

  turn_id := existing.id;
  turn_status := existing.status;
  queue_position := 0;
  lease_expires_at := existing.lease_expires_at;
  return next;
end;
$$;

create or replace function public.claim_zernio_connection_additions(
  p_worker_id text,
  p_limit integer default 5,
  p_lease_seconds integer default 180
)
returns table(attempt_id uuid, organization_id uuid, zernio_connection_id uuid, created_by uuid, attempt_count integer)
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  return query
  with candidates as (
    select attempt.id
    from public.zernio_connection_attempts attempt
    where attempt.worker_status = 'pending'
       or (attempt.worker_status = 'processing' and attempt.worker_lease_expires_at <= timezone('utc', now()))
    order by attempt.callback_received_at, attempt.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 5), 20))
  ), claimed as (
    update public.zernio_connection_attempts attempt
    set worker_status = 'processing', worker_id = left(p_worker_id, 200),
        worker_lease_expires_at = timezone('utc', now()) + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 180), 900))),
        worker_attempt_count = attempt.worker_attempt_count + 1
    from candidates where attempt.id = candidates.id
    returning attempt.*
  )
  select claimed.id, claimed.organization_id, claimed.zernio_connection_id,
         claimed.created_by, claimed.worker_attempt_count
  from claimed;
end;
$$;

revoke all on function public.claim_zernio_connection_additions(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_zernio_connection_additions(text, integer, integer) to service_role;

notify pgrst, 'reload schema';
