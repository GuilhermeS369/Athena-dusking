-- A função da migration 160 retorna uma coluna organization_id. No INSERT com
-- ON CONFLICT (organization_id), PL/pgSQL interpreta o nome como ambíguo entre
-- a coluna de retorno e a coluna da tabela, derrubando o worker antes do claim.

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
       or (candidate.worker_status = 'processing' and candidate.worker_lease_expires_at <= now_value)
    order by candidate.callback_received_at, candidate.created_at, candidate.id
    for update skip locked
    limit 200
  loop
    exit when claimed_count >= claim_limit;
    lock_acquired := false;

    insert into public.zernio_addition_organization_locks as target_lock (
      organization_id, attempt_id, worker_id, lease_expires_at
    ) values (
      selected_attempt.organization_id,
      selected_attempt.id,
      left(p_worker_id, 200),
      now_value + make_interval(secs => lease_seconds)
    )
    on conflict on constraint zernio_addition_organization_locks_pkey do update set
      attempt_id = excluded.attempt_id,
      worker_id = excluded.worker_id,
      lease_expires_at = excluded.lease_expires_at,
      updated_at = now_value
    where target_lock.lease_expires_at <= now_value
       or target_lock.attempt_id = selected_attempt.id
    returning true into lock_acquired;

    if coalesce(lock_acquired, false) then
      update public.zernio_connection_attempts attempt
      set worker_status = 'processing',
          worker_id = left(p_worker_id, 200),
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

revoke all on function public.claim_zernio_connection_additions(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_zernio_connection_additions(text, integer, integer)
  to service_role;

notify pgrst, 'reload schema';
