-- A reconciliação de uma conta já canônica deve ser idempotente. O trigger
-- global de identidade não pode interpretar a própria linha como duplicata.

create or replace function public.prevent_zernio_instagram_identity_conflict()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  identity_value text;
begin
  if new.provider <> 'zernio' or new.deleted_at is not null then
    return new;
  end if;

  identity_value := lower(nullif(trim(regexp_replace(new.username, '^@', '')), ''));
  if identity_value is null then
    raise exception 'Identidade Instagram Zernio inválida.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(identity_value, 0));

  if exists (
    select 1
    from public.instagram_profiles profile
    where profile.provider = 'zernio'
      and profile.deleted_at is null
      -- Em INSERT new.id também já possui default. IS DISTINCT FROM cobre
      -- UPDATE e qualquer linha legada sem depender de comparação nullable.
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

