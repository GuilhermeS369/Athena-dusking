-- A projeção usa security_invoker=true para preservar as políticas RLS da
-- tabela base. Por isso, authenticated precisa de SELECT somente nas colunas
-- públicas da identidade operacional do perfil.
--
-- encrypted_access_token permanece sem privilégio de leitura e continua
-- acessível apenas ao backend/worker que operar com uma credencial própria.

grant select (
  id,
  organization_id,
  instagram_user_id,
  username,
  display_name,
  profile_picture_url,
  account_type,
  capabilities,
  token_expires_at,
  status,
  last_checked_at,
  last_success_at,
  last_failure_at,
  last_error_code,
  last_error_message,
  created_by,
  deleted_at,
  created_at,
  updated_at
)
on table public.instagram_profiles
to authenticated;

revoke select (encrypted_access_token)
on table public.instagram_profiles
from authenticated;
