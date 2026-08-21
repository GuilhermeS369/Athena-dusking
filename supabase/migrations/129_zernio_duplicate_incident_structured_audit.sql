-- Fase 4B: estrutura a decisão canônica de duplicidade em colunas próprias.
-- Os snapshots não dependem de error_message e continuam legíveis mesmo se
-- perfil/conexão forem posteriormente renomeados ou removidos.

alter table public.zernio_profile_disconnection_incidents
  add column normalized_identity text
    check (normalized_identity is null or char_length(normalized_identity) between 1 and 160),
  add column retained_zernio_connection_id uuid,
  add column retained_zernio_account_id text
    check (retained_zernio_account_id is null or char_length(trim(retained_zernio_account_id)) between 1 and 160),
  add column retained_connection_label_snapshot text
    check (retained_connection_label_snapshot is null or char_length(retained_connection_label_snapshot) <= 500),
  add column removed_zernio_connection_id uuid,
  add column removed_zernio_account_id text
    check (removed_zernio_account_id is null or char_length(trim(removed_zernio_account_id)) between 1 and 160),
  add column removed_connection_label_snapshot text
    check (removed_connection_label_snapshot is null or char_length(removed_connection_label_snapshot) <= 500),
  add column canonical_rule text
    check (canonical_rule is null or char_length(canonical_rule) between 1 and 160);

create or replace function public.populate_zernio_duplicate_incident_audit_fields()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  retained_profile public.instagram_profiles%rowtype;
  retained_connection_label text;
begin
  if new.signal <> 'duplicate_identity_auto_removed' then
    return new;
  end if;

  new.normalized_identity := coalesce(
    new.normalized_identity,
    lower(nullif(trim(regexp_replace(new.username_snapshot, '^@', '')), ''))
  );
  new.removed_zernio_connection_id := coalesce(
    new.removed_zernio_connection_id,
    new.zernio_connection_id
  );
  new.removed_zernio_account_id := coalesce(
    new.removed_zernio_account_id,
    nullif(trim(new.zernio_account_id), '')
  );
  new.removed_connection_label_snapshot := coalesce(
    new.removed_connection_label_snapshot,
    new.connection_label_snapshot
  );
  new.canonical_rule := coalesce(
    new.canonical_rule,
    'existing_local_profile_same_organization'
  );

  if new.retained_profile_id is not null
    and (
      new.retained_zernio_connection_id is null
      or new.retained_zernio_account_id is null
      or new.retained_connection_label_snapshot is null
    ) then
    select profile.* into retained_profile
    from public.instagram_profiles profile
    where profile.id = new.retained_profile_id;

    if found then
      select connection.label into retained_connection_label
      from public.zernio_connections connection
      where connection.id = retained_profile.zernio_connection_id;

      new.retained_zernio_connection_id := coalesce(
        new.retained_zernio_connection_id,
        retained_profile.zernio_connection_id
      );
      new.retained_zernio_account_id := coalesce(
        new.retained_zernio_account_id,
        nullif(trim(retained_profile.zernio_account_id), '')
      );
      new.retained_connection_label_snapshot := coalesce(
        new.retained_connection_label_snapshot,
        retained_connection_label,
        'Conexão canônica indisponível'
      );
    end if;
  end if;

  return new;
end;
$$;

create trigger zernio_duplicate_incidents_populate_audit_fields
before insert or update of
  signal, username_snapshot, zernio_connection_id, zernio_account_id,
  connection_label_snapshot, retained_profile_id
on public.zernio_profile_disconnection_incidents
for each row execute function public.populate_zernio_duplicate_incident_audit_fields();

-- Backfill do incidente real criado durante a validação da Fase 4A e de
-- qualquer ocorrência histórica de duplicidade que já possua perfil canônico.
update public.zernio_profile_disconnection_incidents incident
set retained_profile_id = incident.retained_profile_id
where incident.signal = 'duplicate_identity_auto_removed';

create policy zernio_profile_recycling_jobs_select_member
  on public.zernio_profile_recycling_jobs for select to authenticated
  using (public.is_organization_member(organization_id));

grant select on public.zernio_profile_recycling_jobs to authenticated;

notify pgrst, 'reload schema';
