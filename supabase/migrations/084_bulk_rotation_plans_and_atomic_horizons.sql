-- Programação em massa rotativa: plano compacto, snapshots imutáveis e
-- reservas atômicas de horizonte. A materialização na fila será adicionada
-- em fase posterior; esta migration não altera o worker atual.

create table public.bulk_publication_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_by_email text check (created_by_email is null or char_length(trim(created_by_email)) between 3 and 320),
  batch_id uuid not null unique references public.publication_batches (id) on delete restrict,
  request_key text not null check (char_length(trim(request_key)) between 16 and 240),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  name text not null check (char_length(trim(name)) between 1 and 160),
  status text not null default 'queued' check (status in ('queued', 'generating', 'paused', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  format public.publication_format not null check (format in ('image', 'reel', 'story')),
  origin_type text not null check (origin_type in ('group', 'ungrouped')),
  origin_group_id uuid references public.profile_groups (id) on delete restrict,
  caption text check (caption is null or char_length(caption) <= 2200),
  interval_minutes integer not null check (interval_minutes > 0),
  duration_days bigint not null check (duration_days > 0),
  slots_per_profile bigint not null check (slots_per_profile > 0),
  order_mode text not null check (order_mode in ('same_order', 'diversified')),
  algorithm_version smallint not null default 1 check (algorithm_version = 1),
  rotation_seed text not null check (char_length(trim(rotation_seed)) between 1 and 240),
  profile_count bigint not null check (profile_count > 0),
  media_count bigint not null check (media_count > 0),
  expected_publications bigint not null check (expected_publications > 0),
  generated_publications bigint not null default 0 check (generated_publications >= 0),
  suspended_publications bigint not null default 0 check (suspended_publications >= 0),
  ignored_publications bigint not null default 0 check (ignored_publications >= 0),
  failed_publications bigint not null default 0 check (failed_publications >= 0),
  chunk_size integer not null default 500 check (chunk_size between 1 and 1000),
  expected_chunks bigint not null check (expected_chunks > 0),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, request_key),
  check ((origin_type = 'group' and origin_group_id is not null) or (origin_type = 'ungrouped' and origin_group_id is null)),
  check (generated_publications + suspended_publications + ignored_publications <= expected_publications),
  check (expected_chunks = profile_count)
);

