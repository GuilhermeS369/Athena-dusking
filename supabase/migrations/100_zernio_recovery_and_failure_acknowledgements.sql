-- Recuperação única de download para Zernio e confirmação visual auditável de falhas.

alter table public.publication_items
  add column if not exists provider_creation_started_at timestamptz,
  add column if not exists zernio_recovery_count integer not null default 0 check (zernio_recovery_count between 0 and 1),
  add column if not exists zernio_recovery_poll_at timestamptz;

create table if not exists public.publication_zernio_recoveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  publication_item_id uuid not null unique references public.publication_items(id) on delete cascade,
  original_creation_id text not null,
  original_creation_started_at timestamptz not null,
  original_url_fingerprint text,
  replacement_creation_id text,
  replacement_poll_at timestamptz not null,
  error_code text not null,
  error_message text not null,
  scheduled_at timestamptz not null default timezone('utc', now()),
  replacement_created_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  check (char_length(original_creation_id) between 1 and 160),
  check (char_length(coalesce(replacement_creation_id, '')) <= 160),
  check (char_length(coalesce(original_url_fingerprint, '')) <= 128),
  check (char_length(error_code) between 1 and 120),
  check (char_length(error_message) between 1 and 1200)
);

create index if not exists publication_zernio_recoveries_org_created_idx
  on public.publication_zernio_recoveries(organization_id, created_at desc);

alter table public.publication_zernio_recoveries enable row level security;
create policy publication_zernio_recoveries_select_member
  on public.publication_zernio_recoveries for select to authenticated
  using (public.is_organization_member(organization_id));
revoke all on public.publication_zernio_recoveries from public, anon, authenticated;
grant select on public.publication_zernio_recoveries to authenticated;
grant all on public.publication_zernio_recoveries to service_role;

