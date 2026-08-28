-- Entrega resiliente de mídia para Instagram via Zernio.
-- Prepara somente o arquivo; a postagem continua sendo criada pela Athena no horário.

create table public.zernio_prepared_media (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  media_asset_id uuid not null references public.media_assets(id) on delete cascade,
  source_storage_path text not null,
  status text not null default 'pending' check (status in ('pending', 'preparing', 'ready', 'failed')),
  public_url text,
  prepared_at timestamptz,
  expires_at timestamptz,
  claimed_by text,
  lease_until timestamptz,
  last_probe_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(last_probe_metadata) = 'object'),
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, media_asset_id),
  check (char_length(source_storage_path) between 1 and 1000),
  check (char_length(coalesce(public_url, '')) <= 2000),
  check (char_length(coalesce(claimed_by, '')) <= 120),
  check (char_length(coalesce(last_error_code, '')) <= 120),
  check (char_length(coalesce(last_error_message, '')) <= 1200)
);

create index zernio_prepared_media_expiry_idx
  on public.zernio_prepared_media (status, expires_at, organization_id);

alter table public.zernio_prepared_media enable row level security;
revoke all on table public.zernio_prepared_media from public, anon, authenticated;
grant all on table public.zernio_prepared_media to service_role;

-- Encaixa os agendamentos já existentes na preparação nova sem tocar em itens
-- cancelados, vencidos ou que já possuam criação externa.
update public.publication_items item
set preparation_status = 'pending', prepared_at = null,
    preparation_claimed_by = null, preparation_lease_until = null,
    next_preparation_at = null, preparation_error_code = null,
    preparation_error_message = null
from public.instagram_profiles profile
where profile.id = item.profile_id
  and profile.organization_id = item.organization_id
  and profile.provider = 'zernio'
  and item.pipeline_version = 2
  and item.status in ('waiting', 'ready')
  and item.creation_id is null
  and item.execute_at > timezone('utc', now());

