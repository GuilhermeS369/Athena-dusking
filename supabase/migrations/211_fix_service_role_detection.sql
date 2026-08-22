-- PostgREST pode expor o papel do JWT no objeto request.jwt.claims em vez da
-- configuração legada request.jwt.claim.role. Mantém compatibilidade com ambos.

create or replace function public.is_service_role_request()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  ) = 'service_role';
$$;

revoke all on function public.is_service_role_request() from public, anon;
grant execute on function public.is_service_role_request() to authenticated, service_role;

notify pgrst, 'reload schema';
