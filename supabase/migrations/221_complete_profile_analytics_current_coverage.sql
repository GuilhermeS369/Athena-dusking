-- Dashboard escalável — Fase F.
-- Garante uma linha compacta para todo perfil ativo e mantém o current state
-- coerente nos ciclos de inicialização e remoção lógica.

create or replace function public.initialize_profile_analytics_state(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_row public.instagram_profiles%rowtype;
  today date := (timezone('America/Sao_Paulo', now()))::date;
  initial_status public.profile_analytics_sync_status;
  initial_reason text;
begin
  select profile_source.* into profile_row
  from public.instagram_profiles as profile_source
  where profile_source.id = p_profile_id
    and profile_source.deleted_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'Perfil não encontrado';
  end if;

  if auth.role() <> 'service_role'
    and not public.is_service_role_request()
    and not public.has_organization_role(profile_row.organization_id, array['admin', 'operator']::public.organization_role[])
  then
    raise exception using errcode = '42501', message = 'Ação não permitida';
  end if;

  initial_status := case
    when profile_row.provider = 'meta_official' then 'not_configured'::public.profile_analytics_sync_status
    else 'pending'::public.profile_analytics_sync_status
  end;
  initial_reason := case
    when profile_row.provider = 'meta_official'
      then 'Meta oficial ainda não tem coleta de analytics configurada no Athena.'
    else null
  end;

  insert into public.profile_analytics_snapshots (
    organization_id, profile_id, provider, period_start, period_end,
    sync_status, unavailable_reason, synced_at
  ) values (
    profile_row.organization_id, profile_row.id, profile_row.provider,
    today - 29, today, initial_status, initial_reason, timezone('utc', now())
  )
  on conflict (organization_id, profile_id, provider, period_start, period_end)
  do update set
    deleted_at = null,
    sync_status = excluded.sync_status,
    unavailable_reason = excluded.unavailable_reason,
    synced_at = coalesce(public.profile_analytics_snapshots.synced_at, excluded.synced_at);

  insert into public.profile_analytics_current (
    organization_id, profile_id, provider, period_start, period_end,
    sync_status, unavailable_reason, deleted_at
  ) values (
    profile_row.organization_id, profile_row.id, profile_row.provider,
    today - 29, today, initial_status, initial_reason, null
  )
  on conflict (organization_id, profile_id) do update set
    provider = excluded.provider,
    sync_status = case
      when public.profile_analytics_current.current_synced_at is null
        then excluded.sync_status
      else public.profile_analytics_current.sync_status
    end,
    unavailable_reason = case
      when public.profile_analytics_current.current_synced_at is null
        then excluded.unavailable_reason
      else public.profile_analytics_current.unavailable_reason
    end,
    deleted_at = null;
end;
$$;

create or replace function public.soft_delete_profile_analytics(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_row public.instagram_profiles%rowtype;
  deleted_at_value timestamptz := timezone('utc', now());
begin
  select profile_source.* into profile_row
  from public.instagram_profiles as profile_source
  where profile_source.id = p_profile_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Perfil não encontrado';
  end if;

  if auth.role() <> 'service_role'
    and not public.is_service_role_request()
    and not public.has_organization_role(profile_row.organization_id, array['admin', 'operator']::public.organization_role[])
  then
    raise exception using errcode = '42501', message = 'Ação não permitida';
  end if;

  update public.profile_analytics_snapshots
  set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;

  update public.profile_follower_daily_snapshots
  set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;

  update public.profile_post_analytics_snapshots
  set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;

  update public.profile_analytics_sync_runs
  set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;

  update public.profile_analytics_current
  set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;
end;
$$;

create or replace function public.backfill_profile_analytics_current_placeholders(
  p_organization_id uuid,
  p_limit integer default 500,
  p_after_profile_id uuid default null
)
returns table (
  processed_count integer,
  last_profile_id uuid,
  has_more boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_limit not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Lote de placeholders deve estar entre 1 e 2000.';
  end if;

  with profiles as materialized (
    select profile.id, profile.organization_id, profile.provider
    from public.instagram_profiles profile
    left join public.profile_analytics_current current
      on current.organization_id = profile.organization_id
     and current.profile_id = profile.id
     and current.deleted_at is null
    where profile.organization_id = p_organization_id
      and profile.deleted_at is null
      and current.profile_id is null
      and (p_after_profile_id is null or profile.id > p_after_profile_id)
    order by profile.id
    limit p_limit
  ), upserted as (
    insert into public.profile_analytics_current (
      organization_id, profile_id, provider, sync_status, unavailable_reason, deleted_at
    )
    select
      profile.organization_id,
      profile.id,
      profile.provider,
      case when profile.provider = 'meta_official'
        then 'not_configured'::public.profile_analytics_sync_status
        else 'pending'::public.profile_analytics_sync_status
      end,
      case when profile.provider = 'meta_official'
        then 'Meta oficial ainda não tem coleta de analytics configurada no Athena.'
        else 'Aguardando a primeira coleta de analytics.'
      end,
      null
    from profiles profile
    on conflict (organization_id, profile_id) do update set
      provider = excluded.provider,
      sync_status = excluded.sync_status,
      unavailable_reason = excluded.unavailable_reason,
      deleted_at = null
    returning profile_id
  )
  select
    (select count(*)::integer from upserted),
    (select profile.id from profiles profile order by profile.id desc limit 1),
    exists (
      select 1
      from public.instagram_profiles profile
      left join public.profile_analytics_current current
        on current.organization_id = profile.organization_id
       and current.profile_id = profile.id
       and current.deleted_at is null
      where profile.organization_id = p_organization_id
        and profile.deleted_at is null
        and current.profile_id is null
        and profile.id > coalesce(
          (select candidate.id from profiles candidate order by candidate.id desc limit 1),
          p_after_profile_id
        )
    )
  into processed_count, last_profile_id, has_more;
  return next;
end;
$$;

revoke all on function public.backfill_profile_analytics_current_placeholders(uuid, integer, uuid)
from public, anon, authenticated;
grant execute on function public.backfill_profile_analytics_current_placeholders(uuid, integer, uuid)
to service_role;

notify pgrst, 'reload schema';
