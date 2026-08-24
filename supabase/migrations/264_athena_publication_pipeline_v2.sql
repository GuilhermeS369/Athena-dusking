-- Esteira Athena v2: preparação local em janela móvel, corte seguro de itens
-- existentes e atraso como SLA (não como autorização para descartar conteúdo).
-- Nenhuma publicação é agendada antecipadamente na Zernio.

alter table public.publication_items
  add column if not exists pipeline_version smallint not null default 1,
  add column if not exists pipeline_migrated_at timestamptz,
  add column if not exists preparation_status text not null default 'not_required',
  add column if not exists prepared_at timestamptz,
  add column if not exists preparation_claimed_by text,
  add column if not exists preparation_lease_until timestamptz,
  add column if not exists next_preparation_at timestamptz,
  add column if not exists preparation_error_code text,
  add column if not exists preparation_error_message text,
  add column if not exists overdue_alerted_at timestamptz;

do $$
declare
  cutover_at timestamptz := timezone('utc', now());
begin
  -- O corte nunca torna um item já atrasado elegível à nova política.
  update public.publication_items item
  set pipeline_version = 2,
      pipeline_migrated_at = cutover_at,
      preparation_status = case when item.creation_id is null then 'pending' else 'not_required' end
  where item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
    and item.execute_at is not null
    and (
      item.execute_at >= cutover_at
      or (
        -- Cobre apenas a curta janela operacional da implantação. Não alcança
        -- o incidente histórico e não toma item já iniciado pelo provedor.
        item.execute_at >= cutover_at - interval '120 seconds'
        and item.status in ('waiting', 'ready')
        and item.creation_id is null
        and (item.lease_until is null or item.lease_until <= cutover_at)
        and item.last_error_code is distinct from 'missed_bulk_slot_expired'
      )
    )
    and item.pipeline_version = 1;
end;
$$;

alter table public.publication_items
  alter column pipeline_version set default 2,
  alter column preparation_status set default 'pending';

alter table public.publication_items
  add constraint publication_items_pipeline_version_check
    check (pipeline_version in (1, 2)),
  add constraint publication_items_preparation_status_check
    check (preparation_status in ('pending', 'preparing', 'ready', 'blocked', 'not_required')),
  add constraint publication_items_preparation_error_code_length
    check (char_length(coalesce(preparation_error_code, '')) <= 120),
  add constraint publication_items_preparation_error_message_length
    check (char_length(coalesce(preparation_error_message, '')) <= 1200);

create index publication_items_v2_preparation_claim_idx
  on public.publication_items (preparation_status, next_preparation_at, execute_at, id)
  where pipeline_version = 2
    and status in ('waiting', 'ready')
    and creation_id is null;

create index publication_items_v2_dispatch_claim_idx
  on public.publication_items (status, execute_at, next_attempt_at, organization_id, profile_id, id)
  where pipeline_version = 2
    and status in ('waiting', 'ready', 'preparing', 'failed');

create table public.publication_dispatch_sla_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  batch_id uuid not null references public.publication_batches(id) on delete cascade,
  slot_execute_at timestamptz not null,
  first_detected_at timestamptz not null default timezone('utc', now()),
  last_detected_at timestamptz not null default timezone('utc', now()),
  affected_item_count integer not null default 0 check (affected_item_count >= 0),
  max_overdue_seconds integer not null default 0 check (max_overdue_seconds >= 0),
  state text not null default 'open' check (state in ('open', 'resolved')),
  resolved_at timestamptz,
  unique (organization_id, batch_id, slot_execute_at)
);

create index publication_dispatch_sla_alerts_open_idx
  on public.publication_dispatch_sla_alerts (state, first_detected_at, organization_id);

alter table public.publication_dispatch_sla_alerts enable row level security;
revoke all on table public.publication_dispatch_sla_alerts from public, anon, authenticated;
grant all on table public.publication_dispatch_sla_alerts to service_role;

-- Mudanças no conteúdo ou no horário invalidam somente a preparação local.
create or replace function public.reset_publication_v2_preparation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.pipeline_version = 2
    and new.creation_id is null
    and (
      new.execute_at is distinct from old.execute_at
      or new.caption is distinct from old.caption
      or new.profile_id is distinct from old.profile_id
      or new.format is distinct from old.format
      or new.reel_cover_media_asset_id is distinct from old.reel_cover_media_asset_id
    )
  then
    new.preparation_status := 'pending';
    new.prepared_at := null;
    new.preparation_claimed_by := null;
    new.preparation_lease_until := null;
    new.next_preparation_at := null;
    new.preparation_error_code := null;
    new.preparation_error_message := null;
  end if;
  return new;