-- Repetir a consulta do mesmo post terminal não é uma segunda entrega de mídia.
-- O lock da mídia no RPC torna esta deduplicação segura entre workers concorrentes.
create or replace function public.record_media_asset_delivery_attempt(
  p_media_asset_id uuid,
  p_publication_item_id uuid,
  p_provider text,
  p_phase text,
  p_outcome text,
  p_error_code text default null,
  p_error_message text default null,
  p_url_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  asset_row public.media_assets%rowtype;
  item_row public.publication_items%rowtype;
  health_row public.media_asset_delivery_health%rowtype;
  now_at timestamptz := timezone('utc', now());
  normalized_code text := left(coalesce(nullif(trim(p_error_code), ''), 'media_delivery_failed'), 120);
  normalized_message text := left(coalesce(nullif(trim(p_error_message), ''), 'A mídia não pôde ser entregue ao provedor.'), 1200);
  normalized_fingerprint text := left(coalesce(nullif(trim(p_url_fingerprint), ''), 'without_fingerprint'), 128);
  quarantine_now boolean := false;
  duplicate_failure boolean := false;
  affected_item record;
begin
  if p_phase not in ('url_probe', 'provider_download') or p_outcome not in ('succeeded', 'failed') then
    raise exception using errcode = '22023', message = 'Resultado de entrega de mídia inválido.';
  end if;

  select asset.* into asset_row from public.media_assets asset where asset.id = p_media_asset_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Mídia não encontrada.'; end if;
  select item.* into item_row from public.publication_items item where item.id = p_publication_item_id;
  if not found or item_row.organization_id <> asset_row.organization_id then
    raise exception using errcode = '42501', message = 'Item de publicação não pertence à mídia.';
  end if;

  if normalized_fingerprint = 'without_fingerprint' and p_phase = 'provider_download' then
    select coalesce(nullif(attempt.url_fingerprint, ''), normalized_fingerprint)
      into normalized_fingerprint
    from public.media_asset_delivery_attempts attempt
    where attempt.media_asset_id = asset_row.id
      and attempt.publication_item_id = item_row.id
      and attempt.phase = 'url_probe'
      and attempt.outcome = 'succeeded'
    order by attempt.created_at desc
    limit 1;
  end if;

  duplicate_failure := p_phase = 'provider_download'
    and p_outcome = 'failed'
    and exists (
      select 1
      from public.media_asset_delivery_attempts attempt
      where attempt.media_asset_id = asset_row.id
        and attempt.publication_item_id = item_row.id
        and attempt.provider = left(trim(p_provider), 80)
        and attempt.phase = p_phase
        and attempt.outcome = p_outcome
        and attempt.error_code = normalized_code
        and coalesce(attempt.url_fingerprint, 'without_fingerprint') = normalized_fingerprint
    );
  if duplicate_failure then
    select health.* into health_row
    from public.media_asset_delivery_health health
    where health.media_asset_id = asset_row.id;
    return jsonb_build_object(
      'mediaAssetId', asset_row.id,
      'deduplicated', true,
      'quarantined', coalesce(health_row.quarantined_at is not null, false),
      'consecutiveEquivalentFailures', coalesce(health_row.consecutive_equivalent_failures, 0)
    );
  end if;

  insert into public.media_asset_delivery_attempts (
    organization_id, media_asset_id, publication_item_id, provider, phase, outcome,
    error_code, error_message, url_fingerprint
  ) values (
    asset_row.organization_id, asset_row.id, item_row.id, left(trim(p_provider), 80), p_phase, p_outcome,
    case when p_outcome = 'failed' then normalized_code else null end,
    case when p_outcome = 'failed' then normalized_message else null end,
    nullif(normalized_fingerprint, 'without_fingerprint')
  );

  insert into public.media_asset_delivery_health (media_asset_id, organization_id)
  values (asset_row.id, asset_row.organization_id)
  on conflict (media_asset_id) do nothing;
  select health.* into health_row from public.media_asset_delivery_health health where health.media_asset_id = asset_row.id for update;

  if p_outcome = 'succeeded' and p_phase = 'provider_download' then
    update public.media_asset_delivery_health health
    set consecutive_equivalent_failures = 0, last_success_at = now_at, updated_at = now_at
    where health.media_asset_id = asset_row.id;
  elsif p_outcome = 'succeeded' then
    update public.media_asset_delivery_health health
    set last_success_at = now_at, updated_at = now_at
    where health.media_asset_id = asset_row.id;
  elsif health_row.quarantined_at is null then
    if health_row.last_failure_code = normalized_code and health_row.last_failure_fingerprint is distinct from normalized_fingerprint then
      health_row.consecutive_equivalent_failures := health_row.consecutive_equivalent_failures + 1;
    else
      health_row.consecutive_equivalent_failures := 1;
    end if;
    quarantine_now := health_row.consecutive_equivalent_failures >= 2;
    update public.media_asset_delivery_health health
    set consecutive_equivalent_failures = health_row.consecutive_equivalent_failures,
        last_failure_code = normalized_code, last_failure_fingerprint = normalized_fingerprint, last_failure_at = now_at,
        quarantined_at = case when quarantine_now then now_at else null end,
        quarantine_reason = case when quarantine_now then left(format('Mídia bloqueada após %s falhas independentes de entrega (%s).', health_row.consecutive_equivalent_failures, normalized_code), 1200) else health.quarantine_reason end,
        updated_at = now_at
    where health.media_asset_id = asset_row.id;
  end if;

  if quarantine_now then
    for affected_item in
      with quarantined_items as (
        update public.publication_items item
        set status = 'removed', cancelled_at = now_at, claimed_by = null, lease_until = null, next_attempt_at = null,
            last_error_code = 'media_asset_quarantined',
            last_error_message = 'Mídia bloqueada após falhas repetidas de download pelo provedor. Reabilite ou substitua a mídia antes de agendar novamente.'
        where item.id <> item_row.id and item.organization_id = asset_row.organization_id
          and item.status in ('waiting', 'ready', 'failed') and item.creation_id is null
          and exists (select 1 from public.publication_item_media item_media where item_media.publication_item_id = item.id and item_media.media_asset_id = asset_row.id)
        returning item.id, item.status as previous_status, item.batch_id
      ) select * from quarantined_items
    loop
      perform public.log_publication_item_event(
        affected_item.id, 'cancelled', affected_item.previous_status, 'removed', null,
        'system: media-asset-quarantine', 'media_asset_quarantined',
        'Mídia bloqueada após falhas repetidas de download pelo provedor. Reabilite ou substitua a mídia antes de agendar novamente.',
        jsonb_build_object('media_asset_id', asset_row.id, 'delivery_error_code', normalized_code)
      );
      perform public.sync_publication_batch_status(affected_item.batch_id);
    end loop;
  end if;

  return jsonb_build_object(
    'mediaAssetId', asset_row.id,
    'deduplicated', false,
    'quarantined', quarantine_now or health_row.quarantined_at is not null,
    'consecutiveEquivalentFailures', case when p_outcome = 'succeeded' then 0 else health_row.consecutive_equivalent_failures end
  );
end;
$$;

create table if not exists public.publication_failure_acknowledgements (
  publication_item_id uuid primary key references public.publication_items(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  acknowledged_at timestamptz not null default timezone('utc', now()),
  acknowledged_by uuid references auth.users(id) on delete set null,
  scope text not null check (scope in ('batch', 'visible_items')),
  action_id uuid not null default gen_random_uuid()
);

create index if not exists publication_failure_acknowledgements_org_created_idx
  on public.publication_failure_acknowledgements(organization_id, acknowledged_at desc);

alter table public.publication_failure_acknowledgements enable row level security;
create policy publication_failure_acknowledgements_select_member
  on public.publication_failure_acknowledgements for select to authenticated
  using (public.is_organization_member(organization_id));
revoke all on public.publication_failure_acknowledgements from public, anon, authenticated;
grant select on public.publication_failure_acknowledgements to authenticated;
grant all on public.publication_failure_acknowledgements to service_role;

alter table public.publication_queue_action_audits
  drop constraint if exists publication_queue_action_audits_action_check;
alter table public.publication_queue_action_audits
  add constraint publication_queue_action_audits_action_check
  check (action in ('archive_completed', 'release_stuck', 'acknowledge_failures'));

create or replace function public.acknowledge_publication_failures(
  p_organization_id uuid,
  p_batch_id uuid default null,
  p_item_ids uuid[] default null
)
returns table (acknowledged_count integer, acknowledged_item_ids uuid[])
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  resolved_ids uuid[] := '{}'::uuid[];
  resolved_scope text := case when p_batch_id is null then 'visible_items' else 'batch' end;
begin
  if auth.role() <> 'service_role' and (
    actor_id is null or not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[])
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_batch_id is null and coalesce(cardinality(p_item_ids), 0) = 0 then
    raise exception using errcode = '22023', message = 'Informe um lote ou itens com falha.';
  end if;

  with targets as (
    select item.id
    from public.publication_items item
    where item.organization_id = p_organization_id
      and item.status = 'failed'
      and ((p_batch_id is not null and item.batch_id = p_batch_id)
        or (p_batch_id is null and item.id = any(p_item_ids)))
  ), inserted as (
    insert into public.publication_failure_acknowledgements (
      publication_item_id, organization_id, acknowledged_by, scope
    )
    select id, p_organization_id, actor_id, resolved_scope from targets
    on conflict (publication_item_id) do nothing
    returning publication_item_id
  ) select coalesce(array_agg(publication_item_id), '{}'::uuid[]) into resolved_ids from inserted;

  insert into public.publication_queue_action_audits (
    organization_id, actor_user_id, action, affected_count, item_ids, metadata
  ) values (
    p_organization_id, actor_id, 'acknowledge_failures', cardinality(resolved_ids), resolved_ids,
    jsonb_build_object('scope', resolved_scope, 'batch_id', p_batch_id)
  );
  return query select cardinality(resolved_ids), resolved_ids;
end;
$$;

create or replace function public.schedule_zernio_media_download_recovery(
  p_item_id uuid,
  p_worker_id text,
  p_creation_id text,
  p_error_code text,
  p_error_message text,
  p_url_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
begin
  select item.* into item_row from public.publication_items item
  where item.id = p_item_id and item.claimed_by = trim(p_worker_id)
    and item.lease_until > timezone('utc', now()) and item.status in ('preparing', 'publishing')
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker.'; end if;
  if item_row.creation_id is distinct from trim(p_creation_id) then
    raise exception using errcode = '22023', message = 'A criação Zernio não corresponde ao item.';
  end if;
  if item_row.zernio_recovery_count >= 1 then
    return jsonb_build_object('scheduled', false, 'reason', 'recovery_already_used');
  end if;
  if item_row.container_poll_count <> 1 or item_row.provider_creation_started_at is null then
    return jsonb_build_object('scheduled', false, 'reason', 'recovery_requires_second_poll');
  end if;

  insert into public.publication_zernio_recoveries (
    organization_id, publication_item_id, original_creation_id, original_creation_started_at,
    original_url_fingerprint, replacement_poll_at, error_code, error_message
  ) values (
    item_row.organization_id, item_row.id, trim(p_creation_id), item_row.provider_creation_started_at,
    nullif(trim(coalesce(p_url_fingerprint, '')), ''), item_row.provider_creation_started_at + interval '6 minutes',
    left(trim(p_error_code), 120), left(trim(p_error_message), 1200)
  ) on conflict (publication_item_id) do nothing;
  if not found then return jsonb_build_object('scheduled', false, 'reason', 'recovery_already_recorded'); end if;

  update public.publication_items item
  set status = 'waiting', creation_id = null, provider_creation_started_at = null,
      container_poll_count = 0, zernio_recovery_count = 1, claimed_by = null, lease_until = null,
      zernio_recovery_poll_at = item_row.provider_creation_started_at + interval '6 minutes',
      next_attempt_at = timezone('utc', now()), last_error_code = null, last_error_message = null
  where item.id = item_row.id;
  perform public.log_publication_item_event(
    item_row.id, 'retry_requested', item_row.status, 'waiting', null, trim(p_worker_id),
    'zernio_media_download_recovery', 'A Zernio aceitou uma recriação única com nova URL após o Instagram não baixar a mídia.',
    jsonb_build_object(
      'original_creation_id', trim(p_creation_id),
      'url_fingerprint', p_url_fingerprint,
      'replacement_poll_at', item_row.provider_creation_started_at + interval '6 minutes'
    )
  );
  return jsonb_build_object('scheduled', true, 'recoveryCount', 1);
end;
$$;

-- Falhas terminais sem next_attempt_at não podem voltar ao worker apenas por terem menos de cinco tentativas.
-- Mantém exatamente a assinatura já exposta pelo RPC. Os metadados adicionais
-- da recuperação são carregados pelo worker a partir do item, evitando mudar o
-- tipo de retorno de uma função existente em produção.
create or replace function public.claim_publication_items(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  id uuid, organization_id uuid, batch_id uuid, profile_id uuid,
  format public.publication_format, status public.publication_item_status,
  execute_at timestamptz, caption text, idempotency_key text,
  attempt_count integer, creation_id text, lease_until timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then raise exception using errcode = '22023', message = 'Identificador de worker inválido'; end if;
  if p_limit not between 1 and 100 then raise exception using errcode = '22023', message = 'Limite de claim deve estar entre 1 e 100'; end if;
  if p_lease_seconds not between 30 and 900 then raise exception using errcode = '22023', message = 'Lease deve estar entre 30 e 900 segundos'; end if;
  return query with candidates as (
    select item_row.id
    from public.publication_items as item_row
    where item_row.status in ('ready', 'waiting', 'preparing', 'failed')
      and (item_row.status <> 'failed' or (item_row.attempt_count < 5 and item_row.next_attempt_at is not null))
      and (item_row.execute_at is null or item_row.execute_at <= timezone('utc', now()))
      and (item_row.next_attempt_at is null or item_row.next_attempt_at <= timezone('utc', now()))
      and (item_row.lease_until is null or item_row.lease_until <= timezone('utc', now()))
      and not exists (
        select 1
        from public.publication_batch_circuit_breakers breaker
        where breaker.batch_id = item_row.batch_id
          and breaker.paused_at is not null
      )
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
    where batch_row.id in (select distinct claimed.batch_id from claimed)
      and batch_row.status in ('queued', 'validating')
  )
  select * from claimed;
end;
$$;

create or replace function public.defer_publication_item(
  p_item_id uuid, p_worker_id text, p_creation_id text, p_delay_seconds integer default 60, p_is_poll boolean default false
)
returns table (id uuid, status public.publication_item_status, creation_id text, next_attempt_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare item_row public.publication_items%rowtype; updated_row public.publication_items%rowtype;
begin
  if p_delay_seconds not between 15 and 900 then raise exception using errcode = '22023', message = 'Aguardar entre 15 e 900 segundos'; end if;
  select item.* into item_row from public.publication_items item where item.id = p_item_id and item.claimed_by = trim(p_worker_id)
    and item.lease_until > timezone('utc', now()) and item.status in ('preparing', 'publishing') for update;
  if not found then raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker'; end if;
  if p_is_poll and item_row.creation_id is distinct from trim(p_creation_id) then raise exception using errcode = '22023', message = 'Polling requer a criação persistida do item'; end if;
  update public.publication_items item set status = 'waiting', creation_id = trim(p_creation_id), claimed_by = null, lease_until = null,
    next_attempt_at = timezone('utc', now()) + make_interval(secs => p_delay_seconds),
    provider_creation_started_at = case when p_is_poll then item.provider_creation_started_at else timezone('utc', now()) end,
    container_poll_count = case when p_is_poll then item.container_poll_count + 1 else 0 end,
    last_error_code = null, last_error_message = null
  where item.id = item_row.id returning item.* into updated_row;
  if not p_is_poll and updated_row.zernio_recovery_count = 1 then
    update public.publication_zernio_recoveries recovery
    set replacement_creation_id = updated_row.creation_id,
        replacement_created_at = timezone('utc', now())
    where recovery.publication_item_id = updated_row.id
      and recovery.replacement_creation_id is null;
  end if;
  perform public.log_publication_item_event(updated_row.id, 'processing_deferred', item_row.status, updated_row.status, null, trim(p_worker_id), null, null,
    jsonb_build_object('creation_id', updated_row.creation_id, 'container_poll_count', updated_row.container_poll_count, 'next_attempt_at', updated_row.next_attempt_at));
  return query select updated_row.id, updated_row.status, updated_row.creation_id, updated_row.next_attempt_at;
end;
$$;

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
returns table (id uuid, status public.publication_item_status, attempt_count integer, next_attempt_at timestamptz, published_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  updated_row public.publication_items%rowtype;
  retry_delay_seconds integer;
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then raise exception using errcode = '22023', message = 'Identificador de worker inválido'; end if;
  if p_outcome not in ('published', 'failed', 'removed') then raise exception using errcode = '22023', message = 'Resultado de publicação inválido'; end if;
  if p_max_attempts not between 1 and 20 then raise exception using errcode = '22023', message = 'Máximo de tentativas deve estar entre 1 e 20'; end if;

  select item_source.* into item_row from public.publication_items as item_source
  where item_source.id = p_item_id and item_source.claimed_by = trim(p_worker_id)
    and item_source.lease_until > timezone('utc', now()) and item_source.status in ('preparing', 'publishing')
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker'; end if;

  if p_outcome = 'published' then
    update public.publication_items as item_update
    set status = 'published', meta_media_id = coalesce(nullif(trim(p_meta_media_id), ''), item_update.meta_media_id),
        published_at = timezone('utc', now()), claimed_by = null, lease_until = null, next_attempt_at = null,
        last_error_code = null, last_error_message = null
    where item_update.id = item_row.id returning item_update.* into updated_row;
    update public.media_assets as asset
    set first_published_at = coalesce(asset.first_published_at, timezone('utc', now()))
    from public.publication_item_media as item_media
    where item_media.publication_item_id = item_row.id and item_media.media_asset_id = asset.id
      and asset.organization_id = item_row.organization_id;
  elsif p_outcome = 'removed' then
    update public.publication_items as item_update
    set status = 'removed', cancelled_at = timezone('utc', now()), claimed_by = null, lease_until = null,
        next_attempt_at = null, creation_id = null,
        last_error_code = left(coalesce(nullif(trim(p_error_code), ''), 'media_deleted'), 120),
        last_error_message = left(coalesce(nullif(trim(p_error_message), ''), 'Mídia apagada.'), 1200)
    where item_update.id = item_row.id returning item_update.* into updated_row;
  elsif p_retryable and item_row.attempt_count < p_max_attempts then
    retry_delay_seconds := (60 * power(2, least(item_row.attempt_count - 1, 6)))::integer + floor(random() * 31)::integer;
    update public.publication_items as item_update
    set status = 'failed', claimed_by = null, lease_until = null,
        next_attempt_at = timezone('utc', now()) + make_interval(secs => retry_delay_seconds),
        last_error_code = left(nullif(trim(p_error_code), ''), 120), last_error_message = left(nullif(trim(p_error_message), ''), 1200)
    where item_update.id = item_row.id returning item_update.* into updated_row;
  else
    update public.publication_items as item_update
    set status = 'failed', claimed_by = null, lease_until = null, next_attempt_at = null,
        last_error_code = left(nullif(trim(p_error_code), ''), 120), last_error_message = left(nullif(trim(p_error_message), ''), 1200)
    where item_update.id = item_row.id returning item_update.* into updated_row;
  end if;

  delete from public.publication_profile_daily_reservations as reservation where reservation.publication_item_id = item_row.id;
  update public.publication_zernio_recoveries recovery
  set completed_at = timezone('utc', now())
  where recovery.publication_item_id = updated_row.id
    and recovery.completed_at is null
    and updated_row.next_attempt_at is null
    and updated_row.status in ('published', 'failed', 'removed');

  perform public.log_publication_item_event(
    updated_row.id,
    case when updated_row.status = 'published' then 'published'::public.publication_item_event_type
      when updated_row.status = 'removed' then 'cancelled'::public.publication_item_event_type else 'failed'::public.publication_item_event_type end,
    item_row.status, updated_row.status, null, trim(p_worker_id),
    case when updated_row.status in ('failed', 'removed') then updated_row.last_error_code else null end,
    case when updated_row.status in ('failed', 'removed') then updated_row.last_error_message else null end,
    jsonb_build_object('attempt_count', updated_row.attempt_count, 'next_attempt_at', updated_row.next_attempt_at)
  );
  perform public.sync_publication_batch_status(item_row.batch_id);
  return query select result_item.id, result_item.status, result_item.attempt_count, result_item.next_attempt_at, result_item.published_at
  from public.publication_items as result_item where result_item.id = updated_row.id;
end;
$$;

create or replace function public.get_publication_queue_reference_summary(
  p_organization_id uuid
)
returns jsonb
language sql stable security definer set search_path = public as $$
  with authorized as (
    select p_organization_id as organization_id
    where auth.role() = 'service_role' or public.is_organization_member(p_organization_id)
  ), operational_items as (
    select item.*, acknowledgement.publication_item_id is not null as failure_acknowledged
    from public.publication_items item
    join authorized auth_org on auth_org.organization_id = item.organization_id
    left join public.publication_failure_acknowledgements acknowledgement on acknowledgement.publication_item_id = item.id
    where item.archived_at is null
  ), totals as (
    select count(*)::integer as total,
      count(*) filter (where status = 'published')::integer as ok,
      count(*) filter (where status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where status in ('preparing', 'publishing'))::integer as processing,
      count(*) filter (where status = 'failed' and not failure_acknowledged)::integer as errors,
      count(*) filter (where status = 'failed' and failure_acknowledged)::integer as acknowledged_errors,
      count(*) filter (where status = 'suspended')::integer as suspended,
      count(*) filter (where status in ('cancelled', 'removed', 'ignored'))::integer as closed,
      count(*) filter (where status in ('preparing', 'publishing') and lease_until is not null and lease_until <= timezone('utc', now()))::integer as expired_leases,
      count(distinct profile_id) filter (where status in ('waiting', 'ready', 'preparing', 'publishing', 'failed'))::integer as active_accounts,
      count(distinct profile_id) filter (where status = 'suspended')::integer as suspended_accounts,
      count(distinct profile_id)::integer as total_accounts
    from operational_items
  ), account_rows as (
    select item.profile_id as id, profile.username, profile.display_name, profile.profile_picture_url,
      count(*)::integer as total, count(*) filter (where item.status = 'published')::integer as completed,
      count(*) filter (where item.status = 'failed' and not item.failure_acknowledged)::integer as errors,
      count(*) filter (where item.status = 'suspended')::integer as suspended,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer as processing,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')) as next_at,
      case when bool_or(item.status in ('preparing', 'publishing')) then 'posting' when bool_or(item.status = 'failed' and not item.failure_acknowledged) then 'error' when bool_or(item.status in ('waiting', 'ready')) then 'idle' when bool_or(item.status = 'suspended') then 'suspended' else 'done' end as tone
    from operational_items item join public.instagram_profiles profile on profile.id = item.profile_id
    group by item.profile_id, profile.username, profile.display_name, profile.profile_picture_url
  ), batch_rows as (
    select item.batch_id as id, coalesce(batch.name, 'Sem campanha') as title, batch.created_at,
      count(*)::integer as total, count(*) filter (where item.status = 'published')::integer as completed,
      count(*) filter (where item.status = 'failed' and not item.failure_acknowledged)::integer as errors,
      count(*) filter (where item.status = 'suspended')::integer as suspended,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer as processing,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')) as next_at,
      case when bool_or(item.status in ('preparing', 'publishing')) then 'posting' when bool_or(item.status = 'failed' and not item.failure_acknowledged) then 'error' when bool_or(item.status in ('waiting', 'ready')) then 'idle' when bool_or(item.status = 'suspended') then 'suspended' else 'done' end as tone
    from operational_items item join public.publication_batches batch on batch.id = item.batch_id
    group by item.batch_id, batch.name, batch.created_at
  ), profile_membership as (
    select member.profile_id, member.group_id from public.profile_group_members member join authorized auth_org on auth_org.organization_id = member.organization_id
  ), group_rows as (
    select coalesce(membership.group_id::text, 'none') as id, coalesce(profile_group.name, 'Sem grupo') as title,
      count(*)::integer as total, count(*) filter (where item.status = 'published')::integer as completed,
      count(*) filter (where item.status = 'failed' and not item.failure_acknowledged)::integer as errors,
      count(*) filter (where item.status = 'suspended')::integer as suspended,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer as processing,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')) as next_at,
      count(distinct item.profile_id)::integer as profile_count,
      case when bool_or(item.status in ('preparing', 'publishing')) then 'posting' when bool_or(item.status = 'failed' and not item.failure_acknowledged) then 'error' when bool_or(item.status in ('waiting', 'ready')) then 'idle' when bool_or(item.status = 'suspended') then 'suspended' else 'done' end as tone
    from operational_items item left join profile_membership membership on membership.profile_id = item.profile_id left join public.profile_groups profile_group on profile_group.id = membership.group_id
    group by membership.group_id, profile_group.name
  ), archived as (
    select count(*)::integer as total from public.publication_items item join authorized auth_org on auth_org.organization_id = item.organization_id where item.archived_at is not null
  ) select jsonb_build_object(
    'snapshotAt', timezone('utc', now()),
    'totals', jsonb_build_object('total', totals.total, 'ok', totals.ok, 'pending', totals.pending, 'processing', totals.processing, 'errors', totals.errors, 'acknowledgedErrors', totals.acknowledged_errors, 'suspended', totals.suspended, 'closed', totals.closed, 'archived', archived.total, 'expiredLeases', totals.expired_leases, 'activeAccounts', totals.active_accounts, 'suspendedAccounts', totals.suspended_accounts, 'totalAccounts', totals.total_accounts, 'progress', case when totals.total = 0 then 0 else round(totals.ok::numeric * 100 / totals.total)::integer end),
    'accounts', coalesce((select jsonb_agg(to_jsonb(account_rows) order by account_rows.errors desc, account_rows.processing desc, account_rows.pending desc, account_rows.username) from account_rows), '[]'::jsonb),
    'batches', coalesce((select jsonb_agg(to_jsonb(batch_rows) order by batch_rows.errors desc, batch_rows.processing desc, batch_rows.pending desc, batch_rows.created_at desc) from batch_rows), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(to_jsonb(group_rows) order by group_rows.errors desc, group_rows.processing desc, group_rows.pending desc, group_rows.title) from group_rows), '[]'::jsonb)
  ) from totals cross join archived;
$$;

revoke all on function public.acknowledge_publication_failures(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.acknowledge_publication_failures(uuid, uuid, uuid[]) to authenticated, service_role;
revoke all on function public.record_media_asset_delivery_attempt(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_media_asset_delivery_attempt(uuid, uuid, text, text, text, text, text, text) to service_role;
revoke all on function public.schedule_zernio_media_download_recovery(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.schedule_zernio_media_download_recovery(uuid, text, text, text, text, text) to service_role;
revoke all on function public.claim_publication_items(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_publication_items(text, integer, integer) to service_role;
revoke all on function public.defer_publication_item(uuid, text, text, integer, boolean) from public, anon, authenticated;
grant execute on function public.defer_publication_item(uuid, text, text, integer, boolean) to service_role;
revoke all on function public.complete_publication_item(uuid, text, text, text, text, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.complete_publication_item(uuid, text, text, text, text, text, boolean, integer) to service_role;
revoke all on function public.get_publication_queue_reference_summary(uuid) from public, anon;
grant execute on function public.get_publication_queue_reference_summary(uuid) to authenticated, service_role;
