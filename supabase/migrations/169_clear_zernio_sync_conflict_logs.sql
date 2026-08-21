-- Permite que um administrador descarte ocorrências históricas de conflito já
-- resolvidas, sem apagar dados de outros status ou de outras organizações.
create or replace function public.clear_zernio_sync_conflict_logs(
  p_organization_id uuid,
  p_requested_by uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  if p_requested_by is null then
    raise exception using errcode = '22023', message = 'Administrador responsável é obrigatório.';
  end if;

  delete from public.zernio_sync_log_items
  where organization_id = p_organization_id
    and status = 'conflict';

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.clear_zernio_sync_conflict_logs(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.clear_zernio_sync_conflict_logs(uuid, uuid)
  to service_role;

notify pgrst, 'reload schema';
