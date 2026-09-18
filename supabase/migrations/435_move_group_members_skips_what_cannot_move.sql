-- Mover perfis entre grupos passa a pular o que não pode mover, em vez de
-- derrubar a operação inteira.
--
-- INCIDENTE QUE MOTIVOU (18/09/2026, org Pomodoro, grupo "xTESTE LEXY"):
--
--   O grupo tinha 66 vínculos mas só 56 perfis. Os outros 10 apontavam para
--   perfis apagados em 07/09 entre 07:03 e 08:08, todos com
--   `meta_profile_disconnected` — a leva de checkpoint daquela manhã, quando o
--   caminho de remoção Meta ainda não limpava `profile_group_members` (a
--   migration 376 passou a limpar).
--
--   A tela montava a lista de ids a partir dos VÍNCULOS, sem conferir se o
--   perfil existia, e mandava os 66. Esta função apaga todos da origem e insere
--   todos no destino numa transação só; o gatilho
--   `enforce_group_membership_organization` (migration 002) exige
--   `profile_row.deleted_at is null`, então o primeiro perfil morto levantava
--   23514 e **nada se movia**. Nem os 56 bons.
--
-- POR QUE PULAR É MELHOR QUE FALHAR. A função já devolve `skippedProfileIds` —
-- o vocabulário para "este não deu" sempre existiu, só não era usado para este
-- caso. Um vínculo podre no meio da seleção é um dado ruim de uma linha, não
-- uma razão para 56 perfis bons ficarem onde estavam sem explicação.
--
-- O QUE NÃO MUDA. O vínculo que não pôde ser movido **continua na origem**. Ele
-- não é apagado por tabela de mesa: se um dia o perfil voltar, o vínculo volta a
-- fazer sentido, e apagar aqui seria decidir isso em silêncio dentro de uma
-- operação que a pessoa pediu para MOVER.
--
-- A seleção agora espelha exatamente a condição do gatilho (perfil vivo, mesma
-- organização do destino), então o insert não tem mais como ser barrado por ele.

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

  -- O join com instagram_profiles e os dois filtros abaixo repetem, de
  -- proposito, a condicao de enforce_group_membership_organization. E o que
  -- garante que o insert mais abaixo nunca seja barrado pelo gatilho: quem nao
  -- passaria simplesmente nao entra em v_moved.
  select coalesce(array_agg(member.profile_id), '{}')
  into v_moved
  from public.profile_group_members member
  join public.instagram_profiles profile
    on profile.id = member.profile_id
  where member.group_id = p_source_group_id
    and member.profile_id = any(p_profile_ids)
    and profile.deleted_at is null
    and profile.organization_id = v_target.organization_id;

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
