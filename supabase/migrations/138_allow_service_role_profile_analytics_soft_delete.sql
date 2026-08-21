-- O encerramento automático Meta chama a limpeza de analytics dentro de uma
-- RPC service-role. Reconhece explicitamente auth.role(), além do helper legado.

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

  update public.profile_analytics_snapshots set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;

  update public.profile_follower_daily_snapshots set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;

  update public.profile_post_analytics_snapshots set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;

  update public.profile_analytics_sync_runs set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;
end;
$$;

notify pgrst, 'reload schema';
