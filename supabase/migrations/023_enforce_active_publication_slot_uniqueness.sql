-- A reserva serializada na função continua sendo usada para escolher a próxima
-- vaga recorrente. O trigger protege também futuras inserções/alterações fora
-- da função, sem falhar a migration caso existam duplicidades legadas.
create or replace function public.enforce_active_publication_slot_uniqueness()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.execute_at is not null
    and new.status in ('waiting', 'ready', 'preparing', 'publishing')
    and exists (
      select 1
      from public.publication_items occupied
      where occupied.organization_id = new.organization_id
        and occupied.profile_id = new.profile_id
        and occupied.execute_at = new.execute_at
        and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
        and occupied.id <> new.id
    ) then
    raise exception using errcode = '23505', message = 'active_publication_slot_conflict';
  end if;
  return new;
end;
$$;

drop trigger if exists publication_items_enforce_active_slot on public.publication_items;
create trigger publication_items_enforce_active_slot
before insert or update of organization_id, profile_id, execute_at, status on public.publication_items
for each row execute function public.enforce_active_publication_slot_uniqueness();

revoke all on function public.enforce_active_publication_slot_uniqueness() from public;
