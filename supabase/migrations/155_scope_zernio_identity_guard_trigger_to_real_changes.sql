-- UPDATE OF username dispara mesmo quando o valor atribuído é igual. Separe os
-- triggers e aplique a guarda em UPDATE apenas quando a identidade realmente
-- mudar ou quando uma linha for restaurada/convertida para Zernio.

drop trigger if exists instagram_profiles_prevent_zernio_identity_conflict
  on public.instagram_profiles;
drop trigger if exists instagram_profiles_prevent_zernio_identity_conflict_insert
  on public.instagram_profiles;
drop trigger if exists instagram_profiles_prevent_zernio_identity_conflict_update
  on public.instagram_profiles;

create trigger instagram_profiles_prevent_zernio_identity_conflict_insert
before insert on public.instagram_profiles
for each row
execute function public.prevent_zernio_instagram_identity_conflict();

create trigger instagram_profiles_prevent_zernio_identity_conflict_update
before update of username, provider, deleted_at on public.instagram_profiles
for each row
when (
  old.provider is distinct from new.provider
  or old.deleted_at is distinct from new.deleted_at
  or lower(trim(regexp_replace(old.username, '^@', '')))
     is distinct from lower(trim(regexp_replace(new.username, '^@', '')))
)
execute function public.prevent_zernio_instagram_identity_conflict();

notify pgrst, 'reload schema';
