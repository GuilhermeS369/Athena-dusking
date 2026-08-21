-- Impede que uma credencial Zernio ativa seja cadastrada mais de uma vez.
-- O fingerprint é um HMAC calculado no servidor; a API key não é exposta.

alter table public.zernio_connections
  add column api_key_fingerprint text
    check (api_key_fingerprint is null or api_key_fingerprint ~ '^[0-9a-f]{64}$');

alter table public.zernio_connection_import_items
  add column api_key_fingerprint text
    check (api_key_fingerprint is null or api_key_fingerprint ~ '^[0-9a-f]{64}$');

-- Registros legados permanecem nulos para a migration não escolher
-- automaticamente entre credenciais antigas já duplicadas. Toda nova escrita
-- recebe fingerprint e passa a ser protegida estruturalmente.
create unique index zernio_connections_api_key_fingerprint_active_idx
  on public.zernio_connections (api_key_fingerprint)
  where deleted_at is null and api_key_fingerprint is not null;

create table public.zernio_api_key_claims (
  api_key_fingerprint text primary key check (api_key_fingerprint ~ '^[0-9a-f]{64}$'),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  label text not null check (char_length(trim(label)) between 2 and 80),
  owner_token uuid not null,
  import_item_id uuid unique references public.zernio_connection_import_items(id) on delete cascade,
  connection_id uuid unique references public.zernio_connections(id) on delete cascade,
  expires_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (
    (connection_id is not null and import_item_id is null and expires_at is null)
    or (connection_id is null and expires_at is not null)
  )
);

create index zernio_api_key_claims_org_idx
  on public.zernio_api_key_claims (organization_id, updated_at desc);

create trigger zernio_api_key_claims_set_updated_at
before update on public.zernio_api_key_claims
for each row execute function public.set_updated_at();

alter table public.zernio_api_key_claims enable row level security;
revoke all on public.zernio_api_key_claims from public, anon, authenticated;
grant all on public.zernio_api_key_claims to service_role;