end;
$$;

drop trigger if exists publication_items_reset_v2_preparation on public.publication_items;
create trigger publication_items_reset_v2_preparation
before update of execute_at, caption, profile_id, format, reel_cover_media_asset_id
on public.publication_items
for each row execute function public.reset_publication_v2_preparation();

create or replace function public.reset_publication_v2_preparation_for_media()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_item_id uuid := coalesce(new.publication_item_id, old.publication_item_id);
begin
  update public.publication_items item
  set preparation_status = 'pending', prepared_at = null,
      preparation_claimed_by = null, preparation_lease_until = null,
      next_preparation_at = null, preparation_error_code = null,
      preparation_error_message = null
  where item.id = target_item_id
    and item.pipeline_version = 2
    and item.creation_id is null
    and item.status in ('waiting', 'ready');
  return coalesce(new, old);
end;
$$;

drop trigger if exists publication_item_media_reset_v2_preparation on public.publication_item_media;
create trigger publication_item_media_reset_v2_preparation
after insert or update or delete on public.publication_item_media
for each row execute function public.reset_publication_v2_preparation_for_media();

create or replace function public.claim_publication_preparation_items(
  p_worker_id text,
  p_limit integer default 50,
  p_lease_seconds integer default 180,
  p_window_hours integer default 24
)
returns table (
  id uuid, organization_id uuid, batch_id uuid, profile_id uuid,
  format public.publication_format, execute_at timestamptz, caption text,
  idempotency_key text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Limite de preparação deve estar entre 1 e 500';
  end if;
  if p_lease_seconds not between 30 and 900 or p_window_hours not between 1 and 24 then
    raise exception using errcode = '22023', message = 'Janela ou lease de preparação inválido';
  end if;

  return query
  with eligible as (
    select item.id,
      row_number() over (partition by item.organization_id order by item.execute_at, item.created_at, item.id) as org_position,
      row_number() over (partition by item.profile_id order by item.execute_at, item.created_at, item.id) as profile_position
    from public.publication_items item
    where item.pipeline_version = 2
      and item.status in ('waiting', 'ready')
      and item.creation_id is null
      and (item.execute_at is null
        or item.execute_at <= timezone('utc', now()) + make_interval(hours => p_window_hours))
      and item.preparation_status in ('pending', 'blocked', 'preparing')
      and (item.next_preparation_at is null or item.next_preparation_at <= timezone('utc', now()))
      and (item.preparation_lease_until is null or item.preparation_lease_until <= timezone('utc', now()))
  ), selected as (
    select eligible.id from eligible
    order by eligible.profile_position, eligible.org_position, eligible.id
    limit p_limit
  ), locked as (
    select item.id from public.publication_items item
    join selected on selected.id = item.id
    for update of item skip locked
  ), claimed as (
    update public.publication_items item
    set preparation_status = 'preparing',
        preparation_claimed_by = trim(p_worker_id),
        preparation_lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds)
    from locked
    where item.id = locked.id
    returning item.*
  )
  select claimed.id, claimed.organization_id, claimed.batch_id, claimed.profile_id,
    claimed.format, claimed.execute_at, claimed.caption, claimed.idempotency_key
  from claimed;
end;
$$;

