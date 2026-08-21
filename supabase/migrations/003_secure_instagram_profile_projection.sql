-- O token criptografado continua sendo segredo de backend: usuários autenticados
-- consultam somente a projeção segura abaixo, nunca a tabela diretamente.

revoke select on table public.instagram_profiles from authenticated;

create view public.instagram_profiles_safe
with (security_invoker = true)
as
select
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
from public.instagram_profiles;

grant select on public.instagram_profiles_safe to authenticated;
