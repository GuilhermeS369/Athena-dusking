-- Permite que a exclusão de mídia finalize itens históricos cujo perfil já foi
-- removido logicamente. Antes, qualquer update nesses itens disparava
-- "Perfil inválido para a organização" e fazia o chunk inteiro falhar.

create or replace function public.enforce_publication_organization()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.publication_batches batch_row
    where batch_row.id = new.batch_id
      and batch_row.organization_id = new.organization_id
  ) then
    raise exception using errcode = '23514', message = 'Lote e item devem pertencer à mesma organização';
  end if;

  if tg_op = 'INSERT' then
    if not exists (
      select 1 from public.instagram_profiles profile_row
      where profile_row.id = new.profile_id
        and profile_row.organization_id = new.organization_id
        and profile_row.deleted_at is null
    ) then
      raise exception using errcode = '23514', message = 'Perfil inválido para a organização';
    end if;
  else
    if new.profile_id is distinct from old.profile_id
      or new.organization_id is distinct from old.organization_id
    then
      if not exists (
        select 1 from public.instagram_profiles profile_row
        where profile_row.id = new.profile_id
          and profile_row.organization_id = new.organization_id
          and profile_row.deleted_at is null
      ) then
        raise exception using errcode = '23514', message = 'Perfil inválido para a organização';
      end if;
    elsif not exists (
      select 1 from public.instagram_profiles profile_row
      where profile_row.id = new.profile_id
        and profile_row.organization_id = new.organization_id
    ) then
      raise exception using errcode = '23514', message = 'Perfil inválido para a organização';
    end if;
  end if;

  return new;
end;
$$;
