-- Um perfil do Instagram pode ser associado a apenas um grupo por organização.
-- Para vínculos legados duplicados, preserva-se o vínculo criado primeiro.

with ranked_memberships as (
  select
    ctid,
    row_number() over (
      partition by organization_id, profile_id
      order by created_at asc, group_id asc
    ) as membership_rank
  from public.profile_group_members
)
delete from public.profile_group_members membership
using ranked_memberships ranked
where membership.ctid = ranked.ctid
  and ranked.membership_rank > 1;

alter table public.profile_group_members
  add constraint profile_group_members_organization_profile_unique
  unique (organization_id, profile_id);

-- Corrige o sufixo de status gravado por engano no username, sem afetar
-- usernames cujo conteúdo legítimo contenha "online" fora do fim do texto.
update public.instagram_profiles
set username = regexp_replace(username, 'online$', '', 'i')
where username ~* 'online$'
  and char_length(trim(regexp_replace(username, 'online$', '', 'i'))) >= 1;
