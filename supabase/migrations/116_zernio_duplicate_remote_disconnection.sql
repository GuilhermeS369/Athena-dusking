-- Resolução auditável de duplicidade remota. A sincronização detecta a cópia
-- excedente, mas o worker de reciclagem existente continua sendo o único
-- componente autorizado a executar o DELETE na Zernio.

alter table public.zernio_profile_disconnection_incidents
  drop constraint if exists zernio_profile_disconnection_incidents_signal_check;

alter table public.zernio_profile_disconnection_incidents
  add constraint zernio_profile_disconnection_incidents_signal_check
  check (signal in ('account_disconnected', 'auth_expired', 'duplicate_identity_auto_removed'));

alter table public.zernio_profile_disconnection_incidents
  drop constraint if exists zernio_profile_disconnection_incidents_source_check;

alter table public.zernio_profile_disconnection_incidents
  add constraint zernio_profile_disconnection_incidents_source_check
  check (source in ('publication_worker', 'historical_backfill', 'zernio_sync_worker'));

-- A cópia pode existir apenas na API remota, pois a proteção de identidade
-- bloqueia sua criação local. Nessa situação, não há profile_id excedente para
-- apagar e o incidente ainda precisa ser rastreável até a remoção remota.
alter table public.zernio_profile_disconnection_incidents
  alter column profile_id drop not null;

create unique index zernio_duplicate_identity_remote_incident_unique_idx
  on public.zernio_profile_disconnection_incidents (organization_id, zernio_connection_id, zernio_account_id)
  where signal = 'duplicate_identity_auto_removed';

create or replace function public.schedule_zernio_duplicate_identity_disconnection(
  p_organization_id uuid,
  p_zernio_connection_id uuid,
  p_zernio_account_id text,
  p_username text,
  p_retained_profile_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  identity_value text := lower(nullif(trim(regexp_replace(p_username, '^@', '')), ''));
  connection_row public.zernio_connections%rowtype;
  retained_profile public.instagram_profiles%rowtype;
  incident_row public.zernio_profile_disconnection_incidents%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  if identity_value is null or nullif(trim(p_zernio_account_id), '') is null then
    raise exception using errcode = '22023', message = 'Identidade ou accountId Zernio inválido.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(identity_value, 0));

  select * into connection_row from public.zernio_connections
  where id = p_zernio_connection_id and organization_id = p_organization_id and deleted_at is null
  for update;
  if not found then raise exception 'Conexão Zernio ativa não encontrada.'; end if;

  select * into retained_profile from public.instagram_profiles
  where id = p_retained_profile_id and provider = 'zernio' and deleted_at is null
  for update;
  if not found then raise exception 'Perfil canônico não encontrado.'; end if;
  if retained_profile.organization_id <> p_organization_id then
    raise exception 'Conflito entre organizações requer aprovação explícita; remoção automática bloqueada.';
  end if;
  if lower(trim(regexp_replace(retained_profile.username, '^@', ''))) <> identity_value then
    raise exception 'O perfil canônico não corresponde à identidade informada.';
  end if;

  if retained_profile.zernio_connection_id = p_zernio_connection_id
    and retained_profile.zernio_account_id = trim(p_zernio_account_id) then
    raise exception 'A conta excedente não pode ser o próprio perfil canônico.';
  end if;

  -- O perfil canônico é o único vínculo local desta identidade. Se ele estiver
  -- em publicação, não removemos a cópia remota até que a operação termine.
  if exists (
    select 1 from public.publication_items item
    where item.organization_id = p_organization_id and item.profile_id = retained_profile.id
      and item.status in ('preparing', 'publishing')
  ) then
    return jsonb_build_object('scheduled', false, 'reason', 'active_publication');
  end if;

  insert into public.zernio_profile_disconnection_incidents (
    organization_id, profile_id, zernio_connection_id, zernio_account_id,
    username_snapshot, connection_label_snapshot, signal, source, error_code,
    error_message
  ) values (
    p_organization_id, null, p_zernio_connection_id, trim(p_zernio_account_id),
    identity_value, connection_row.label, 'duplicate_identity_auto_removed',
    'zernio_sync_worker', 'zernio_duplicate_identity_auto_removed',
    left(format('Remoção intencional: @%s já está preservado na chave %s (perfil %s).', identity_value, coalesce((select label from public.zernio_connections where id = retained_profile.zernio_connection_id), 'canônica'), retained_profile.id), 1200)
  ) on conflict (organization_id, zernio_connection_id, zernio_account_id) where signal = 'duplicate_identity_auto_removed' do update
    set updated_at = timezone('utc', now())
  returning * into incident_row;

  insert into public.zernio_profile_recycling_jobs (organization_id, incident_id)
  values (p_organization_id, incident_row.id)
  on conflict (incident_id) do nothing;

  return jsonb_build_object(
    'scheduled', true,
    'incidentId', incident_row.id,
    'retainedProfileId', retained_profile.id,
    'duplicateProfileId', null
  );
end;
$$;

revoke all on function public.schedule_zernio_duplicate_identity_disconnection(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.schedule_zernio_duplicate_identity_disconnection(uuid, uuid, text, text, uuid) to service_role;