create or replace function public.complete_publication_preparation(
  p_item_id uuid,
  p_worker_id text,
  p_ready boolean,
  p_error_code text default null,
  p_error_message text default null,
  p_retry_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_item public.publication_items%rowtype;
begin
  if p_retry_seconds not between 30 and 86400 then
    raise exception using errcode = '22023', message = 'Intervalo de nova preparação inválido';
  end if;
  update public.publication_items item
  set preparation_status = case when p_ready then 'ready' else 'blocked' end,
      prepared_at = case when p_ready then timezone('utc', now()) else null end,
      preparation_claimed_by = null,
      preparation_lease_until = null,
      next_preparation_at = case when p_ready then null else timezone('utc', now()) + make_interval(secs => p_retry_seconds) end,
      preparation_error_code = case when p_ready then null else left(nullif(trim(coalesce(p_error_code, '')), ''), 120) end,
      preparation_error_message = case when p_ready then null else left(nullif(trim(coalesce(p_error_message, '')), ''), 1200) end
  where item.id = p_item_id
    and item.pipeline_version = 2
    and item.preparation_status = 'preparing'
    and item.preparation_claimed_by = trim(p_worker_id)
    and item.preparation_lease_until > timezone('utc', now())
  returning item.* into updated_item;

  if updated_item.id is null then
    raise exception using errcode = '40001', message = 'Lease de preparação ausente ou expirado';
  end if;
  return jsonb_build_object('itemId', updated_item.id, 'status', updated_item.preparation_status);
end;
$$;

-- Claim v2 exige preparação local pronta para uma criação nova. Um creation_id
-- sempre permanece elegível para reconciliação e nunca é recriado.
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
language plpgsql
security definer
set search_path = public
as $$
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_limit not between 1 and 100 or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Limite ou lease de claim inválido';
  end if;

  return query
  with eligible as (
    select item.id, item.organization_id, item.profile_id, item.execute_at, item.created_at,
      row_number() over (partition by item.organization_id order by coalesce(item.execute_at, item.created_at), item.created_at, item.id) as org_position,
      row_number() over (partition by item.profile_id order by coalesce(item.execute_at, item.created_at), item.created_at, item.id) as profile_position
    from public.publication_items item
    where item.status in ('ready', 'waiting', 'preparing', 'failed')
      and (item.status <> 'failed' or (item.attempt_count < 5 and item.next_attempt_at is not null))
      and (item.execute_at is null or item.execute_at <= timezone('utc', now()))
      and (item.next_attempt_at is null or item.next_attempt_at <= timezone('utc', now()))
      and (item.lease_until is null or item.lease_until <= timezone('utc', now()))
      and (item.pipeline_version = 1 or item.creation_id is not null or item.preparation_status = 'ready')
      and not (coalesce(item.zernio_recovery_count, 0) > 0 and item.creation_id is null)
      and not exists (
        select 1 from public.publication_batch_circuit_breakers breaker
        where breaker.batch_id = item.batch_id and breaker.paused_at is not null
      )
      and not (
        item.pipeline_version = 1
        and item.creation_id is null
        and item.idempotency_key like 'bulk:%'
        and exists (
          select 1 from public.publication_slot_risk_incidents risk
          where risk.organization_id = item.organization_id
            and risk.batch_id = item.batch_id
            and risk.slot_execute_at = item.execute_at
            and risk.state = 'at_risk'
        )
      )
  ), selected as (
    select eligible.id from eligible
    order by eligible.profile_position, eligible.org_position,
      coalesce(eligible.execute_at, eligible.created_at), eligible.organization_id, eligible.id
    limit p_limit
  ), locked as (
    select item.id from public.publication_items item
    join selected on selected.id = item.id
    for update of item skip locked
  ), claimed as (
    update public.publication_items item
    set status = 'preparing', claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        next_attempt_at = null,
        attempt_count = item.attempt_count + case when item.creation_id is null or item.status = 'failed' then 1 else 0 end
    from locked where item.id = locked.id
    returning item.id, item.organization_id, item.batch_id, item.profile_id,
      item.format, item.status, item.execute_at, item.caption, item.idempotency_key,
      item.attempt_count, item.creation_id, item.lease_until
  ), updated_batches as (
    update public.publication_batches batch
    set status = 'processing'
    where batch.id in (select distinct claimed.batch_id from claimed)
      and batch.status in ('queued', 'validating')
  )
  select * from claimed;
end;
$$;

-- Em v2, 120 s é apenas um alerta agregado de SLA. O item permanece waiting/ready
-- e continua elegível ao claim. O fluxo legado continua responsável pelo corte
-- histórico anterior à implantação.
create or replace function public.recover_missed_publication_slots(
  p_max_items integer default 100,
  p_grace_seconds integer default 120,
  p_worker_id text default null,
  p_cycle_correlation_id uuid default null
)
returns table (
  id uuid, organization_id uuid, profile_id uuid,
  previous_execute_at timestamptz, execute_at timestamptz, outcome text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  item_row public.publication_items%rowtype;
  detected_at timestamptz := timezone('utc', now());
begin
  if p_max_items not between 1 and 500 or p_grace_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Limite ou margem de atraso inválido';
  end if;

  update public.publication_dispatch_sla_alerts alert
  set state = 'resolved', resolved_at = detected_at, last_detected_at = detected_at
  where alert.state = 'open'
    and not exists (
      select 1 from public.publication_items active_item
      where active_item.pipeline_version = 2
        and active_item.organization_id = alert.organization_id
        and active_item.batch_id = alert.batch_id
        and active_item.execute_at = alert.slot_execute_at
        and active_item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
        and (active_item.status <> 'failed' or active_item.next_attempt_at is not null)
    );

  for item_row in
    select source.* from public.publication_items source
    where source.pipeline_version = 2
      and source.status in ('waiting', 'ready')
      and source.execute_at is not null
      and source.execute_at <= detected_at - make_interval(secs => p_grace_seconds)
      and source.overdue_alerted_at is null
    order by source.execute_at, source.created_at, source.id
    for update skip locked limit p_max_items
  loop
    update public.publication_items item
    set overdue_alerted_at = detected_at
    where item.id = item_row.id and item.overdue_alerted_at is null;

    insert into public.publication_dispatch_sla_alerts (
      organization_id, batch_id, slot_execute_at, affected_item_count,
      max_overdue_seconds, first_detected_at, last_detected_at
    ) values (
      item_row.organization_id, item_row.batch_id, item_row.execute_at, 1,
      greatest(0, extract(epoch from (detected_at - item_row.execute_at))::integer), detected_at, detected_at
    ) on conflict (organization_id, batch_id, slot_execute_at) do update
      set affected_item_count = public.publication_dispatch_sla_alerts.affected_item_count + 1,
          max_overdue_seconds = greatest(public.publication_dispatch_sla_alerts.max_overdue_seconds, excluded.max_overdue_seconds),
          last_detected_at = excluded.last_detected_at,
          state = 'open', resolved_at = null;

    id := item_row.id; organization_id := item_row.organization_id;
    profile_id := item_row.profile_id; previous_execute_at := item_row.execute_at;
    execute_at := item_row.execute_at; outcome := 'overdue_sla_alerted';
    return next;
  end loop;

  -- Itens legados bulk atrasados permanecem bloqueados contra republicação.
  for item_row in
    select source.* from public.publication_items source
    where source.pipeline_version = 1
      and source.status in ('waiting', 'ready')
      and source.execute_at is not null
      and source.execute_at <= detected_at - make_interval(secs => p_grace_seconds)
      and (source.next_attempt_at is null or source.next_attempt_at <= detected_at)
      and (source.lease_until is null or source.lease_until <= detected_at)
      and source.creation_id is null
    order by source.execute_at, source.created_at, source.id
    for update skip locked limit p_max_items
  loop
    id := item_row.id; organization_id := item_row.organization_id;
    profile_id := item_row.profile_id; previous_execute_at := item_row.execute_at;
    execute_at := item_row.execute_at;

    if item_row.idempotency_key like 'bulk:%' then
      update public.publication_items item
      set status = 'ignored', claimed_by = null, lease_until = null,
          next_attempt_at = null, last_error_code = 'missed_bulk_slot_expired',
          last_error_message = 'O horário coletivo venceu antes da esteira v2; a postagem não será enviada atrasada.'
      where item.id = item_row.id and item.status in ('waiting', 'ready') and item.creation_id is null;
      if found then
        perform public.log_publication_item_event(
          item_row.id, 'ignored', item_row.status, 'ignored', null,
          coalesce(left(nullif(trim(p_worker_id), ''), 120), 'system: legacy-slot-expiry'),
          'missed_bulk_slot_expired',
          'O horário coletivo venceu antes da esteira v2; a postagem não será enviada atrasada.',
          jsonb_build_object('pipeline_version', 1, 'cutover_protected', true,
            'previous_execute_at', item_row.execute_at, 'cycle_correlation_id', p_cycle_correlation_id)
        );
        perform public.sync_publication_batch_status(item_row.batch_id);
      end if;
      outcome := 'ignored_bulk_slot_expired';
    else
      update public.publication_items item
      set status = 'failed', claimed_by = null, lease_until = null, next_attempt_at = null,
          last_error_code = 'legacy_missed_schedule_requires_attention',
          last_error_message = 'O item perdeu o horário antes da esteira v2 e não será republicado automaticamente.'
      where item.id = item_row.id;
      perform public.log_publication_item_event(
        item_row.id, 'failed', item_row.status, 'failed', null,
        'system: legacy-cutover-protection', 'legacy_missed_schedule_requires_attention',
        'O item perdeu o horário antes da esteira v2 e não será republicado automaticamente.',
        jsonb_build_object('pipeline_version', 1, 'cutover_protected', true,
          'previous_execute_at', item_row.execute_at)
      );
      perform public.sync_publication_batch_status(item_row.batch_id);
      outcome := 'requires_attention';
    end if;
    return next;
  end loop;
end;
$$;

revoke all on function public.claim_publication_preparation_items(text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_publication_preparation(uuid, text, boolean, text, text, integer) from public, anon, authenticated;
revoke all on function public.claim_publication_items(text, integer, integer) from public, anon, authenticated;
revoke all on function public.recover_missed_publication_slots(integer, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_publication_preparation_items(text, integer, integer, integer) to service_role;
grant execute on function public.complete_publication_preparation(uuid, text, boolean, text, text, integer) to service_role;
grant execute on function public.claim_publication_items(text, integer, integer) to service_role;
grant execute on function public.recover_missed_publication_slots(integer, integer, text, uuid) to service_role;

notify pgrst, 'reload schema';
