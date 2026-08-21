-- Atualizações de metadados da própria conta (avatar, status, metadata remoto)
-- não alteram sua identidade e não precisam repetir a guarda global. A guarda
-- permanece obrigatória em INSERT, restauração, troca de provider ou username.

create or replace function public.prevent_zernio_instagram_identity_conflict()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  identity_value text;
  old_identity_value text;
begin
  if new.provider <> 'zernio' or new.deleted_at is not null then
    return new;
  end if;

  identity_value := lower(nullif(trim(regexp_replace(new.username, '^@', '')), ''));
  if identity_value is null then
    raise exception 'Identidade Instagram Zernio inválida.';
  end if;

  if tg_op = 'UPDATE' then
    old_identity_value := lower(nullif(trim(regexp_replace(old.username, '^@', '')), ''));
    if old.provider = 'zernio'
       and old.deleted_at is null
       and old_identity_value is not distinct from identity_value then
      return new;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(identity_value, 0));

  if exists (
    select 1
    from public.instagram_profiles profile
    where profile.provider = 'zernio'
      and profile.deleted_at is null
      and profile.id is distinct from new.id
      and lower(trim(regexp_replace(profile.username, '^@', ''))) = identity_value
  ) then
    raise exception using
      errcode = '23505',
      message = 'A identidade Instagram já está vinculada a outra conexão ou organização; resolva o conflito explicitamente.';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_zernio_instagram_identity_conflict() from public, anon, authenticated;

notify pgrst, 'reload schema';