create or replace function public.claim_zernio_api_key(
  p_organization_id uuid,
  p_api_key_fingerprint text,
  p_label text,
  p_owner_token uuid,
  p_import_item_id uuid default null,
  p_lease_seconds integer default 86400
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_row public.zernio_api_key_claims%rowtype;
  lease_seconds integer := greatest(300, least(coalesce(p_lease_seconds, 86400), 604800));
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  if p_api_key_fingerprint is null or p_api_key_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Fingerprint de API key inválido.';
  end if;

  delete from public.zernio_api_key_claims
  where api_key_fingerprint = p_api_key_fingerprint
    and connection_id is null
    and expires_at <= timezone('utc', now());

  insert into public.zernio_api_key_claims (
    api_key_fingerprint, organization_id, label, owner_token,
    import_item_id, expires_at
  ) values (
    p_api_key_fingerprint, p_organization_id, trim(p_label), p_owner_token,
    p_import_item_id, timezone('utc', now()) + make_interval(secs => lease_seconds)
  )
  on conflict (api_key_fingerprint) do nothing;

  select * into claimed_row
  from public.zernio_api_key_claims
  where api_key_fingerprint = p_api_key_fingerprint;

  if claimed_row.owner_token = p_owner_token
     and claimed_row.organization_id = p_organization_id
     and claimed_row.import_item_id is not distinct from p_import_item_id then
    update public.zernio_api_key_claims
    set expires_at = timezone('utc', now()) + make_interval(secs => lease_seconds)
    where api_key_fingerprint = p_api_key_fingerprint
      and connection_id is null;

    return jsonb_build_object('claimed', true, 'existingLabel', null);
  end if;

  return jsonb_build_object(
    'claimed', false,
    'existingLabel', case
      when claimed_row.organization_id = p_organization_id then claimed_row.label
      else null
    end
  );
end;
$$;

create or replace function public.finalize_zernio_api_key_claim(
  p_api_key_fingerprint text,
  p_owner_token uuid,
  p_connection_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  finalized boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  update public.zernio_api_key_claims
  set connection_id = p_connection_id,
      import_item_id = null,
      expires_at = null
  where api_key_fingerprint = p_api_key_fingerprint
    and owner_token = p_owner_token
    and connection_id is null
  returning true into finalized;

  return coalesce(finalized, false);
end;
$$;

create or replace function public.release_zernio_api_key_claim(
  p_api_key_fingerprint text,
  p_owner_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  released boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  delete from public.zernio_api_key_claims
  where api_key_fingerprint = p_api_key_fingerprint
    and owner_token = p_owner_token
    and connection_id is null
  returning true into released;

  return coalesce(released, false);
end;
$$;

create or replace function public.release_deleted_zernio_api_key_claim()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    delete from public.zernio_api_key_claims where connection_id = new.id;
  end if;
  return new;
end;
$$;

create trigger zernio_connections_release_deleted_api_key_claim
after update of deleted_at on public.zernio_connections
for each row
when (old.deleted_at is null and new.deleted_at is not null)
execute function public.release_deleted_zernio_api_key_claim();

create or replace function public.create_zernio_connection_import_batch(
  p_organization_id uuid,
  p_created_by uuid,
  p_items jsonb
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  new_batch_id uuid;
  item_count integer;
  default_slot_limit integer;
  imported_item record;
  claim_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'O lote precisa conter ao menos uma linha válida.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    where coalesce(item ->> 'apiKeyFingerprint', '') !~ '^[0-9a-f]{64}$'
  ) then
    raise exception using errcode = '22023', message = 'O lote contém fingerprint de API key inválido.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    group by item ->> 'apiKeyFingerprint'
    having count(*) > 1
  ) then
    raise exception using errcode = '23505', message = 'O lote contém API key repetida.';
  end if;

  select count(*) into item_count from jsonb_array_elements(p_items) as item;
  select coalesce(setting.default_instagram_slot_limit, 2)
  into default_slot_limit
  from (select p_organization_id as organization_id) requested
  left join public.zernio_multi_connection_settings setting
    on setting.organization_id = requested.organization_id;

  insert into public.zernio_connection_import_batches (
    organization_id, created_by, total_count, default_instagram_slot_limit_snapshot
  ) values (
    p_organization_id, p_created_by, item_count, default_slot_limit
  ) returning id into new_batch_id;

  insert into public.zernio_connection_import_items (
    batch_id, organization_id, line_number, label, encrypted_api_key,
    api_key_fingerprint, instagram_slot_limit_snapshot
  )
  select new_batch_id, p_organization_id, (item.value ->> 'lineNumber')::integer,
    item.value ->> 'label', item.value ->> 'encryptedApiKey',
    item.value ->> 'apiKeyFingerprint', default_slot_limit
  from jsonb_array_elements(p_items) as item;

  for imported_item in
    select id, line_number, label, api_key_fingerprint
    from public.zernio_connection_import_items
    where batch_id = new_batch_id
    order by line_number
  loop
    claim_result := public.claim_zernio_api_key(
      p_organization_id,
      imported_item.api_key_fingerprint,
      imported_item.label,
      imported_item.id,
      imported_item.id,
      86400
    );
    if coalesce((claim_result ->> 'claimed')::boolean, false) is not true then
      raise exception using
        errcode = '23505',
        message = format(
          'API key da linha %s já está cadastrada%s.',
          imported_item.line_number,
          case when claim_result ->> 'existingLabel' is not null
            then format(' na conta Zernio “%s”', claim_result ->> 'existingLabel')
            else ' em outra conta Zernio'
          end
        );
    end if;
  end loop;

  return new_batch_id;
end;
$$;

revoke all on function public.claim_zernio_api_key(uuid, text, text, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.finalize_zernio_api_key_claim(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_zernio_api_key_claim(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_zernio_api_key(uuid, text, text, uuid, uuid, integer) to service_role;
grant execute on function public.finalize_zernio_api_key_claim(text, uuid, uuid) to service_role;
grant execute on function public.release_zernio_api_key_claim(text, uuid) to service_role;

notify pgrst, 'reload schema';
