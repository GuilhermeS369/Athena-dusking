-- Link espelho de autenticação para preparar aparelhos limpos na tela de Contas.

create table public.auth_mirror_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  created_by_email text not null check (char_length(trim(created_by_email)) between 3 and 320),
  token_hash text not null unique check (char_length(token_hash) = 64),
  active boolean not null default true,
  activated_at timestamptz not null default timezone('utc', now()),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  last_used_at timestamptz,
  use_count integer not null default 0 check (use_count >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check ((active and revoked_at is null) or (not active))
);

create unique index auth_mirror_links_one_active_org_idx
on public.auth_mirror_links (organization_id)
where active;

create index auth_mirror_links_organization_created_idx
on public.auth_mirror_links (organization_id, created_at desc);

create index auth_mirror_links_token_hash_idx
on public.auth_mirror_links (token_hash)
where active;

create trigger auth_mirror_links_set_updated_at
before update on public.auth_mirror_links
for each row execute function public.set_updated_at();

alter table public.auth_mirror_links enable row level security;

create policy auth_mirror_links_select_member
on public.auth_mirror_links for select
to authenticated
using (public.is_organization_member(organization_id));

create policy auth_mirror_links_insert_operator
on public.auth_mirror_links for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
);

create policy auth_mirror_links_update_operator
on public.auth_mirror_links for update
to authenticated
using (
  public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
)
with check (
  public.has_organization_role(
    organization_id,
    array['admin', 'operator']::public.organization_role[]
  )
);

create or replace function public.record_auth_mirror_link_use(p_link_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.auth_mirror_links
  set use_count = use_count + 1,
      last_used_at = timezone('utc', now())
  where id = p_link_id
    and active = true;
end;
$$;

grant select, insert, update on public.auth_mirror_links to authenticated;
revoke all on function public.record_auth_mirror_link_use(uuid) from public;
grant execute on function public.record_auth_mirror_link_use(uuid) to authenticated;
grant execute on function public.record_auth_mirror_link_use(uuid) to service_role;
