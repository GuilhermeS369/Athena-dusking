-- A limpeza não altera dados compartilhados: é somente a preferência privada de
-- visualização do membro autenticado. Portanto qualquer membro pode acioná-la.

create or replace function public.set_operational_log_visibility(p_organization_id uuid, p_scope_key text, p_action text)
returns public.operational_log_clear_actions
language plpgsql
security definer
set search_path = public
as $$
declare
  action_row public.operational_log_clear_actions;
  actor_id uuid := auth.uid();
begin
  if actor_id is null or not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Sem permissão para alterar a visualização operacional.';
  end if;
  if p_scope_key not in ('attention_items', 'publication_events') or p_action not in ('clear', 'undo') then
    raise exception using errcode = '22023', message = 'Escopo ou ação inválidos.';
  end if;

  insert into public.operational_log_clear_actions (organization_id, actor_user_id, scope_key, cleared_at, undone_at, undone_by, updated_at)
  values (p_organization_id, actor_id, p_scope_key, timezone('utc', now()), case when p_action = 'undo' then timezone('utc', now()) else null end, case when p_action = 'undo' then actor_id else null end, timezone('utc', now()))
  on conflict (organization_id, actor_user_id, scope_key) do update set
    cleared_at = case when p_action = 'clear' then timezone('utc', now()) else operational_log_clear_actions.cleared_at end,
    undone_at = case when p_action = 'undo' then timezone('utc', now()) else null end,
    undone_by = case when p_action = 'undo' then actor_id else null end,
    updated_at = timezone('utc', now())
  returning * into action_row;
  return action_row;
end;
$$;

notify pgrst, 'reload schema';
