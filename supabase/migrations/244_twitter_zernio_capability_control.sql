-- Controle auditado das capabilities X da Zernio pelo Athena.
-- Inbox permanece proibido. Analytics continua opt-in e protegido pelas flags da aplicação.

alter table public.twitter_connections
  drop constraint if exists twitter_connections_analytics_enabled_check;

alter table public.twitter_connection_events
  add column if not exists idempotency_key text;

create unique index if not exists twitter_connection_events_capability_idempotency_idx
  on public.twitter_connection_events (organization_id, idempotency_key)
  where idempotency_key is not null;

alter table public.twitter_connection_events
  drop constraint if exists twitter_connection_events_event_type_check;
alter table public.twitter_connection_events
  add constraint twitter_connection_events_event_type_check check (event_type in (
    'credential_created', 'credential_rotated', 'oauth_started', 'oauth_completed',
    'sync_enqueued', 'sync_completed', 'sync_failed', 'profile_connected',
    'profile_reauthenticated', 'profile_epoch_changed', 'connection_deleted',
    'capabilities_changed'
  ));

create or replace function public.twitter_set_connection_capabilities(
  p_organization_id uuid,
  p_connection_id uuid,
  p_analytics_enabled boolean,
  p_inbox_enabled boolean,
  p_actor_user_id uuid,
  p_actor_email text,
  p_justification text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  connection_row public.twitter_connections;
  event_row public.twitter_connection_events;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode alterar capabilities X.';
  end if;
  if coalesce(p_inbox_enabled, false) then
    raise exception using errcode = '22023', message = 'Inbox X permanece desabilitado no Athena.';
  end if;
  if char_length(trim(coalesce(p_justification, ''))) not between 8 and 1000 then
    raise exception using errcode = '22023', message = 'Justificativa deve ter entre 8 e 1000 caracteres.';
  end if;
  if char_length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 255 then
    raise exception using errcode = '22023', message = 'Idempotency key inválida.';
  end if;

  select * into event_row
  from public.twitter_connection_events
  where organization_id = p_organization_id
    and idempotency_key = trim(p_idempotency_key);
  if found then
    if event_row.connection_id <> p_connection_id or event_row.event_type <> 'capabilities_changed' then
      raise exception using errcode = '23505', message = 'Idempotency key já utilizada em outra operação.';
    end if;
    select * into connection_row from public.twitter_connections where id = p_connection_id;
    return jsonb_build_object(
      'connectionId', connection_row.id,
      'analyticsEnabled', connection_row.analytics_enabled,
      'inboxEnabled', connection_row.inbox_enabled,
      'idempotentReplay', true
    );
  end if;

  select * into connection_row
  from public.twitter_connections
  where id = p_connection_id
    and organization_id = p_organization_id
    and status <> 'deleted'
    and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Conexão X ativa não encontrada.';
  end if;

  update public.twitter_connections
  set analytics_enabled = coalesce(p_analytics_enabled, false),
      inbox_enabled = false
  where id = connection_row.id
  returning * into connection_row;

  insert into public.twitter_connection_events (
    organization_id, connection_id, event_type, actor_user_id, actor_email,
    message, metadata, idempotency_key
  ) values (
    p_organization_id, p_connection_id, 'capabilities_changed', p_actor_user_id,
    nullif(trim(coalesce(p_actor_email, '')), ''),
    case when connection_row.analytics_enabled
      then 'Analytics sync da Zernio habilitado pelo Athena; Inbox permanece desligado.'
      else 'Analytics sync e Inbox da Zernio desabilitados pelo Athena.' end,
    jsonb_build_object(
      'analyticsEnabled', connection_row.analytics_enabled,
      'inboxEnabled', false,
      'justification', trim(p_justification)
    ),
    trim(p_idempotency_key)
  );

  return jsonb_build_object(
    'connectionId', connection_row.id,
    'analyticsEnabled', connection_row.analytics_enabled,
    'inboxEnabled', connection_row.inbox_enabled,
    'idempotentReplay', false
  );
end;
$$;

revoke all on function public.twitter_set_connection_capabilities(uuid, uuid, boolean, boolean, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.twitter_set_connection_capabilities(uuid, uuid, boolean, boolean, uuid, text, text, text)
  to service_role;

drop function if exists public.twitter_claim_sync_jobs(text, integer, integer);
create function public.twitter_claim_sync_jobs(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 300
)
returns table (
  job_id uuid,
  organization_id uuid,
  connection_id uuid,
  zernio_profile_id text,
  encrypted_api_key text,
  analytics_enabled boolean,
  claim_token uuid,
  attempt_count integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode executar claim de sync X.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 255 then
    raise exception using errcode = '22023', message = 'Worker ID inválido.';
  end if;

  return query
  with candidates as (
    select job.id
    from public.twitter_sync_jobs job
    join public.twitter_connections connection on connection.id = job.connection_id
    where (job.status = 'pending' or (job.status = 'processing' and job.lease_until < timezone('utc', now())))
      and connection.status <> 'deleted'
      and connection.deleted_at is null
    order by job.created_at, job.id
    for update of job skip locked
    limit least(greatest(coalesce(p_limit, 1), 1), 10)
  ), claimed as (
    update public.twitter_sync_jobs job
    set status = 'processing', claimed_by = trim(p_worker_id), claim_token = gen_random_uuid(),
        claimed_at = timezone('utc', now()),
        lease_until = timezone('utc', now()) + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 60), 900)),
        started_at = coalesce(job.started_at, timezone('utc', now())),
        attempt_count = job.attempt_count + 1, error_code = null, error_message = null
    from candidates where job.id = candidates.id returning job.*
  )
  select claimed.id, claimed.organization_id, claimed.connection_id,
         connection.zernio_profile_id, secret.encrypted_api_key,
         connection.analytics_enabled, claimed.claim_token, claimed.attempt_count
  from claimed
  join public.twitter_connections connection on connection.id = claimed.connection_id
  join public.twitter_connection_secrets secret on secret.connection_id = claimed.connection_id;
end;
$$;

revoke all on function public.twitter_claim_sync_jobs(text, integer, integer) from public, anon, authenticated;
grant execute on function public.twitter_claim_sync_jobs(text, integer, integer) to service_role;