create table public.bulk_publication_plan_profiles (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.bulk_publication_plans (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete restrict,
  ordinal bigint not null check (ordinal >= 0),
  status text not null default 'queued' check (status in ('queued', 'generating', 'suspended', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  schedule_base_at timestamptz not null,
  first_execute_at timestamptz not null,
  last_execute_at timestamptz not null,
  total_slot_count bigint not null check (total_slot_count > 0),
  next_slot_index bigint not null default 0 check (next_slot_index >= 0 and next_slot_index <= total_slot_count),
  generated_slot_count bigint not null default 0 check (generated_slot_count >= 0 and generated_slot_count <= total_slot_count),
  ignored_slot_count bigint not null default 0 check (ignored_slot_count >= 0 and ignored_slot_count <= total_slot_count),
  failed_slot_count bigint not null default 0 check (failed_slot_count >= 0 and failed_slot_count <= total_slot_count),
  rotation_offset bigint not null check (rotation_offset >= 0),
  suspended_at timestamptz,
  suspension_reason text check (suspension_reason is null or char_length(suspension_reason) <= 500),
  last_resumed_at timestamptz,
  resume_count integer not null default 0 check (resume_count >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (plan_id, profile_id),
  unique (plan_id, ordinal),
  check (first_execute_at > schedule_base_at),
  check (last_execute_at >= first_execute_at),
  check (generated_slot_count + ignored_slot_count <= total_slot_count)
);

create table public.bulk_publication_plan_media (
  plan_id uuid not null references public.bulk_publication_plans (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  media_asset_id uuid not null references public.media_assets (id) on delete restrict,
  ordinal bigint not null check (ordinal >= 0),
  kind public.media_asset_kind not null,
  storage_path text not null check (char_length(storage_path) between 10 and 500),
  eligible_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (plan_id, media_asset_id),
  unique (plan_id, ordinal)
);

create table public.bulk_publication_profile_horizons (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.bulk_publication_plans (id) on delete cascade,
  plan_profile_id uuid not null unique references public.bulk_publication_plan_profiles (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'released', 'cancelled', 'completed')),
  reserved_from timestamptz not null,
  first_execute_at timestamptz not null,
  reserved_through timestamptz not null,
  slot_count bigint not null check (slot_count > 0),
  released_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (plan_id, profile_id),
  check (first_execute_at > reserved_from),
  check (reserved_through >= first_execute_at),
  check ((status = 'active' and released_at is null) or status <> 'active')
);

create table public.bulk_publication_generation_chunks (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.bulk_publication_plans (id) on delete cascade,
  plan_profile_id uuid not null references public.bulk_publication_plan_profiles (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete restrict,
  chunk_ordinal bigint not null check (chunk_ordinal >= 0),
  slot_start bigint not null default 0 check (slot_start >= 0),
  slot_count bigint not null check (slot_count > 0),
  next_slot_index bigint not null check (next_slot_index >= slot_start and next_slot_index <= slot_start + slot_count),
  status text not null default 'queued' check (status in ('queued', 'processing', 'paused', 'completed', 'failed', 'cancelled')),
  generated_items bigint not null default 0 check (generated_items >= 0 and generated_items <= slot_count),
  ignored_items bigint not null default 0 check (ignored_items >= 0 and ignored_items <= slot_count),
  failed_items bigint not null default 0 check (failed_items >= 0 and failed_items <= slot_count),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claimed_by text check (claimed_by is null or char_length(trim(claimed_by)) between 3 and 120),
  lease_until timestamptz,
  last_error_message text check (last_error_message is null or char_length(last_error_message) <= 1200),
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (plan_id, chunk_ordinal),
  unique (plan_profile_id),
  check (generated_items + ignored_items <= slot_count)
);

create index bulk_publication_plans_org_status_created_idx
  on public.bulk_publication_plans (organization_id, status, created_at desc);
create index bulk_publication_plan_profiles_plan_ordinal_idx
  on public.bulk_publication_plan_profiles (plan_id, ordinal);
create index bulk_publication_plan_profiles_profile_status_idx
  on public.bulk_publication_plan_profiles (organization_id, profile_id, status, last_execute_at desc);
create index bulk_publication_plan_media_plan_ordinal_idx
  on public.bulk_publication_plan_media (plan_id, ordinal);
create index bulk_publication_horizons_profile_through_idx
  on public.bulk_publication_profile_horizons (organization_id, profile_id, reserved_through desc)
  where status = 'active';
create index bulk_publication_chunks_claim_idx
  on public.bulk_publication_generation_chunks (status, lease_until, created_at, chunk_ordinal)
  where status in ('queued', 'processing', 'failed');
create index bulk_publication_chunks_plan_progress_idx
  on public.bulk_publication_generation_chunks (plan_id, status, chunk_ordinal);

create trigger bulk_publication_plans_set_updated_at
before update on public.bulk_publication_plans
for each row execute function public.set_updated_at();
create trigger bulk_publication_plan_profiles_set_updated_at
before update on public.bulk_publication_plan_profiles
for each row execute function public.set_updated_at();
create trigger bulk_publication_horizons_set_updated_at
before update on public.bulk_publication_profile_horizons
for each row execute function public.set_updated_at();
create trigger bulk_publication_chunks_set_updated_at
before update on public.bulk_publication_generation_chunks
for each row execute function public.set_updated_at();

create or replace function public.enforce_bulk_publication_organization()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_table_name = 'bulk_publication_plans' then
    if not exists (
      select 1 from public.publication_batches batch_row
      where batch_row.id = new.batch_id and batch_row.organization_id = new.organization_id
    ) or (new.origin_group_id is not null and not exists (
      select 1 from public.profile_groups group_row
      where group_row.id = new.origin_group_id and group_row.organization_id = new.organization_id
        and group_row.deleted_at is null
    )) then raise exception using errcode = '23514', message = 'Plano, lote e origem devem pertencer à mesma organização.'; end if;
  elsif tg_table_name = 'bulk_publication_plan_profiles' then
    if not exists (
      select 1 from public.bulk_publication_plans plan_row
      join public.instagram_profiles profile_row on profile_row.id = new.profile_id
      where plan_row.id = new.plan_id and plan_row.organization_id = new.organization_id
        and profile_row.organization_id = new.organization_id and profile_row.deleted_at is null
    ) then raise exception using errcode = '23514', message = 'Plano e perfil devem pertencer à mesma organização.'; end if;
  elsif tg_table_name = 'bulk_publication_plan_media' then
    if not exists (
      select 1 from public.bulk_publication_plans plan_row
      join public.media_assets asset_row on asset_row.id = new.media_asset_id
      where plan_row.id = new.plan_id and plan_row.organization_id = new.organization_id
        and asset_row.organization_id = new.organization_id
    ) then raise exception using errcode = '23514', message = 'Plano e mídia devem pertencer à mesma organização.'; end if;
  elsif tg_table_name = 'bulk_publication_profile_horizons' then
    if not exists (
      select 1 from public.bulk_publication_plan_profiles profile_plan
      where profile_plan.id = new.plan_profile_id and profile_plan.plan_id = new.plan_id
        and profile_plan.profile_id = new.profile_id and profile_plan.organization_id = new.organization_id
    ) then raise exception using errcode = '23514', message = 'Horizonte não corresponde ao perfil do plano.'; end if;
  elsif tg_table_name = 'bulk_publication_generation_chunks' then
    if not exists (
      select 1 from public.bulk_publication_plan_profiles profile_plan
      where profile_plan.id = new.plan_profile_id and profile_plan.plan_id = new.plan_id
        and profile_plan.profile_id = new.profile_id and profile_plan.organization_id = new.organization_id
    ) then raise exception using errcode = '23514', message = 'Chunk não corresponde ao perfil do plano.'; end if;
  end if;
  return new;
end;
$$;

create trigger bulk_publication_plans_validate_organization
before insert or update on public.bulk_publication_plans
for each row execute function public.enforce_bulk_publication_organization();
create trigger bulk_publication_plan_profiles_validate_organization
before insert or update on public.bulk_publication_plan_profiles
for each row execute function public.enforce_bulk_publication_organization();
create trigger bulk_publication_plan_media_validate_organization
before insert or update on public.bulk_publication_plan_media
for each row execute function public.enforce_bulk_publication_organization();
create trigger bulk_publication_horizons_validate_organization
before insert or update on public.bulk_publication_profile_horizons
for each row execute function public.enforce_bulk_publication_organization();
create trigger bulk_publication_chunks_validate_organization
before insert or update on public.bulk_publication_generation_chunks
for each row execute function public.enforce_bulk_publication_organization();

alter table public.bulk_publication_plans enable row level security;
alter table public.bulk_publication_plan_profiles enable row level security;
alter table public.bulk_publication_plan_media enable row level security;
alter table public.bulk_publication_profile_horizons enable row level security;
alter table public.bulk_publication_generation_chunks enable row level security;

create policy bulk_publication_plans_select_member on public.bulk_publication_plans
for select to authenticated using (public.is_organization_member(organization_id));
create policy bulk_publication_plan_profiles_select_member on public.bulk_publication_plan_profiles
for select to authenticated using (public.is_organization_member(organization_id));
create policy bulk_publication_plan_media_select_member on public.bulk_publication_plan_media
for select to authenticated using (public.is_organization_member(organization_id));
create policy bulk_publication_horizons_select_member on public.bulk_publication_profile_horizons
for select to authenticated using (public.is_organization_member(organization_id));
create policy bulk_publication_chunks_select_member on public.bulk_publication_generation_chunks
for select to authenticated using (public.is_organization_member(organization_id));

revoke all on table public.bulk_publication_plans, public.bulk_publication_plan_profiles,
  public.bulk_publication_plan_media, public.bulk_publication_profile_horizons,
  public.bulk_publication_generation_chunks from public, anon, authenticated;
grant select on table public.bulk_publication_plans, public.bulk_publication_plan_profiles,
  public.bulk_publication_plan_media, public.bulk_publication_profile_horizons,
  public.bulk_publication_generation_chunks to authenticated;
grant all on table public.bulk_publication_plans, public.bulk_publication_plan_profiles,
  public.bulk_publication_plan_media, public.bulk_publication_profile_horizons,
  public.bulk_publication_generation_chunks to service_role;

create or replace function public.create_bulk_rotation_plan(
  p_organization_id uuid,
  p_request_key text,
  p_name text,
  p_profile_ids uuid[],
  p_origin_type text,
  p_origin_group_id uuid,
  p_format public.publication_format,
  p_interval_minutes integer,
  p_duration_days bigint,
  p_caption text,
  p_order_mode text,
  p_rotation_seed text,
  p_algorithm_version smallint default 1,
  p_chunk_size integer default 500,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_now timestamptz := coalesce(p_now, timezone('utc', now()));
  resolved_user_id uuid := auth.uid();
  clean_request_key text := trim(coalesce(p_request_key, ''));
  clean_name text := trim(coalesce(p_name, ''));
  clean_seed text := trim(coalesce(p_rotation_seed, ''));
  requested_profile_count bigint;
  online_profile_count bigint;
  resolved_media_count bigint;
  resolved_slots numeric;
  resolved_expected numeric;
  resolved_expected_chunks numeric;
  resolved_request_hash text;
  existing_plan public.bulk_publication_plans%rowtype;
  created_plan public.bulk_publication_plans%rowtype;
  created_batch public.publication_batches%rowtype;
  profile_record record;
  profile_plan public.bulk_publication_plan_profiles%rowtype;
  active_last timestamptz;
  reserved_last timestamptz;
  schedule_base timestamptz;
  first_execute timestamptz;
  last_execute timestamptz;
  media_seed_offset bigint;
begin
  if resolved_user_id is null or not public.has_organization_role(
    p_organization_id, array['admin', 'operator']::public.organization_role[]
  ) then raise exception using errcode = '42501', message = 'Ação não permitida.'; end if;
  if char_length(clean_request_key) not between 16 and 240 then
    raise exception using errcode = '22023', message = 'Chave de idempotência inválida.';
  end if;
  if char_length(clean_name) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'Nome do lote inválido.';
  end if;
  if p_profile_ids is null or cardinality(p_profile_ids) = 0 or array_position(p_profile_ids, null) is not null then
    raise exception using errcode = '22023', message = 'Selecione pelo menos um perfil válido.';
  end if;
  if p_origin_type not in ('group', 'ungrouped')
    or (p_origin_type = 'group' and p_origin_group_id is null)
    or (p_origin_type = 'ungrouped' and p_origin_group_id is not null) then
    raise exception using errcode = '22023', message = 'Origem de mídia inválida.';
  end if;
  if p_format not in ('image', 'reel', 'story') then
    raise exception using errcode = '22023', message = 'Formato inválido para programação em massa.';
  end if;
  if p_interval_minutes is null or p_interval_minutes < 1 then
    raise exception using errcode = '22023', message = 'Intervalo precisa ser um inteiro positivo.';
  end if;
  if p_duration_days is null or p_duration_days < 1 then
    raise exception using errcode = '22023', message = 'Duração precisa ser positiva.';
  end if;
  if p_caption is not null and char_length(p_caption) > 2200 then
    raise exception using errcode = '22023', message = 'Legenda excede 2.200 caracteres.';
  end if;
  if p_order_mode not in ('same_order', 'diversified') or clean_seed = '' or p_algorithm_version <> 1 then
    raise exception using errcode = '22023', message = 'Configuração de rotação inválida.';
  end if;
  if p_chunk_size not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Tamanho de chunk deve estar entre 1 e 1.000.';
  end if;

  resolved_request_hash := encode(extensions.digest(concat_ws('|', clean_name, p_origin_type, coalesce(p_origin_group_id::text, ''),
    p_format::text, p_interval_minutes::text, p_duration_days::text, coalesce(p_caption, ''), p_order_mode,
    clean_seed, p_algorithm_version::text, p_chunk_size::text,
    (select string_agg(value::text, ',' order by first_ordinal) from (
      select value, min(ordinality) as first_ordinal from unnest(p_profile_ids) with ordinality input(value, ordinality)
      group by value
    ) ordered_profiles)), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || clean_request_key, 0));
  select * into existing_plan from public.bulk_publication_plans
  where organization_id = p_organization_id and request_key = clean_request_key;
  if existing_plan.id is not null then
    if existing_plan.request_hash <> resolved_request_hash then
      raise exception using errcode = '23505', message = 'Chave de idempotência já usada com outro conteúdo.';
    end if;
    return jsonb_build_object('created', false, 'planId', existing_plan.id, 'batchId', existing_plan.batch_id,
      'profileCount', existing_plan.profile_count::text, 'mediaCount', existing_plan.media_count::text,
      'slotsPerProfile', existing_plan.slots_per_profile::text, 'expectedPublications', existing_plan.expected_publications::text);
  end if;

  resolved_slots := trunc((p_duration_days::numeric * 1440::numeric) / p_interval_minutes::numeric);
  if resolved_slots < 1 or resolved_slots > 9223372036854775807::numeric then
    raise exception using errcode = '22003', message = 'Quantidade de slots não cabe em bigint.';
  end if;

  select count(*)::bigint into requested_profile_count
  from (select distinct value from unnest(p_profile_ids) as input(value)) requested;
  select count(*)::bigint into online_profile_count
  from (select distinct value from unnest(p_profile_ids) as input(value)) requested
  join public.instagram_profiles profile_row on profile_row.id = requested.value
  where profile_row.organization_id = p_organization_id
    and profile_row.deleted_at is null and profile_row.status = 'online';
  if requested_profile_count <> online_profile_count then
    raise exception using errcode = 'P0001', message = 'O conjunto de perfis mudou; revise novamente antes de confirmar.';
  end if;

  if p_origin_type = 'group' and not exists (
    select 1 from public.profile_groups group_row where group_row.id = p_origin_group_id
      and group_row.organization_id = p_organization_id and group_row.deleted_at is null
  ) then raise exception using errcode = '23514', message = 'Grupo de origem inválido.'; end if;

  select count(*)::bigint into resolved_media_count
  from public.media_assets asset
  where asset.organization_id = p_organization_id
    and asset.deleted_at is null and asset.deletion_requested_at is null and asset.status = 'ready'
    and public.media_asset_has_storage_object(asset.storage_path)
    and (p_format = 'story' or (p_format = 'image' and asset.kind = 'image') or (p_format = 'reel' and asset.kind = 'video'))
    and ((p_origin_type = 'group' and exists (
      select 1 from public.media_group_assignments assignment
      where assignment.organization_id = p_organization_id and assignment.group_id = p_origin_group_id
        and assignment.media_asset_id = asset.id
    )) or (p_origin_type = 'ungrouped' and not exists (
      select 1 from public.media_group_assignments assignment
      where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id
    )));
  if resolved_media_count = 0 then
    raise exception using errcode = '22023', message = 'A origem não possui mídias elegíveis para o formato.';
  end if;

  resolved_expected := requested_profile_count::numeric * resolved_slots;
  resolved_expected_chunks := requested_profile_count::numeric;
  if resolved_expected > 9223372036854775807::numeric then
    raise exception using errcode = '22003', message = 'Projeção total não cabe em bigint.';
  end if;

  insert into public.publication_batches (organization_id, created_by, created_by_email, name, status, scheduled_for, review_confirmed_at)
  values (p_organization_id, resolved_user_id, nullif(auth.jwt() ->> 'email', ''), clean_name, 'queued', resolved_now, resolved_now)
  returning * into created_batch;

  insert into public.bulk_publication_plans (
    organization_id, created_by, created_by_email, batch_id, request_key, request_hash, name, format,
    origin_type, origin_group_id, caption, interval_minutes, duration_days, slots_per_profile,
    order_mode, algorithm_version, rotation_seed, profile_count, media_count, expected_publications,
    chunk_size, expected_chunks
  ) values (
    p_organization_id, resolved_user_id, nullif(auth.jwt() ->> 'email', ''), created_batch.id,
    clean_request_key, resolved_request_hash, clean_name, p_format, p_origin_type, p_origin_group_id,
    nullif(p_caption, ''), p_interval_minutes, p_duration_days, resolved_slots::bigint, p_order_mode,
    p_algorithm_version, clean_seed, requested_profile_count, resolved_media_count, resolved_expected::bigint,
    p_chunk_size, resolved_expected_chunks::bigint
  ) returning * into created_plan;

  insert into public.bulk_publication_plan_media (plan_id, organization_id, media_asset_id, ordinal, kind, storage_path)
  select created_plan.id, p_organization_id, eligible.id,
    (row_number() over (order by eligible.created_at, eligible.id) - 1)::bigint, eligible.kind, eligible.storage_path
  from public.media_assets eligible
  where eligible.organization_id = p_organization_id
    and eligible.deleted_at is null and eligible.deletion_requested_at is null and eligible.status = 'ready'
    and public.media_asset_has_storage_object(eligible.storage_path)
    and (p_format = 'story' or (p_format = 'image' and eligible.kind = 'image') or (p_format = 'reel' and eligible.kind = 'video'))
    and ((p_origin_type = 'group' and exists (
      select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id
        and assignment.group_id = p_origin_group_id and assignment.media_asset_id = eligible.id
    )) or (p_origin_type = 'ungrouped' and not exists (
      select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id
        and assignment.media_asset_id = eligible.id
    )));

  media_seed_offset := mod((hashtextextended(clean_seed, 0)::numeric + 9223372036854775808::numeric), resolved_media_count::numeric)::bigint;
  for profile_record in
    select requested.value as profile_id, (row_number() over (order by requested.first_ordinal) - 1)::bigint as ordinal
    from (
      select value, min(ordinality) as first_ordinal
      from unnest(p_profile_ids) with ordinality input(value, ordinality)
      group by value
    ) requested order by requested.first_ordinal
  loop
    perform pg_advisory_xact_lock(hashtextextended(profile_record.profile_id::text, 0));
    select max(item.execute_at) into active_last from public.publication_items item
    where item.organization_id = p_organization_id and item.profile_id = profile_record.profile_id
      and item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.execute_at is not null;
    select max(horizon.reserved_through) into reserved_last from public.bulk_publication_profile_horizons horizon
    where horizon.organization_id = p_organization_id and horizon.profile_id = profile_record.profile_id and horizon.status = 'active';
    schedule_base := greatest(resolved_now, coalesce(active_last, resolved_now), coalesce(reserved_last, resolved_now));
    begin
      first_execute := schedule_base + ((p_interval_minutes::text || ' minutes')::interval);
      last_execute := schedule_base + (((resolved_slots * p_interval_minutes::numeric)::text || ' minutes')::interval);
    exception when datetime_field_overflow then
      raise exception using errcode = '22008', message = 'Horizonte solicitado excede o intervalo de datas suportado.';
    end;

    insert into public.bulk_publication_plan_profiles (
      plan_id, organization_id, profile_id, ordinal, schedule_base_at, first_execute_at,
      last_execute_at, total_slot_count, rotation_offset
    ) values (
      created_plan.id, p_organization_id, profile_record.profile_id, profile_record.ordinal,
      schedule_base, first_execute, last_execute, resolved_slots::bigint,
      case when p_order_mode = 'same_order' then 0
        else mod(media_seed_offset + profile_record.ordinal, resolved_media_count)::bigint end
    ) returning * into profile_plan;

    insert into public.bulk_publication_profile_horizons (
      plan_id, plan_profile_id, organization_id, profile_id, reserved_from, first_execute_at, reserved_through, slot_count
    ) values (
      created_plan.id, profile_plan.id, p_organization_id, profile_record.profile_id,
      schedule_base, first_execute, last_execute, resolved_slots::bigint
    );

    insert into public.bulk_publication_generation_chunks (
      plan_id, plan_profile_id, organization_id, profile_id, chunk_ordinal, slot_start, slot_count, next_slot_index
    ) values (
      created_plan.id, profile_plan.id, p_organization_id, profile_record.profile_id,
      profile_record.ordinal, 0, resolved_slots::bigint, 0
    );
  end loop;

  return jsonb_build_object('created', true, 'planId', created_plan.id, 'batchId', created_plan.batch_id,
    'profileCount', created_plan.profile_count::text, 'mediaCount', created_plan.media_count::text,
    'slotsPerProfile', created_plan.slots_per_profile::text,
    'expectedPublications', created_plan.expected_publications::text,
    'firstExecuteAt', (select min(first_execute_at) from public.bulk_publication_plan_profiles where plan_id = created_plan.id),
    'lastExecuteAt', (select max(last_execute_at) from public.bulk_publication_plan_profiles where plan_id = created_plan.id));
end;
$$;

revoke all on function public.enforce_bulk_publication_organization() from public;
revoke all on function public.create_bulk_rotation_plan(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, text, text, text, smallint, integer, timestamptz) from public, anon;
grant execute on function public.create_bulk_rotation_plan(uuid, text, text, uuid[], text, uuid, public.publication_format, integer, bigint, text, text, text, smallint, integer, timestamptz) to authenticated, service_role;
