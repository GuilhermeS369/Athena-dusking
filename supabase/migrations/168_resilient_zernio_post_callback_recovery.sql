-- Recuperação resiliente após callback: a Zernio pode levar alguns minutos
-- para expor a conta recém-autorizada. Enquanto houver incerteza, o profile
-- isolado continua reservado ao attempt e a finalização pode ser retomada sem
-- abrir um novo OAuth nem criar uma segunda conta.

alter table public.zernio_connection_attempts
  drop constraint if exists zernio_connection_attempts_worker_status_check;

alter table public.zernio_connection_attempts
  add constraint zernio_connection_attempts_worker_status_check
  check (worker_status in (
    'not_ready', 'pending', 'processing', 'completed', 'conflict', 'failed',
    'recovery_paused'
  ));

alter table public.zernio_connection_attempts
  add column if not exists recovery_started_at timestamptz,
  add column if not exists recovery_deadline_at timestamptz,
  add column if not exists recovery_next_attempt_at timestamptz,
  add column if not exists recovery_observation_count integer not null default 0
    check (recovery_observation_count >= 0),
  add column if not exists recovery_paused_at timestamptz,
  add column if not exists recovery_last_reason text;

create index if not exists zernio_connection_attempts_recovery_claim_idx
  on public.zernio_connection_attempts(
    worker_status, recovery_next_attempt_at, recovery_deadline_at, callback_received_at
  )
  where worker_status = 'pending';

-- A seleção normal só busca recuperações cujo atraso programado já venceu.
-- Profiles isolados são preservados, portanto nenhum outro celular pode usar
-- o mesmo profile enquanto a conta ainda pode aparecer remotamente.
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
    where (
      candidate.worker_status = 'pending'
      and (candidate.recovery_next_attempt_at is null or candidate.recovery_next_attempt_at <= now_value)
    ) or (
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
      selected_attempt.organization_id, selected_attempt.id, left(p_worker_id, 200),
      now_value + make_interval(secs => lease_seconds)
    )
    on conflict on constraint zernio_addition_organization_locks_pkey do update set
      attempt_id = excluded.attempt_id, worker_id = excluded.worker_id,
      lease_expires_at = excluded.lease_expires_at, updated_at = now_value
    where public.zernio_addition_organization_locks.lease_expires_at <= now_value
       or public.zernio_addition_organization_locks.attempt_id = selected_attempt.id
    returning true into lock_acquired;

    if coalesce(lock_acquired, false) then
      update public.zernio_connection_attempts attempt
      set worker_status = 'processing', worker_id = left(p_worker_id, 200),
          worker_lease_expires_at = now_value + make_interval(secs => lease_seconds),
          worker_attempt_count = attempt.worker_attempt_count + 1
      where attempt.id = selected_attempt.id
      returning attempt.id, attempt.organization_id, attempt.zernio_connection_id,
                attempt.created_by, attempt.worker_attempt_count
      into attempt_id, organization_id, zernio_connection_id, created_by, attempt_count;
      claimed_count := claimed_count + 1;
      return next;
    end if;
  end loop;
end;
$$;

create or replace function public.resume_zernio_post_callback_recovery(
  p_organization_id uuid,
  p_attempt_id uuid,
  p_created_by uuid,
  p_recovery_seconds integer default 1500
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  resumed boolean;
  now_value timestamptz := timezone('utc', now());
  recovery_seconds integer := greatest(300, least(coalesce(p_recovery_seconds, 1500), 7200));
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  update public.zernio_connection_attempts attempt
  set status = 'callback_received', worker_status = 'pending', worker_id = null,
      worker_lease_expires_at = null, worker_completed_at = null, failed_at = null,
      recovery_started_at = coalesce(attempt.recovery_started_at, now_value),
      recovery_deadline_at = now_value + make_interval(secs => recovery_seconds),
      recovery_next_attempt_at = now_value,
      recovery_paused_at = null,
      recovery_last_reason = 'manual_resume_requested',
      last_error_message = null,
      diagnostic = attempt.diagnostic || jsonb_build_object(
        'recoveryManuallyResumedAt', now_value,
        'recoveryDeadlineAt', now_value + make_interval(secs => recovery_seconds)
      )
  where attempt.id = p_attempt_id
    and attempt.organization_id = p_organization_id
    and attempt.created_by = p_created_by
    and attempt.status = 'callback_received'
    and attempt.worker_status = 'recovery_paused'
  returning true into resumed;

  return coalesce(resumed, false);
end;
$$;

revoke all on function public.claim_zernio_connection_additions(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.resume_zernio_post_callback_recovery(uuid, uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_zernio_connection_additions(text, integer, integer)
  to service_role;
grant execute on function public.resume_zernio_post_callback_recovery(uuid, uuid, uuid, integer)
  to service_role;

notify pgrst, 'reload schema';
