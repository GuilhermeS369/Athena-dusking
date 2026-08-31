begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(6);

-- Ordenar por seguidores/views troca a chave do cursor. O risco aqui é o mesmo
-- que corrompeu o backfill de 30/08/2026: paginar por uma coluna que só PARECE
-- única repete algumas linhas e perde outras, e a contagem final continua
-- parecendo certa. Por isso o cenário empata a métrica de propósito.

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  ('14300000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sort-343@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('24300000-0000-4000-8000-000000000001', 'Ordenação 343', 'ordenacao-343', '14300000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('24300000-0000-4000-8000-000000000001', '14300000-0000-4000-8000-000000000001', 'admin', '14300000-0000-4000-8000-000000000001');

-- Nove perfis: três faixas de seguidores com três empates cada.
insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by, created_at
)
select
  ('44300000-0000-4000-8000-0000000000' || lpad(serie::text, 2, '0'))::uuid,
  '24300000-0000-4000-8000-000000000001',
  'ig-343-' || serie,
  'conta_343_' || serie,
  'token',
  'online',
  '14300000-0000-4000-8000-000000000001',
  timezone('utc', now()) - make_interval(mins => serie)
from generate_series(1, 9) as serie;

insert into public.profile_analytics_current (
  organization_id, profile_id, provider, followers_count, views
)
select
  '24300000-0000-4000-8000-000000000001',
  ('44300000-0000-4000-8000-0000000000' || lpad(serie::text, 2, '0'))::uuid,
  'meta_official',
  ((serie - 1) / 3) * 1000,
  9000 - (((serie - 1) / 3) * 1000)
from generate_series(1, 9) as serie;

set local role authenticated;
set local request.jwt.claim.sub = '14300000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.email = 'sort-343@example.com';

-- Percorre todas as páginas de 2 em 2 seguindo o cursor real da função.
create or replace function pg_temp.walk_catalog(p_sort text)
returns table (seen_id uuid) language plpgsql as $$
declare
  cursor_created_at timestamptz := null;
  cursor_id uuid := null;
  cursor_metric bigint := null;
  row_record record;
  page_rows integer;
  guard integer := 0;
begin
  loop
    guard := guard + 1;
    exit when guard > 20;
    page_rows := 0;
    for row_record in
      select page.id, page.created_at, page.sort_metric
      from public.list_instagram_profiles_catalog_page(
        '24300000-0000-4000-8000-000000000001', 2,
        cursor_created_at, cursor_id, null, null, null, null, 'all',
        p_sort, cursor_metric
      ) as page
    loop
      page_rows := page_rows + 1;
      seen_id := row_record.id;
      return next;
      cursor_created_at := row_record.created_at;
      cursor_id := row_record.id;
      cursor_metric := row_record.sort_metric;
    end loop;
    exit when page_rows = 0;
  end loop;
end;
$$;

select extensions.is(
  (select count(*)::integer from pg_temp.walk_catalog('followers')),
  9,
  'ordenado por seguidores, a paginação entrega exatamente nove linhas'
);
select extensions.is(
  (select count(distinct seen_id)::integer from pg_temp.walk_catalog('followers')),
  9,
  'ordenado por seguidores, nenhuma linha se repete entre páginas'
);
select extensions.is(
  (select count(distinct seen_id)::integer from pg_temp.walk_catalog('views')),
  9,
  'ordenado por views, nenhuma linha se repete entre páginas'
);
select extensions.is(
  (select count(distinct seen_id)::integer from pg_temp.walk_catalog('recent')),
  9,
  'a ordem por mais recentes continua íntegra com a chave nova'
);

-- A primeira página tem de trazer de fato o topo da métrica.
select extensions.is(
  (select max(followers_count) from public.list_instagram_profiles_catalog_page(
    '24300000-0000-4000-8000-000000000001', 3, null, null, null, null, null, null, 'all', 'followers', null
  )),
  2000::bigint,
  'a primeira página de "mais seguidores" traz a faixa mais alta'
);
select extensions.is(
  (select max(views) from public.list_instagram_profiles_catalog_page(
    '24300000-0000-4000-8000-000000000001', 3, null, null, null, null, null, null, 'all', 'views', null
  )),
  9000::bigint,
  'a primeira página de "mais visualizações" traz a faixa mais alta'
);

select * from extensions.finish();
rollback;
