-- Uma única limpeza operacional para a fila do Instagram.
-- Publicações encerradas e falhas são retiradas da fila, mas continuam
-- preservadas nas tabelas históricas e na auditoria.

create or replace function public.clean_publication_queue_finished(
  p_organization_id uuid
)
returns table (archived_completed_count integer, archived_failure_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  completed_count integer := 0;
  failure_count integer := 0;
begin
  if auth.role() <> 'service_role' and (
    actor_id is null or not public.has_organization_role(
      p_organization_id,
      array['admin', 'operator']::public.organization_role[]
    )
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  update public.publication_items item
  set archived_at = timezone('utc', now()),
      archived_by = actor_id
  where item.organization_id = p_organization_id
    and item.archived_at is null
    and item.status in ('published', 'cancelled', 'removed', 'ignored');
  get diagnostics completed_count = row_count;

  with archived_failures as (
    update public.publication_items item
    set archived_at = timezone('utc', now()),
        archived_by = actor_id
    where item.organization_id = p_organization_id
      and item.archived_at is null
      and item.status = 'failed'
    returning item.id
  ), acknowledged as (
    insert into public.publication_failure_acknowledgements (
      publication_item_id, organization_id, acknowledged_by, scope
    )
    select id, p_organization_id, actor_id, 'visible_items'
    from archived_failures
    on conflict (publication_item_id) do nothing
    returning publication_item_id
  )
  select count(*)::integer into failure_count from archived_failures;

  insert into public.publication_queue_action_audits (
    organization_id, actor_user_id, action, affected_count, item_ids, metadata
  ) values (
    p_organization_id,
    actor_id,
    'archive_completed',
    completed_count,
    '{}'::uuid[],
    jsonb_build_object('scope', 'queue_cleanup', 'bulk', true)
  );

  insert into public.publication_queue_action_audits (
    organization_id, actor_user_id, action, affected_count, item_ids, metadata
  ) values (
    p_organization_id,
    actor_id,
    'acknowledge_failures',
    failure_count,
    '{}'::uuid[],
    jsonb_build_object('scope', 'queue_cleanup', 'archived', true, 'bulk', true)
  );

  return query select
    completed_count,
    failure_count;
end;
$$;

revoke all on function public.clean_publication_queue_finished(uuid) from public, anon;
grant execute on function public.clean_publication_queue_finished(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
