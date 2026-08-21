-- Evita reenviar uma mídia que o provedor não consegue baixar e torna o
-- circuito de lote idempotente por resultado terminal de publicação.

create table if not exists public.media_asset_delivery_health (
  media_asset_id uuid primary key references public.media_assets (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  consecutive_equivalent_failures integer not null default 0 check (consecutive_equivalent_failures >= 0),
  last_failure_code text,
  last_failure_fingerprint text,
  last_failure_at timestamptz,
  last_success_at timestamptz,
  quarantined_at timestamptz,
  quarantine_reason text,
  quarantined_by uuid references auth.users (id) on delete set null,
  reenabled_at timestamptz,
  reenabled_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (char_length(coalesce(last_failure_code, '')) <= 120),
  check (char_length(coalesce(last_failure_fingerprint, '')) <= 128),
  check (char_length(coalesce(quarantine_reason, '')) <= 1200)
);

create index if not exists media_asset_delivery_health_org_quarantined_idx
  on public.media_asset_delivery_health (organization_id, quarantined_at desc)
  where quarantined_at is not null;

create table if not exists public.media_asset_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  media_asset_id uuid not null references public.media_assets (id) on delete cascade,
  publication_item_id uuid references public.publication_items (id) on delete set null,
  provider text not null check (char_length(trim(provider)) between 2 and 80),
  phase text not null check (phase in ('url_probe', 'provider_download')),
  outcome text not null check (outcome in ('succeeded', 'failed')),
  error_code text,
  error_message text,
  url_fingerprint text,
  created_at timestamptz not null default timezone('utc', now()),
  check (char_length(coalesce(error_code, '')) <= 120),
  check (char_length(coalesce(error_message, '')) <= 1200),
  check (char_length(coalesce(url_fingerprint, '')) <= 128)
);

create index if not exists media_asset_delivery_attempts_asset_created_idx
  on public.media_asset_delivery_attempts (media_asset_id, created_at desc);
create index if not exists media_asset_delivery_attempts_item_created_idx
  on public.media_asset_delivery_attempts (publication_item_id, created_at desc);

alter table public.media_asset_delivery_health enable row level security;
alter table public.media_asset_delivery_attempts enable row level security;
revoke all on public.media_asset_delivery_health, public.media_asset_delivery_attempts from public, anon, authenticated;
grant select on public.media_asset_delivery_health, public.media_asset_delivery_attempts to authenticated;
grant all on public.media_asset_delivery_health, public.media_asset_delivery_attempts to service_role;

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
  affected_item record;
begin
  if p_phase not in ('url_probe', 'provider_download') or p_outcome not in ('succeeded', 'failed') then
    raise exception using errcode = '22023', message = 'Resultado de entrega de mídia inválido.';
  end if;

  select asset.* into asset_row
  from public.media_assets asset
  where asset.id = p_media_asset_id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Mídia não encontrada.'; end if;

  select item.* into item_row
  from public.publication_items item
  where item.id = p_publication_item_id;
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

  select health.* into health_row
  from public.media_asset_delivery_health health
  where health.media_asset_id = asset_row.id
  for update;

  if p_outcome = 'succeeded' and p_phase = 'provider_download' then
    update public.media_asset_delivery_health health
    set consecutive_equivalent_failures = 0,
        last_success_at = now_at,
        updated_at = now_at
    where health.media_asset_id = asset_row.id;
  elsif p_outcome = 'succeeded' then
    update public.media_asset_delivery_health health
    set last_success_at = now_at,
        updated_at = now_at
    where health.media_asset_id = asset_row.id;
  elsif health_row.quarantined_at is null then
    if health_row.last_failure_code = normalized_code
      and health_row.last_failure_fingerprint is distinct from normalized_fingerprint then
      health_row.consecutive_equivalent_failures := health_row.consecutive_equivalent_failures + 1;
    else
      health_row.consecutive_equivalent_failures := 1;
    end if;

    quarantine_now := health_row.consecutive_equivalent_failures >= 2;
    update public.media_asset_delivery_health health
    set consecutive_equivalent_failures = health_row.consecutive_equivalent_failures,
        last_failure_code = normalized_code,
        last_failure_fingerprint = normalized_fingerprint,
        last_failure_at = now_at,
        quarantined_at = case when quarantine_now then now_at else null end,
        quarantine_reason = case when quarantine_now then
          left(format('Mídia bloqueada após %s falhas independentes de entrega (%s).', health_row.consecutive_equivalent_failures, normalized_code), 1200)
          else health.quarantine_reason end,
        updated_at = now_at
    where health.media_asset_id = asset_row.id;
  end if;

  if quarantine_now then
    for affected_item in
      with quarantined_items as (
        update public.publication_items item
        set status = 'removed',
            cancelled_at = now_at,
            claimed_by = null,
            lease_until = null,
            next_attempt_at = null,
            last_error_code = 'media_asset_quarantined',
            last_error_message = 'Mídia bloqueada após falhas repetidas de download pelo provedor. Reabilite ou substitua a mídia antes de agendar novamente.'
        where item.id <> item_row.id
          and item.organization_id = asset_row.organization_id
          and item.status in ('waiting', 'ready', 'failed')
          and item.creation_id is null
          and exists (
            select 1 from public.publication_item_media item_media
            where item_media.publication_item_id = item.id
              and item_media.media_asset_id = asset_row.id
          )
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
    'quarantined', quarantine_now or health_row.quarantined_at is not null,
    'consecutiveEquivalentFailures', case when p_outcome = 'succeeded' then 0 else health_row.consecutive_equivalent_failures end
  );
