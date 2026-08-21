-- Restaura a proteção global de identidade em UPDATE após a RPC de
-- reconciliação passar a separar alterações de identidade de metadata.
--
-- A função de guarda exclui NEW.id da busca de conflitos, portanto uma
-- alteração legítima da própria linha continua permitida. O WHEN evita
-- executar a guarda em updates que alteram apenas metadata.

drop trigger if exists instagram_profiles_prevent_zernio_identity_conflict_update
  on public.instagram_profiles;

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
