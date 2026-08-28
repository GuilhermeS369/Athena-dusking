-- Filtro escalável de incidentes por grupo, sem transportar milhares de IDs
-- pelo navegador ou pela URL do PostgREST.

create or replace function public.get_instagram_group_observability_incident_ids(
  p_organization_id uuid,
  p_group_id uuid,
  p_group_mode text default 'origin'
) returns table (incident_id uuid)
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Permissão insuficiente.';
  end if;
  if p_group_mode not in ('origin', 'current') then
    raise exception using errcode = '22023', message = 'Modo de grupo inválido.';
  end if;
  if not exists (select 1 from public.profile_groups group_row where group_row.id = p_group_id and group_row.organization_id = p_organization_id) then
    raise exception using errcode = 'P0002', message = 'Grupo não encontrado.';
  end if;
  if p_group_mode = 'origin' then
    return query select distinct event.incident_id
    from public.instagram_observability_events event
    where event.organization_id = p_organization_id and event.source_group_id = p_group_id
      and event.incident_id is not null and event.occurred_at >= timezone('utc', now()) - interval '14 days';
  else
    return query select distinct profile.incident_id
    from public.instagram_observability_incident_profiles profile
    join public.profile_group_members member on member.profile_id = profile.profile_id
    join public.instagram_observability_incidents incident on incident.id = profile.incident_id
    where member.organization_id = p_organization_id and member.group_id = p_group_id
      and incident.organization_id = p_organization_id;
  end if;
end;
$$;

revoke all on function public.get_instagram_group_observability_incident_ids(uuid, uuid, text) from public, anon;
grant execute on function public.get_instagram_group_observability_incident_ids(uuid, uuid, text) to authenticated, service_role;
