-- Quais perfis de uma lista ainda têm fila aberta de plano ou agendamento.
--
-- Decisão do dono em 10/10/2026: um perfil só troca de grupo se ele próprio estiver
-- sem fila. A conferência é POR PERFIL, não pelo grupo de origem: mover 3 perfis
-- parados de um grupo em que os outros 47 estão rodando tem de passar.
--
-- O motivo é a postagem contínua (443): a fila de plano em massa pertence ao
-- perfil, não ao grupo. Um perfil que chega com reels agendados a um grupo com a
-- chave ligada postaria os dois (os do plano e os da esteira), e os horários da
-- esteira que caíssem dentro da reserva do plano seriam pulados com aviso de
-- conflito. A guarda de "ligar" (443) só olha o grupo na hora de ligar a chave.
--
-- "Fila aberta" aqui é a mesma definição da guarda de ligar, sem filtro de formato:
--   * item não arquivado em waiting/ready/preparing/publishing/suspended, ou
--     failed com retry pendente, QUE NÃO SEJA de postagem contínua;
--   * reserva de horizonte de plano em massa ainda ativa.
-- Item de postagem contínua não conta: o perfil tem no máximo um em voo, ele
-- termina sozinho, e sair de uma esteira para entrar em outra é o caso previsto.
--
-- Só leitura. Nenhuma tabela, coluna, gatilho ou função existente muda. Cada perfil
-- é conferido pelo índice publication_items_queue_profile_page_idx
-- (organization_id, profile_id, status, execute_at) where archived_at is null.

create or replace function public.get_profiles_with_open_publication_queue(
  p_organization_id uuid,
  p_profile_ids uuid[]
) returns table (
  profile_id uuid,
  open_items bigint,
  active_horizons bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with authorized as (
    select 1
    where coalesce(auth.role(), '') = 'service_role'
       or public.is_organization_member(p_organization_id)
  ), requested as (
    select distinct candidate.id
    from unnest(coalesce(p_profile_ids, '{}'::uuid[])) as candidate(id), authorized
    limit 5000
  ), measured as (
    select requested.id as profile_id,
      (
        select count(*)
        from public.publication_items item
        where item.organization_id = p_organization_id
          and item.profile_id = requested.id
          and item.archived_at is null
          and (
            item.status in ('waiting', 'ready', 'preparing', 'publishing', 'suspended')
            or (item.status = 'failed' and item.attempt_count < 5 and item.next_attempt_at is not null)
          )
          and not exists (
            select 1 from public.continuous_posting_items link
            where link.publication_item_id = item.id
          )
      ) as open_items,
      (
        select count(*)
        from public.bulk_publication_profile_horizons horizon
        where horizon.organization_id = p_organization_id
          and horizon.profile_id = requested.id
          and horizon.status = 'active'
          and horizon.reserved_through > timezone('utc', now())
      ) as active_horizons
    from requested
  )
  select measured.profile_id, measured.open_items, measured.active_horizons
  from measured
  where measured.open_items > 0 or measured.active_horizons > 0
  order by measured.profile_id;
$$;

revoke all on function public.get_profiles_with_open_publication_queue(uuid, uuid[]) from public, anon;
grant execute on function public.get_profiles_with_open_publication_queue(uuid, uuid[]) to authenticated, service_role;

notify pgrst, 'reload schema';
