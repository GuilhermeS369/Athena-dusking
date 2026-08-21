-- Serializa o consumo do link espelho para que vários aparelhos abrindo o
-- mesmo link ao mesmo tempo não invalidem o magic link uns dos outros.

alter table public.auth_mirror_links
add column if not exists login_lock_id text,
add column if not exists login_lock_until timestamptz;

create index if not exists auth_mirror_links_login_lock_idx
on public.auth_mirror_links (id, login_lock_until)
where active;
