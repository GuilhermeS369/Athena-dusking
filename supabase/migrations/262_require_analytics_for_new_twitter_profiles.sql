-- Todo perfil X novo deve nascer com a capability de Analytics ativa.
-- O worker confirma primeiro a alteração na Zernio; este trigger mantém o
-- estado local obrigatório mesmo para futuros caminhos de criação de perfil.

alter table public.twitter_connections
  alter column analytics_enabled set default true;

create or replace function public.twitter_require_profile_analytics()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.current_connection_id is not null and new.deleted_at is null then
    update public.twitter_connections
    set analytics_enabled = true,
        inbox_enabled = false
    where id = new.current_connection_id
      and organization_id = new.organization_id
      and status <> 'deleted'
      and deleted_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists twitter_profiles_require_analytics on public.twitter_profiles;
create trigger twitter_profiles_require_analytics
before insert or update of current_connection_id, deleted_at on public.twitter_profiles
for each row execute function public.twitter_require_profile_analytics();

revoke all on function public.twitter_require_profile_analytics() from public, anon, authenticated;
grant execute on function public.twitter_require_profile_analytics() to service_role;