end;
$$;

create or replace function public.reenable_media_asset_delivery(
  p_organization_id uuid,
  p_media_asset_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
begin
  if auth.role() <> 'service_role' and (
    actor_id is null or not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[])
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  update public.media_asset_delivery_health health
  set consecutive_equivalent_failures = 0,
      quarantined_at = null,
      quarantine_reason = null,
      reenabled_at = timezone('utc', now()),
      reenabled_by = actor_id,
      updated_at = timezone('utc', now())
  where health.media_asset_id = p_media_asset_id
    and health.organization_id = p_organization_id;
  if not found then raise exception using errcode = 'P0002', message = 'Mídia não está em monitoramento nesta organização.'; end if;
  return jsonb_build_object('mediaAssetId', p_media_asset_id, 'reenabled', true, 'reason', left(coalesce(p_reason, ''), 1200));
end;
$$;

revoke all on function public.record_media_asset_delivery_attempt(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_media_asset_delivery_attempt(uuid, uuid, text, text, text, text, text, text) to service_role;
revoke all on function public.reenable_media_asset_delivery(uuid, uuid, text) from public, anon;
grant execute on function public.reenable_media_asset_delivery(uuid, uuid, text) to authenticated, service_role;

create table if not exists public.publication_batch_terminal_outcomes (
  publication_item_id uuid primary key references public.publication_items (id) on delete cascade,
  batch_id uuid not null references public.publication_batches (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  outcome text not null check (outcome in ('published', 'failed')),
  event_id uuid not null references public.publication_item_events (id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists publication_batch_terminal_outcomes_batch_created_idx
  on public.publication_batch_terminal_outcomes (batch_id, created_at desc);

alter table public.publication_batch_terminal_outcomes enable row level security;
revoke all on public.publication_batch_terminal_outcomes from public, anon, authenticated;
grant select on public.publication_batch_terminal_outcomes to authenticated;
grant all on public.publication_batch_terminal_outcomes to service_role;

create or replace function public.apply_publication_batch_failure_circuit_breaker()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  inserted_outcome public.publication_batch_terminal_outcomes%rowtype;
  consecutive_count integer;
begin
  if new.event_type not in ('published', 'failed') then return new; end if;

  select item.* into item_row
  from public.publication_items item
  where item.id = new.publication_item_id;
  if item_row.id is null then return new; end if;

  if new.event_type = 'failed' and item_row.next_attempt_at is not null then return new; end if;

  insert into public.publication_batch_terminal_outcomes (
    publication_item_id, batch_id, organization_id, outcome, event_id
  ) values (
    item_row.id, item_row.batch_id, item_row.organization_id,
    case when new.event_type = 'published' then 'published' else 'failed' end, new.id
  ) on conflict (publication_item_id) do nothing
  returning * into inserted_outcome;
  if inserted_outcome.publication_item_id is null then return new; end if;

  insert into public.publication_batch_circuit_breakers (batch_id, organization_id)
  values (item_row.batch_id, item_row.organization_id)
  on conflict (batch_id) do nothing;

  perform 1 from public.publication_batch_circuit_breakers breaker
  where breaker.batch_id = item_row.batch_id
  for update;

  if inserted_outcome.outcome = 'published' then
    update public.publication_batch_circuit_breakers breaker
    set consecutive_failures = 0, updated_at = timezone('utc', now())
    where breaker.batch_id = item_row.batch_id;
    return new;
  end if;

  select breaker.consecutive_failures + 1 into consecutive_count
  from public.publication_batch_circuit_breakers breaker
  where breaker.batch_id = item_row.batch_id;

  update public.publication_batch_circuit_breakers breaker
  set consecutive_failures = consecutive_count,
      last_failure_item_id = item_row.id,
      paused_at = case when consecutive_count >= 5 then coalesce(breaker.paused_at, timezone('utc', now())) else breaker.paused_at end,
      paused_reason = case when consecutive_count >= 5 then 'O lote foi pausado após 5 publicações distintas com falha terminal consecutiva. Corrija a causa e use Continuar lote.' else breaker.paused_reason end,
      updated_at = timezone('utc', now())
  where breaker.batch_id = item_row.batch_id;
  return new;
end;
$$;

drop trigger if exists publication_batch_failure_circuit_breaker_event on public.publication_item_events;
create trigger publication_batch_failure_circuit_breaker_event
after insert on public.publication_item_events
for each row execute function public.apply_publication_batch_failure_circuit_breaker();
