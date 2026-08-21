-- Histórico imutável das ações e resultados da fila de publicação.

create type public.publication_item_event_type as enum (
  'queued',
  'processing_started',
  'processing_deferred',
  'published',
  'failed',
  'retry_requested',
  'cancelled'
);

alter table public.publication_batches
  add column created_by_email text;

alter table public.publication_batches
  add constraint publication_batches_created_by_email_length
  check (created_by_email is null or char_length(trim(created_by_email)) between 3 and 320);

alter table public.publication_items
  add column if not exists cancelled_at timestamptz;

create table public.publication_item_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  publication_item_id uuid not null references public.publication_items (id) on delete cascade,
  event_type public.publication_item_event_type not null,
  previous_status public.publication_item_status,
  status public.publication_item_status not null,
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_label text,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  check (char_length(coalesce(error_code, '')) <= 120),
  check (char_length(coalesce(error_message, '')) <= 1200),
  check (jsonb_typeof(metadata) = 'object')
);

create index publication_item_events_item_created_idx
  on public.publication_item_events (publication_item_id, created_at desc);

create index publication_item_events_org_created_idx
  on public.publication_item_events (organization_id, created_at desc);

alter table public.publication_item_events enable row level security;

create policy publication_item_events_select_member
on public.publication_item_events for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.publication_item_events from anon;
grant select on table public.publication_item_events to authenticated;

