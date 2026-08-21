create or replace function public.upsert_publication_worker_heartbeat(
  p_worker_id text,
  p_worker_kind text default 'publication',
  p_status text default 'idle',
  p_dry_run boolean default true,
  p_version text default null,
  p_hostname text default null,
  p_process_id integer default null,
  p_last_error_message text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.publication_worker_heartbeats
language plpgsql
security definer
set search_path = public
as $$
declare
  heartbeat_row public.publication_worker_heartbeats;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode registrar heartbeat de worker.';
  end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if p_worker_kind not in ('publication', 'publication_planner', 'media_deletion', 'media_processing', 'profile_analytics') then
    raise exception using errcode = '22023', message = 'Tipo de worker inválido.';
  end if;
  if p_status not in ('starting', 'observing', 'idle', 'dispatching', 'processing', 'stopping', 'stopped', 'error') then
    raise exception using errcode = '22023', message = 'Status de worker inválido.';
  end if;

  insert into public.publication_worker_heartbeats (
    worker_id, worker_kind, status, dry_run, version, hostname, process_id,
    last_error_message, metadata, started_at, last_seen_at
  ) values (
    trim(p_worker_id), p_worker_kind, p_status, p_dry_run, nullif(trim(coalesce(p_version, '')), ''),
    nullif(trim(coalesce(p_hostname, '')), ''), p_process_id, left(nullif(trim(coalesce(p_last_error_message, '')), ''), 1200),
    coalesce(p_metadata, '{}'::jsonb), timezone('utc', now()), timezone('utc', now())
  )
  on conflict (worker_id) do update
  set
    worker_kind = excluded.worker_kind,
    status = excluded.status,
    dry_run = excluded.dry_run,
    version = excluded.version,
    hostname = excluded.hostname,
    process_id = excluded.process_id,
    last_error_message = excluded.last_error_message,
    metadata = excluded.metadata,
    last_seen_at = timezone('utc', now())
  returning * into heartbeat_row;

  return heartbeat_row;
end;
$$;

revoke all on function public.upsert_publication_worker_heartbeat(text, text, text, boolean, text, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_publication_worker_heartbeat(text, text, text, boolean, text, text, integer, text, jsonb) to service_role;
