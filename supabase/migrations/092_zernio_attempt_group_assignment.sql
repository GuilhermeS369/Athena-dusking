-- Persiste o grupo desejado na tentativa Zernio e associa os perfis somente
-- depois que eles já existem no Athena. A função é idempotente e serializa
-- associações concorrentes dos mesmos perfis por meio de locks de linha.

alter table public.zernio_connection_attempts
  add column requested_group_id uuid references public.profile_groups (id) on delete set null,
  add column requested_group_name text check (
    requested_group_name is null
    or char_length(requested_group_name) between 1 and 120
  ),
  add column group_assignment_status text not null default 'not_requested' check (
    group_assignment_status in ('not_requested', 'pending', 'assigned', 'failed')
  ),
  add column group_assigned_profile_ids uuid[] not null default '{}'::uuid[],
  add column group_assignment_error text,
  add column group_assignment_completed_at timestamptz;

create index zernio_connection_attempts_pending_group_idx
  on public.zernio_connection_attempts (organization_id, group_assignment_status, created_at)
  where group_assignment_status = 'pending';

create or replace function public.assign_zernio_attempt_profiles_to_group(
  p_organization_id uuid,
  p_attempt_id uuid,
  p_profile_ids uuid[],
  p_added_by uuid
)
returns table (
  assignment_status text,
  assigned_profile_ids uuid[],
  error_message text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  attempt_row public.zernio_connection_attempts%rowtype;
  clean_profile_ids uuid[];
  valid_profile_ids uuid[];
  conflicting_profile_ids uuid[];
begin
  select *
  into attempt_row
  from public.zernio_connection_attempts
  where id = p_attempt_id
    and organization_id = p_organization_id
  for update;

  if not found then
    return query select 'failed'::text, '{}'::uuid[], 'Tentativa Zernio não encontrada.'::text;
    return;
  end if;

  if attempt_row.requested_group_id is null then
    update public.zernio_connection_attempts
    set group_assignment_status = 'not_requested',
        group_assigned_profile_ids = '{}'::uuid[],
        group_assignment_error = null,
        group_assignment_completed_at = timezone('utc', now())
    where id = p_attempt_id;
    return query select 'not_requested'::text, '{}'::uuid[], null::text;
    return;
  end if;

  if not exists (
    select 1
    from public.profile_groups
    where id = attempt_row.requested_group_id
      and organization_id = p_organization_id
      and name = attempt_row.requested_group_name
      and deleted_at is null
  ) then
    update public.zernio_connection_attempts
    set group_assignment_status = 'failed',
        group_assignment_error = 'O grupo solicitado não existe mais ou teve o nome alterado.',
        group_assignment_completed_at = timezone('utc', now())
    where id = p_attempt_id;
    return query select 'failed'::text, '{}'::uuid[], 'O grupo solicitado não existe mais ou teve o nome alterado.'::text;
    return;
  end if;

  select coalesce(array_agg(distinct profile_id order by profile_id), '{}'::uuid[])
  into clean_profile_ids
  from unnest(coalesce(p_profile_ids, '{}'::uuid[])) as ids(profile_id);

  -- Serializa tentativas simultâneas que porventura apontem para o mesmo perfil.
  perform 1
  from public.instagram_profiles
  where organization_id = p_organization_id
    and id = any(clean_profile_ids)
    and provider = 'zernio'
    and deleted_at is null
  order by id
  for update;

  select coalesce(array_agg(id order by id), '{}'::uuid[])
  into valid_profile_ids
  from public.instagram_profiles
  where organization_id = p_organization_id
    and id = any(clean_profile_ids)
    and provider = 'zernio'
    and deleted_at is null;

  if cardinality(valid_profile_ids) <> cardinality(clean_profile_ids) then
    update public.zernio_connection_attempts
    set group_assignment_status = 'failed',
        group_assignment_error = 'Um ou mais perfis sincronizados não são válidos para esta organização.',
        group_assignment_completed_at = timezone('utc', now())
    where id = p_attempt_id;
    return query select 'failed'::text, '{}'::uuid[], 'Um ou mais perfis sincronizados não são válidos para esta organização.'::text;
    return;
  end if;

  select coalesce(array_agg(profile_id order by profile_id), '{}'::uuid[])
  into conflicting_profile_ids
  from public.profile_group_members
  where organization_id = p_organization_id
    and profile_id = any(valid_profile_ids)
    and group_id <> attempt_row.requested_group_id;

  if cardinality(conflicting_profile_ids) > 0 then
    update public.zernio_connection_attempts
    set group_assignment_status = 'failed',
        group_assignment_error = 'Um ou mais perfis já pertencem a outro grupo.',
        group_assignment_completed_at = timezone('utc', now())
    where id = p_attempt_id;
    return query select 'failed'::text, '{}'::uuid[], 'Um ou mais perfis já pertencem a outro grupo.'::text;
    return;
  end if;

  insert into public.profile_group_members (organization_id, group_id, profile_id, added_by)
  select p_organization_id, attempt_row.requested_group_id, profile_id, p_added_by
  from unnest(valid_profile_ids) as ids(profile_id)
  on conflict (group_id, profile_id) do nothing;

  update public.zernio_connection_attempts
  set group_assignment_status = 'assigned',
      group_assigned_profile_ids = valid_profile_ids,
      group_assignment_error = null,
      group_assignment_completed_at = timezone('utc', now())
  where id = p_attempt_id;

  return query select 'assigned'::text, valid_profile_ids, null::text;
exception
  when others then
    update public.zernio_connection_attempts
    set group_assignment_status = 'failed',
        group_assignment_error = left(sqlerrm, 1000),
        group_assignment_completed_at = timezone('utc', now())
    where id = p_attempt_id;
    return query select 'failed'::text, '{}'::uuid[], left(sqlerrm, 1000)::text;
end;
$$;

revoke all on function public.assign_zernio_attempt_profiles_to_group(uuid, uuid, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.assign_zernio_attempt_profiles_to_group(uuid, uuid, uuid[], uuid) to service_role;