create or replace function public.log_publication_item_event(
  p_item_id uuid,
  p_event_type public.publication_item_event_type,
  p_previous_status public.publication_item_status,
  p_status public.publication_item_status,
  p_actor_user_id uuid default null,
  p_actor_label text default null,
  p_error_code text default null,
  p_error_message text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item_organization_id uuid;
begin
  if auth.role() = 'authenticated' and not public.is_organization_member((select organization_id from public.publication_items where id = p_item_id)) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if auth.role() = 'authenticated' and p_actor_user_id is distinct from auth.uid() then
    raise exception using errcode = '42501', message = 'Autor do evento inválido.';
  end if;

  select organization_id into item_organization_id
  from public.publication_items
  where id = p_item_id;

  if item_organization_id is null then
    raise exception using errcode = 'P0002', message = 'Item de publicação não encontrado';
  end if;

  insert into public.publication_item_events (
    organization_id, publication_item_id, event_type, previous_status, status,
    actor_user_id, actor_label, error_code, error_message, metadata
  ) values (
    item_organization_id, p_item_id, p_event_type, p_previous_status, p_status,
    p_actor_user_id, nullif(left(trim(coalesce(p_actor_label, '')), 160), ''),
    left(nullif(trim(coalesce(p_error_code, '')), ''), 120),
    left(nullif(trim(coalesce(p_error_message, '')), ''), 1200),
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.log_publication_item_event(uuid, public.publication_item_event_type, public.publication_item_status, public.publication_item_status, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.log_publication_item_event(uuid, public.publication_item_event_type, public.publication_item_status, public.publication_item_status, uuid, text, text, text, jsonb) to authenticated, service_role;

create or replace function public.sync_publication_batch_status(p_batch_id uuid)
returns public.publication_batch_status
language plpgsql
security definer
set search_path = public
as $$
declare
  next_status public.publication_batch_status;
begin
  select case
    when exists (select 1 from public.publication_items where batch_id = p_batch_id and status not in ('published', 'failed', 'ignored', 'cancelled', 'removed')) then 'processing'::public.publication_batch_status
    when exists (select 1 from public.publication_items where batch_id = p_batch_id and status = 'failed') then 'completed_with_errors'::public.publication_batch_status
    when not exists (select 1 from public.publication_items where batch_id = p_batch_id and status <> 'cancelled') then 'cancelled'::public.publication_batch_status
    else 'completed'::public.publication_batch_status
  end into next_status;

  update public.publication_batches set status = next_status where id = p_batch_id;
  return next_status;
end;
$$;

revoke all on function public.sync_publication_batch_status(uuid) from public, anon;
grant execute on function public.sync_publication_batch_status(uuid) to authenticated, service_role;

-- Persiste o e-mail do autor no lote para que a fila não dependa de IDs opacos.
create or replace function public.queue_publication_batch(
  p_organization_id uuid,
  p_name text,
  p_scheduled_for timestamptz,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  batch_row public.publication_batches%rowtype;
  item_json jsonb;
  item_row public.publication_items%rowtype;
  media_id uuid;
  resolved_execute_at timestamptz;
  candidate_day date;
  item_ids jsonb := '[]'::jsonb;
begin
  if not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'Informe itens de publicação.';
  end if;

  insert into public.publication_batches (
    organization_id, created_by, created_by_email, name, scheduled_for, status, review_confirmed_at
  ) values (
    p_organization_id, auth.uid(), nullif(auth.jwt() ->> 'email', ''),
    nullif(left(trim(coalesce(p_name, '')), 160), ''), p_scheduled_for, 'queued', timezone('utc', now())
  ) returning * into batch_row;

  for item_json in select value from jsonb_array_elements(p_items)
  loop
    perform pg_advisory_xact_lock(hashtextextended((item_json ->> 'profileId'), 0));
    resolved_execute_at := nullif(item_json ->> 'executeAt', '')::timestamptz;
    if resolved_execute_at is null and nullif(item_json ->> 'scheduleTime', '') is not null then
      candidate_day := timezone('America/Sao_Paulo', now())::date;
      loop
        resolved_execute_at := (candidate_day + (item_json ->> 'scheduleTime')::time) at time zone 'America/Sao_Paulo';
        exit when resolved_execute_at > timezone('utc', now()) and not exists (
          select 1 from public.publication_items occupied
          where occupied.organization_id = p_organization_id
            and occupied.profile_id = (item_json ->> 'profileId')::uuid
            and occupied.execute_at = resolved_execute_at
            and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
        );
        candidate_day := candidate_day + 1;
      end loop;
    end if;
    if nullif(item_json ->> 'executeAt', '') is not null and exists (
      select 1 from public.publication_items occupied
      where occupied.organization_id = p_organization_id
        and occupied.profile_id = (item_json ->> 'profileId')::uuid
        and occupied.execute_at = (item_json ->> 'executeAt')::timestamptz
        and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
    ) then raise exception using errcode = 'P0001', message = 'slot_conflict'; end if;

    insert into public.publication_items (
      organization_id, batch_id, profile_id, format, status, execute_at, caption, idempotency_key
    ) values (
      p_organization_id, batch_row.id, (item_json ->> 'profileId')::uuid,
      (item_json ->> 'format')::public.publication_format,
      case when resolved_execute_at is null then 'ready'::public.publication_item_status else 'waiting'::public.publication_item_status end,
      resolved_execute_at, nullif(item_json ->> 'caption', ''), item_json ->> 'idempotencyKey'
    ) returning * into item_row;

    for media_id in select value::uuid from jsonb_array_elements_text(item_json -> 'mediaIds')
    loop
      insert into public.publication_item_media (organization_id, publication_item_id, media_asset_id, position)
      values (p_organization_id, item_row.id, media_id, (select count(*) from public.publication_item_media where publication_item_id = item_row.id));
    end loop;
    perform public.log_publication_item_event(item_row.id, 'queued', null, item_row.status, auth.uid(), auth.jwt() ->> 'email', null, null, jsonb_build_object('execute_at', item_row.execute_at));
    item_ids := item_ids || to_jsonb(item_row.id);
  end loop;

  return jsonb_build_object('batch', jsonb_build_object(
    'id', batch_row.id, 'name', batch_row.name, 'status', batch_row.status,
    'scheduled_for', batch_row.scheduled_for, 'timezone', batch_row.timezone,
    'review_confirmed_at', batch_row.review_confirmed_at, 'created_at', batch_row.created_at,
    'updated_at', batch_row.updated_at, 'created_by_email', batch_row.created_by_email
  ), 'itemIds', item_ids);
end;
$$;

-- O resultado do worker é a fonte de verdade para publicação e falha.
create or replace function public.complete_publication_item(
  p_item_id uuid,
  p_worker_id text,
  p_outcome text,
  p_meta_media_id text default null,
  p_error_code text default null,
  p_error_message text default null,
  p_retryable boolean default false,
  p_max_attempts integer default 5
)
returns table (
  id uuid,
  status public.publication_item_status,
  attempt_count integer,
  next_attempt_at timestamptz,
  published_at timestamptz
)
language plpgsql security definer set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  updated_row public.publication_items%rowtype;
  retry_delay_seconds integer;
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_outcome not in ('published', 'failed') then
    raise exception using errcode = '22023', message = 'Resultado de publicação inválido';
  end if;
  if p_max_attempts not between 1 and 20 then
    raise exception using errcode = '22023', message = 'Máximo de tentativas deve estar entre 1 e 20';
  end if;

  select * into item_row from public.publication_items
  where id = p_item_id and claimed_by = trim(p_worker_id)
    and lease_until > timezone('utc', now()) and status in ('preparing', 'publishing')
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker';
  end if;

  if p_outcome = 'published' then
    update public.publication_items set
      status = 'published', meta_media_id = coalesce(nullif(trim(p_meta_media_id), ''), meta_media_id),
      published_at = timezone('utc', now()), claimed_by = null, lease_until = null,
      next_attempt_at = null, last_error_code = null, last_error_message = null
    where id = item_row.id returning * into updated_row;
  elsif p_retryable and item_row.attempt_count < p_max_attempts then
    retry_delay_seconds := (60 * power(2, least(item_row.attempt_count - 1, 6)))::integer + floor(random() * 31)::integer;
    update public.publication_items set
      status = 'failed', claimed_by = null, lease_until = null,
      next_attempt_at = timezone('utc', now()) + make_interval(secs => retry_delay_seconds),
      last_error_code = left(nullif(trim(p_error_code), ''), 120),
      last_error_message = left(nullif(trim(p_error_message), ''), 1200)
    where id = item_row.id returning * into updated_row;
  else
    update public.publication_items set
      status = 'failed', claimed_by = null, lease_until = null, next_attempt_at = null,
      last_error_code = left(nullif(trim(p_error_code), ''), 120),
      last_error_message = left(nullif(trim(p_error_message), ''), 1200)
    where id = item_row.id returning * into updated_row;
  end if;

  perform public.log_publication_item_event(
    updated_row.id,
    case when updated_row.status = 'published' then 'published'::public.publication_item_event_type else 'failed'::public.publication_item_event_type end,
    item_row.status, updated_row.status, null, trim(p_worker_id),
    case when updated_row.status = 'failed' then updated_row.last_error_code else null end,
    case when updated_row.status = 'failed' then updated_row.last_error_message else null end,
    jsonb_build_object('attempt_count', updated_row.attempt_count, 'next_attempt_at', updated_row.next_attempt_at)
  );

  update public.publication_batches batch_row set status = case
    when exists (select 1 from public.publication_items item where item.batch_id = item_row.batch_id and item.status not in ('published', 'failed', 'ignored', 'cancelled', 'removed')) then 'processing'
    when exists (select 1 from public.publication_items item where item.batch_id = item_row.batch_id and item.status = 'failed') then 'completed_with_errors'
    when not exists (select 1 from public.publication_items item where item.batch_id = item_row.batch_id and item.status <> 'cancelled') then 'cancelled'
    else 'completed'
  end where batch_row.id = item_row.batch_id;

  return query select updated_row.id, updated_row.status, updated_row.attempt_count, updated_row.next_attempt_at, updated_row.published_at;
end;
$$;
