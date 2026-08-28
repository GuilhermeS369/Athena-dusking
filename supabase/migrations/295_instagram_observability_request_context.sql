create or replace function public.get_instagram_operation_context(
  p_requested_organization_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  selected_context record;
begin
  if actor_id is null or coalesce(auth.role(), '') <> 'authenticated' then
    return null;
  end if;

  select
    organization.id,
    organization.name,
    organization.slug,
    organization.timezone,
    membership.role
  into selected_context
  from public.organization_members as membership
  join public.organizations as organization
    on organization.id = membership.organization_id
  where membership.user_id = actor_id
    and organization.deleted_at is null
  order by
    case when organization.id = p_requested_organization_id then 0 else 1 end,
    membership.joined_at asc,
    organization.id asc
  limit 1;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'userId', actor_id,
    'email', nullif(auth.jwt() ->> 'email', ''),
    'activeOrganization', jsonb_build_object(
      'id', selected_context.id,
      'name', selected_context.name,
      'slug', selected_context.slug,
      'timezone', selected_context.timezone,
      'role', selected_context.role
    )
  );
end;
$$;

revoke all on function public.get_instagram_operation_context(uuid) from public;
grant execute on function public.get_instagram_operation_context(uuid) to authenticated;

comment on function public.get_instagram_operation_context(uuid) is
  'Resolves the authenticated Instagram operation user and active organization in one database round trip.';
