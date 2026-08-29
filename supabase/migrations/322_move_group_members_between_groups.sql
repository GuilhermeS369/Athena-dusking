-- Move perfis de um grupo para outro em uma unica operacao atomica, sem passar
-- pelo estado intermediario "sem grupo" (que o POST de /members rejeitaria por
-- conflito, ja que o perfil ainda estaria vinculado ao grupo de origem).
-- security invoker: mantem as mesmas RLS policies de profile_group_members
-- (insert/delete exigem admin/operator na organizacao), sem duplicar a checagem.

create or replace function public.move_profile_group_members(
  p_source_group_id uuid,
  p_target_group_id uuid,
  p_profile_ids uuid[]
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_source public.profile_groups%rowtype;
  v_target public.profile_groups%rowtype;
  v_moved uuid[];
begin
  if p_source_group_id = p_target_group_id then
    raise exception 'O grupo de destino deve ser diferente do grupo de origem.' using errcode = '22023';
  end if;

  select * into v_source from public.profile_groups where id = p_source_group_id and deleted_at is null;
  if not found then
    raise exception 'Grupo de origem nao encontrado.' using errcode = 'P0002';
  end if;

  select * into v_target from public.profile_groups where id = p_target_group_id and deleted_at is null;
  if not found then
    raise exception 'Grupo de destino nao encontrado.' using errcode = 'P0002';
  end if;

  if v_source.organization_id <> v_target.organization_id then
    raise exception 'Os grupos precisam pertencer a mesma organizacao.' using errcode = '22023';
  end if;

  select coalesce(array_agg(profile_id), '{}')
  into v_moved
  from public.profile_group_members
  where group_id = p_source_group_id
    and profile_id = any(p_profile_ids);

  if v_moved = '{}' then
    return jsonb_build_object('movedProfileIds', '[]'::jsonb, 'skippedProfileIds', to_jsonb(p_profile_ids));
  end if;

  delete from public.profile_group_members
  where group_id = p_source_group_id
    and profile_id = any(v_moved);

  insert into public.profile_group_members (organization_id, group_id, profile_id, added_by)
  select v_target.organization_id, p_target_group_id, profile_id, auth.uid()
  from unnest(v_moved) as profile_id;

  return jsonb_build_object(
    'movedProfileIds', to_jsonb(v_moved),
    'skippedProfileIds', to_jsonb(array(select unnest(p_profile_ids) except select unnest(v_moved)))
  );
end;
$$;

revoke all on function public.move_profile_group_members(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.move_profile_group_members(uuid, uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';
