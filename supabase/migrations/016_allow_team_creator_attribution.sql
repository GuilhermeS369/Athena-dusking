-- Permite identificar o autor de publicações para membros da mesma organização,
-- sem expor dados de pessoas fora das organizações compartilhadas.

drop policy if exists user_profiles_select_self on public.user_profiles;

create policy user_profiles_select_organization_member
on public.user_profiles for select
to authenticated
using (
  user_id = (select auth.uid())
  or exists (
    select 1
    from public.organization_members as current_member
    join public.organization_members as target_member
      on target_member.organization_id = current_member.organization_id
    where current_member.user_id = (select auth.uid())
      and target_member.user_id = user_profiles.user_id
  )
);
