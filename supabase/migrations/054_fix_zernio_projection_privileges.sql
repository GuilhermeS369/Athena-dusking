-- Athena Scheduler: corrige privilégios das projeções seguras após adicionar Zernio.
-- Views com security_invoker=true exigem permissões nas colunas da tabela base.

grant select (
  provider,
  zernio_profile_id,
  zernio_account_id,
  zernio_account_metadata
)
on table public.instagram_profiles
to authenticated;

grant select (
  organization_id,
  zernio_profile_id,
  status,
  last_checked_at,
  last_success_at,
  last_failure_at,
  last_error_code,
  last_error_message,
  created_by,
  created_at,
  updated_at
)
on table public.zernio_organization_settings
to authenticated;

revoke select (encrypted_api_key)
on table public.zernio_organization_settings
from authenticated;