create or replace function public.acquire_zernio_prepared_media(
  p_organization_id uuid,
  p_media_asset_id uuid,
  p_storage_path text,
  p_worker_id text,
  p_required_until timestamptz,
  p_force_refresh boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_at timestamptz := timezone('utc', now());
  prepared public.zernio_prepared_media%rowtype;
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if char_length(trim(coalesce(p_storage_path, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Caminho da mídia inválido';
  end if;
  if not exists (
    select 1 from public.media_assets asset
    where asset.id = p_media_asset_id
      and asset.organization_id = p_organization_id
      and asset.storage_path = trim(p_storage_path)
      and asset.status = 'ready'
      and asset.deleted_at is null
  ) then
    raise exception using errcode = 'P0002', message = 'Mídia pronta não encontrada na organização';
  end if;

  insert into public.zernio_prepared_media (organization_id, media_asset_id, source_storage_path)
  values (p_organization_id, p_media_asset_id, trim(p_storage_path))
  on conflict (organization_id, media_asset_id) do nothing;

  select prepared_media.* into prepared
  from public.zernio_prepared_media prepared_media
  where prepared_media.organization_id = p_organization_id and prepared_media.media_asset_id = p_media_asset_id
  for update;

  if not p_force_refresh
    and prepared.status = 'ready'
    and prepared.source_storage_path = trim(p_storage_path)
    and prepared.public_url is not null
    and prepared.expires_at > greatest(now_at, p_required_until)
  then
    return jsonb_build_object('action', 'ready', 'publicUrl', prepared.public_url, 'expiresAt', prepared.expires_at);
  end if;

  if prepared.status = 'preparing'
    and prepared.lease_until > now_at
    and prepared.claimed_by is distinct from trim(p_worker_id)
  then
    return jsonb_build_object('action', 'wait', 'leaseUntil', prepared.lease_until);
  end if;

  update public.zernio_prepared_media prepared_media
  set source_storage_path = trim(p_storage_path), status = 'preparing', public_url = null,
      prepared_at = null, expires_at = null, claimed_by = trim(p_worker_id),
      lease_until = now_at + interval '5 minutes', last_error_code = null,
      last_error_message = null, updated_at = now_at
  where prepared_media.organization_id = p_organization_id and prepared_media.media_asset_id = p_media_asset_id;

  return jsonb_build_object('action', 'prepare');
end;
$$;

create or replace function public.complete_zernio_prepared_media(
  p_organization_id uuid,
  p_media_asset_id uuid,
  p_worker_id text,
  p_public_url text default null,
  p_expires_at timestamptz default null,
  p_probe_metadata jsonb default '{}'::jsonb,
  p_error_code text default null,
  p_error_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_at timestamptz := timezone('utc', now());
  completed public.zernio_prepared_media%rowtype;
  succeeded boolean := nullif(trim(coalesce(p_public_url, '')), '') is not null
    and p_expires_at > now_at;
begin
  update public.zernio_prepared_media prepared_media
  set status = case when succeeded then 'ready' else 'failed' end,
      public_url = case when succeeded then trim(p_public_url) else null end,
      prepared_at = case when succeeded then now_at else null end,
      expires_at = case when succeeded then p_expires_at else null end,
      claimed_by = null, lease_until = null,
      last_probe_metadata = coalesce(p_probe_metadata, '{}'::jsonb),
      last_error_code = case when succeeded then null else left(coalesce(nullif(trim(p_error_code), ''), 'zernio_media_preparation_failed'), 120) end,
      last_error_message = case when succeeded then null else left(coalesce(nullif(trim(p_error_message), ''), 'Falha ao preparar mídia na Zernio.'), 1200) end,
      updated_at = now_at
  where prepared_media.organization_id = p_organization_id
    and prepared_media.media_asset_id = p_media_asset_id
    and prepared_media.status = 'preparing'
    and prepared_media.claimed_by = trim(p_worker_id)
    and prepared_media.lease_until > now_at
  returning prepared_media.* into completed;

  if completed.media_asset_id is null then
    raise exception using errcode = '40001', message = 'Lease de preparação de mídia ausente ou expirado';
  end if;
  return jsonb_build_object(
    'status', completed.status,
    'publicUrl', completed.public_url,
    'expiresAt', completed.expires_at
  );
end;
$$;

create or replace function public.reserve_zernio_same_post_media_retry(
  p_item_id uuid,
  p_worker_id text,
  p_creation_id text,
  p_error_code text,
  p_error_message text,
  p_window_seconds integer default 600
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_at timestamptz := timezone('utc', now());
  item_row public.publication_items%rowtype;
  deadline_at timestamptz;
begin
  if p_window_seconds not between 180 and 1800 then
    raise exception using errcode = '22023', message = 'Janela do retry de mídia inválida';
  end if;
  select item.* into item_row
  from public.publication_items item
  where item.id = p_item_id
    and item.claimed_by = trim(p_worker_id)
    and item.lease_until > now_at
    and item.status in ('preparing', 'publishing')
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker';
  end if;
  if item_row.creation_id is distinct from trim(p_creation_id) then
    raise exception using errcode = '22023', message = 'O post Zernio não corresponde ao item';
  end if;
  if coalesce(item_row.zernio_recovery_count, 0) >= 1 then
    return jsonb_build_object('reserved', false, 'reason', 'same_post_retry_already_used');
  end if;
  if coalesce(item_row.container_poll_count, 0) < 1 then
    return jsonb_build_object('reserved', false, 'reason', 'same_post_retry_requires_confirmation');
  end if;

  deadline_at := coalesce(item_row.provider_creation_started_at, item_row.execute_at, now_at)
    + make_interval(secs => p_window_seconds);
  if now_at > deadline_at then
    return jsonb_build_object('reserved', false, 'reason', 'same_post_retry_window_expired', 'deadlineAt', deadline_at);
  end if;

  update public.publication_items item
  set zernio_recovery_count = 1,
      last_error_code = left(coalesce(nullif(trim(p_error_code), ''), 'zernio_media_download_failed'), 120),
      last_error_message = left(coalesce(nullif(trim(p_error_message), ''), 'Instagram não conseguiu baixar a mídia.'), 1200)
  where item.id = item_row.id;

  perform public.log_publication_item_event(
    item_row.id, 'retry_requested', item_row.status, item_row.status, null, trim(p_worker_id),
    'zernio_same_post_media_retry',
    'A mídia foi renovada para repetir somente o mesmo post Zernio que falhou.',
    jsonb_build_object('creation_id', item_row.creation_id, 'deadline_at', deadline_at, 'creates_new_post', false)
  );
  return jsonb_build_object('reserved', true, 'deadlineAt', deadline_at, 'creationId', item_row.creation_id);
end;
$$;

revoke all on function public.acquire_zernio_prepared_media(uuid, uuid, text, text, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.complete_zernio_prepared_media(uuid, uuid, text, text, timestamptz, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.reserve_zernio_same_post_media_retry(uuid, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.acquire_zernio_prepared_media(uuid, uuid, text, text, timestamptz, boolean) to service_role;
grant execute on function public.complete_zernio_prepared_media(uuid, uuid, text, text, timestamptz, jsonb, text, text) to service_role;
grant execute on function public.reserve_zernio_same_post_media_retry(uuid, text, text, text, text, integer) to service_role;
