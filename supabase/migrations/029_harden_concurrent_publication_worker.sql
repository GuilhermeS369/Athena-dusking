-- Worker concorrente: esta migration é estritamente aditiva para a fila já existente.
-- Ela não altera status, contêineres, resultados nem horários de itens históricos.

alter table public.publication_items
  add column if not exists container_poll_count integer not null default 0
  check (container_poll_count >= 0);

create table if not exists public.publication_profile_daily_reservations (
  publication_item_id uuid primary key references public.publication_items (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  reserved_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  check (expires_at > reserved_at)
);

create index if not exists publication_profile_daily_reservations_active_idx
  on public.publication_profile_daily_reservations (profile_id, expires_at);

create index if not exists publication_items_profile_published_at_idx
  on public.publication_items (profile_id, published_at)
  where status = 'published' and published_at is not null;

alter table public.publication_profile_daily_reservations enable row level security;
revoke all on table public.publication_profile_daily_reservations from public, anon, authenticated;

-- Usadas somente pelo fallback excepcional após a Meta confirmar publicação e
-- a transação principal não estar disponível. Não tocam no item nem no status.
create or replace function public.mark_publication_item_media_as_published(
  p_item_id uuid,
  p_organization_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.media_assets as asset
  set first_published_at = coalesce(asset.first_published_at, timezone('utc', now()))
  from public.publication_item_media as item_media
  where item_media.publication_item_id = p_item_id
    and item_media.media_asset_id = asset.id
    and asset.organization_id = p_organization_id;
$$;

create or replace function public.sync_publication_batch_status_for_item(p_item_id uuid)
returns public.publication_batch_status
language plpgsql
security definer
set search_path = public
as $$
declare
  item_batch_id uuid;
begin
  select batch_id into item_batch_id from public.publication_items where id = p_item_id;
  if item_batch_id is null then
    raise exception using errcode = 'P0002', message = 'Item de publicação não encontrado';
  end if;
  return public.sync_publication_batch_status(item_batch_id);
end;
$$;

-- Claims expirados podem ser retomados, mas consultar um contêiner não consome
-- tentativas de criação/publicação. Isso evita prender Reels em IN_PROGRESS.
create or replace function public.claim_publication_items(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  id uuid,
  organization_id uuid,
  batch_id uuid,
  profile_id uuid,
  format public.publication_format,
  status public.publication_item_status,
  execute_at timestamptz,
  caption text,
  idempotency_key text,
  attempt_count integer,
  creation_id text,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Limite de claim deve estar entre 1 e 100';
  end if;
  if p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 900 segundos';
  end if;

  return query
  with candidates as (
    select item_row.id
    from public.publication_items as item_row
    where item_row.status in ('ready', 'waiting', 'preparing', 'failed')
      and (item_row.status <> 'failed' or item_row.attempt_count < 5)
      and (item_row.execute_at is null or item_row.execute_at <= timezone('utc', now()))
      and (item_row.next_attempt_at is null or item_row.next_attempt_at <= timezone('utc', now()))
      and (item_row.lease_until is null or item_row.lease_until <= timezone('utc', now()))
    order by coalesce(item_row.execute_at, item_row.created_at), item_row.created_at, item_row.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.publication_items as item_row
    set
      status = 'preparing',
      claimed_by = trim(p_worker_id),
      lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
      next_attempt_at = null,
      -- Criar o primeiro contêiner e retomar uma falha real consomem tentativa.
      -- Reconsultar um contêiner IN_PROGRESS não consome tentativa.
      attempt_count = item_row.attempt_count + case
        when item_row.creation_id is null or item_row.status = 'failed' then 1
        else 0
      end
    from candidates
    where item_row.id = candidates.id
    returning item_row.id, item_row.organization_id, item_row.batch_id, item_row.profile_id,
      item_row.format, item_row.status, item_row.execute_at, item_row.caption,
      item_row.idempotency_key, item_row.attempt_count, item_row.creation_id, item_row.lease_until
  ), updated_batches as (
    update public.publication_batches as batch_row
    set status = 'processing'
    where batch_row.id in (select distinct batch_id from claimed)
      and batch_row.status in ('queued', 'validating')
  )
  select * from claimed;
end;
$$;

-- Grava o contêiner imediatamente e limita polling a cinco consultas, uma por minuto.
create or replace function public.defer_publication_item(
  p_item_id uuid,
  p_worker_id text,
  p_creation_id text,
  p_delay_seconds integer default 60,
  p_is_poll boolean default false
)
returns table (
  id uuid,
  status public.publication_item_status,
  creation_id text,
  next_attempt_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  updated_row public.publication_items%rowtype;
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if char_length(trim(coalesce(p_creation_id, ''))) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'Identificador de contêiner inválido';
  end if;
  if p_delay_seconds not between 15 and 900 then
    raise exception using errcode = '22023', message = 'Aguardar entre 15 e 900 segundos';
  end if;

  select item_source.* into item_row
  from public.publication_items as item_source
  where item_source.id = p_item_id
    and item_source.claimed_by = trim(p_worker_id)
    and item_source.lease_until > timezone('utc', now())
    and item_source.status in ('preparing', 'publishing')
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker';
  end if;
  if p_is_poll and item_row.creation_id is distinct from trim(p_creation_id) then
    raise exception using errcode = '22023', message = 'Polling requer o contêiner persistido do item';
  end if;

  if p_is_poll and item_row.container_poll_count >= 4 then
    update public.publication_items as item_update
    set status = 'failed', claimed_by = null, lease_until = null, next_attempt_at = null,
        last_error_code = 'container_processing_timeout',
        last_error_message = 'O contêiner não ficou pronto após cinco consultas à Meta.'
    where item_update.id = item_row.id
    returning item_update.* into updated_row;

    perform public.log_publication_item_event(
      updated_row.id, 'failed', item_row.status, updated_row.status, null, trim(p_worker_id),
      updated_row.last_error_code, updated_row.last_error_message,
      jsonb_build_object('container_poll_count', item_row.container_poll_count + 1)
    );
    perform public.sync_publication_batch_status(item_row.batch_id);
  else
    update public.publication_items as item_update
    set status = 'waiting', creation_id = trim(p_creation_id), claimed_by = null, lease_until = null,
        next_attempt_at = timezone('utc', now()) + make_interval(secs => p_delay_seconds),
        container_poll_count = case when p_is_poll then item_update.container_poll_count + 1 else 0 end,
        last_error_code = null, last_error_message = null
    where item_update.id = item_row.id
    returning item_update.* into updated_row;

    perform public.log_publication_item_event(
      updated_row.id, 'processing_deferred', item_row.status, updated_row.status, null, trim(p_worker_id),
      null, null, jsonb_build_object(
        'creation_id', updated_row.creation_id,
        'container_poll_count', updated_row.container_poll_count,
        'next_attempt_at', updated_row.next_attempt_at
      )
    );
  end if;

  return query select updated_row.id, updated_row.status, updated_row.creation_id, updated_row.next_attempt_at;
end;
$$;

-- Reserva uma vaga local antes do media_publish. A trava por perfil elimina a
-- condição de corrida entre workers concorrentes para o teto de 100/24 horas.
create or replace function public.reserve_publication_daily_limit(
  p_item_id uuid,
  p_worker_id text,
  p_limit integer default 100,
  p_reservation_seconds integer default 300
)
returns table (
  allowed boolean,
  published_count integer,
  next_attempt_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  current_count integer;
  retry_at timestamptz;
begin
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Limite diário inválido';
  end if;
  if p_reservation_seconds not between 60 and 900 then
    raise exception using errcode = '22023', message = 'Duração de reserva inválida';
  end if;

  select item_source.* into item_row
  from public.publication_items as item_source
  where item_source.id = p_item_id
    and item_source.claimed_by = trim(p_worker_id)
    and item_source.lease_until > timezone('utc', now())
    and item_source.status in ('preparing', 'publishing')
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(item_row.profile_id::text, 1));
  delete from public.publication_profile_daily_reservations
  where profile_id = item_row.profile_id and expires_at <= timezone('utc', now());

  if exists (select 1 from public.publication_profile_daily_reservations where publication_item_id = item_row.id) then
    select count(*)::integer into current_count
    from public.publication_items
    where profile_id = item_row.profile_id
      and status = 'published'
      and published_at >= timezone('utc', now()) - interval '24 hours';
    return query select true, current_count, null::timestamptz;
    return;
  end if;

  select count(*)::integer into current_count
  from public.publication_items
  where profile_id = item_row.profile_id
    and status = 'published'
    and published_at >= timezone('utc', now()) - interval '24 hours';

  current_count := current_count + (select count(*)::integer from public.publication_profile_daily_reservations where profile_id = item_row.profile_id);
  if current_count >= p_limit then
    select min(expiry) into retry_at
    from (
      select published_at + interval '24 hours' as expiry
      from public.publication_items
      where profile_id = item_row.profile_id
        and status = 'published'
        and published_at >= timezone('utc', now()) - interval '24 hours'
      union all
      select expires_at as expiry
      from public.publication_profile_daily_reservations
      where profile_id = item_row.profile_id
    ) as expirations;

    update public.publication_items
    set status = 'waiting', claimed_by = null, lease_until = null,
        next_attempt_at = coalesce(retry_at, timezone('utc', now()) + interval '1 hour'),
        last_error_code = 'daily_profile_limit',
        last_error_message = 'Limite de 100 publicações por perfil nas últimas 24 horas atingido.'
    where id = item_row.id;

    perform public.log_publication_item_event(
      item_row.id, 'processing_deferred', item_row.status, 'waiting', null, trim(p_worker_id),
      'daily_profile_limit', 'Limite de 100 publicações por perfil nas últimas 24 horas atingido.',
      jsonb_build_object('published_count', current_count, 'next_attempt_at', retry_at)
    );
    return query select false, current_count, retry_at;
    return;
  end if;

  insert into public.publication_profile_daily_reservations (publication_item_id, profile_id, expires_at)
  values (item_row.id, item_row.profile_id, timezone('utc', now()) + make_interval(secs => p_reservation_seconds));
  return query select true, current_count, null::timestamptz;
end;
$$;

-- A conclusão remove a reserva, inclusive quando a requisição final falha.
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
language plpgsql
security definer
set search_path = public
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

  select item_source.* into item_row
  from public.publication_items as item_source
  where item_source.id = p_item_id
    and item_source.claimed_by = trim(p_worker_id)
    and item_source.lease_until > timezone('utc', now())
    and item_source.status in ('preparing', 'publishing')
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker';
  end if;

  if p_outcome = 'published' then
    update public.publication_items as item_update
    set status = 'published',
        meta_media_id = coalesce(nullif(trim(p_meta_media_id), ''), item_update.meta_media_id),
        published_at = timezone('utc', now()), claimed_by = null, lease_until = null,
        next_attempt_at = null, last_error_code = null, last_error_message = null
    where item_update.id = item_row.id
    returning item_update.* into updated_row;

    update public.media_assets as asset
    set first_published_at = coalesce(asset.first_published_at, timezone('utc', now()))
    from public.publication_item_media as item_media
    where item_media.publication_item_id = item_row.id
      and item_media.media_asset_id = asset.id
      and asset.organization_id = item_row.organization_id;
  elsif p_retryable and item_row.attempt_count < p_max_attempts then
    retry_delay_seconds := (60 * power(2, least(item_row.attempt_count - 1, 6)))::integer + floor(random() * 31)::integer;
    update public.publication_items as item_update
    set status = 'failed', claimed_by = null, lease_until = null,
        next_attempt_at = timezone('utc', now()) + make_interval(secs => retry_delay_seconds),
        last_error_code = left(nullif(trim(p_error_code), ''), 120),
        last_error_message = left(nullif(trim(p_error_message), ''), 1200)
    where item_update.id = item_row.id
    returning item_update.* into updated_row;
  else
    update public.publication_items as item_update
    set status = 'failed', claimed_by = null, lease_until = null, next_attempt_at = null,
        last_error_code = left(nullif(trim(p_error_code), ''), 120),
        last_error_message = left(nullif(trim(p_error_message), ''), 1200)
    where item_update.id = item_row.id
    returning item_update.* into updated_row;
  end if;

  delete from public.publication_profile_daily_reservations where publication_item_id = item_row.id;

  perform public.log_publication_item_event(
    updated_row.id,
    case when updated_row.status = 'published' then 'published'::public.publication_item_event_type else 'failed'::public.publication_item_event_type end,
    item_row.status, updated_row.status, null, trim(p_worker_id),
    case when updated_row.status = 'failed' then updated_row.last_error_code else null end,
    case when updated_row.status = 'failed' then updated_row.last_error_message else null end,
    jsonb_build_object('attempt_count', updated_row.attempt_count, 'next_attempt_at', updated_row.next_attempt_at)
  );
  perform public.sync_publication_batch_status(item_row.batch_id);

  return query select updated_row.id, updated_row.status, updated_row.attempt_count, updated_row.next_attempt_at, updated_row.published_at;
end;
$$;

revoke all on function public.claim_publication_items(text, integer, integer) from public, anon, authenticated;
revoke all on function public.defer_publication_item(uuid, text, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.reserve_publication_daily_limit(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_publication_item(uuid, text, text, text, text, text, boolean, integer) from public, anon, authenticated;
revoke all on function public.mark_publication_item_media_as_published(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sync_publication_batch_status_for_item(uuid) from public, anon, authenticated;
grant execute on function public.claim_publication_items(text, integer, integer) to service_role;
grant execute on function public.defer_publication_item(uuid, text, text, integer, boolean) to service_role;
grant execute on function public.reserve_publication_daily_limit(uuid, text, integer, integer) to service_role;
grant execute on function public.complete_publication_item(uuid, text, text, text, text, text, boolean, integer) to service_role;
grant execute on function public.mark_publication_item_media_as_published(uuid, uuid) to service_role;
grant execute on function public.sync_publication_batch_status_for_item(uuid) to service_role;
