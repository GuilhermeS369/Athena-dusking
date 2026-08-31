-- Filtro por data de adicao no catalogo de perfis.
--
-- "Adicionadas em <dia>" precisa significar o dia como a pessoa ve, nao como o
-- banco guarda. created_at e timestamptz em UTC e a organizacao e fuso unico
-- (organizations.timezone tem CHECK fixando America/Sao_Paulo, e
-- ORGANIZATION_TIME_ZONE em lib/publications/composer.ts repete a constante).
-- Sem a conversao, um perfil conectado as 21h30 de um dia em Sao Paulo cairia no
-- dia seguinte -- justamente a faixa de horario em que mais se conecta conta.
--
-- O predicado e um intervalo semiaberto sobre a coluna crua, como a migration
-- 339 ja faz: created_at >= dia e created_at < dia + 1, ambos convertidos.
-- Envolver a coluna (timezone(...)::date = p_created_on) daria o mesmo resultado
-- e descartaria o indice de (created_at, id) que sustenta a paginacao.
--
-- As tres funcoes do catalogo mudam juntas de proposito: a pagina, os ids e o
-- resumo tem de aplicar exatamente o mesmo recorte, senao "selecionar todos
-- deste filtro" apaga um conjunto diferente do que a tela contou.
--
-- Aproveitando a reescrita, filtered_total passa a contar distinct profile.id.
-- Hoje isso nao muda numero nenhum: a migration 018 criou
-- profile_group_members_organization_profile_unique (organization_id,
-- profile_id), entao o left join com grupos nao duplica linha. O distinct existe
-- porque filtered_total e comparado com o resultado de
-- list_instagram_profiles_catalog_ids para decidir o teto da exclusao em massa,
-- e essas duas contagens nao podem depender de uma restricao que vive noutro
-- arquivo. Se um dia a organizacao passar a aceitar perfil em mais de um grupo,
-- o catalogo nao passa a apagar um conjunto diferente do que exibiu.

drop function if exists public.list_instagram_profiles_catalog_page(uuid, integer, timestamptz, uuid, text, uuid, text, text, text, text, bigint);
drop function if exists public.list_instagram_profiles_catalog_page(uuid, integer, timestamptz, uuid, text, uuid, text, text, text, text, bigint, date);

create function public.list_instagram_profiles_catalog_page(
  p_organization_id uuid,
  p_limit integer default 40,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_query text default null,
  p_group_id uuid default null,
  p_status text default null,
  p_situation text default null,
  p_publication text default 'all',
  p_sort text default 'recent',
  p_cursor_metric bigint default null,
  p_created_on date default null
)
returns table (
  id uuid,
  instagram_user_id text,
  username text,
  display_name text,
  profile_picture_url text,
  account_type text,
  status text,
  provider text,
  zernio_account_id text,
  zernio_connection_id uuid,
  token_expires_at timestamptz,
  last_checked_at timestamptz,
  last_error_message text,
  created_at timestamptz,
  group_id uuid,
  group_name text,
  zernio_connection_label text,
  scheduled_total integer,
  scheduled_reel integer,
  scheduled_story integer,
  scheduled_image integer,
  scheduled_carousel integer,
  published_total integer,
  published_reel integer,
  published_story integer,
  published_image integer,
  published_carousel integer,
  followers_count bigint,
  followers_delta bigint,
  views bigint,
  reach bigint,
  impressions bigint,
  total_interactions bigint,
  engagement_rate numeric,
  posts_count integer,
  latest_published_at timestamptz,
  analytics_status text,
  analytics_unavailable_reason text,
  analytics_synced_at timestamptz,
  sort_metric bigint,
  has_more boolean
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with normalized as (
    select
      least(greatest(coalesce(p_limit, 40), 1), 100) as page_limit,
      nullif(lower(trim(coalesce(p_query, ''))), '') as search_query,
      nullif(lower(trim(coalesce(p_status, ''))), '') as status_filter,
      nullif(lower(trim(coalesce(p_situation, ''))), '') as situation_filter,
      coalesce(nullif(lower(trim(coalesce(p_publication, 'all'))), ''), 'all') as publication_filter,
      case lower(trim(coalesce(p_sort, 'recent')))
        when 'followers' then 'followers'
        when 'views' then 'views'
        else 'recent'
      end as sort_mode
  ), candidates as (
    select
      profile.id,
      profile.instagram_user_id,
      profile.username,
      profile.display_name,
      profile.profile_picture_url,
      profile.account_type::text as account_type,
      profile.status::text as status,
      profile.provider::text as provider,
      profile.zernio_account_id,
      profile.zernio_connection_id,
      profile.token_expires_at,
      profile.last_checked_at,
      profile.last_error_message,
      profile.created_at,
      membership.group_id,
      profile_group.name as group_name,
      connection.label as zernio_connection_label,
      case filter.sort_mode
        when 'followers' then coalesce(sort_analytics.followers_count, 0)
        when 'views' then coalesce(sort_analytics.views, 0)
        else 0::bigint
      end as sort_metric
    from public.instagram_profiles profile
    cross join normalized filter
    left join public.profile_group_members membership
      on membership.organization_id = profile.organization_id
     and membership.profile_id = profile.id
    left join public.profile_groups profile_group
      on profile_group.organization_id = profile.organization_id
     and profile_group.id = membership.group_id
     and profile_group.deleted_at is null
    left join public.zernio_connections connection
      on connection.organization_id = profile.organization_id
     and connection.id = profile.zernio_connection_id
     and connection.deleted_at is null
    left join public.profile_analytics_current sort_analytics
      on sort_analytics.organization_id = profile.organization_id
     and sort_analytics.profile_id = profile.id
     and sort_analytics.deleted_at is null
    where profile.organization_id = p_organization_id
      and profile.deleted_at is null
      and public.is_organization_member(p_organization_id)
      and (
        p_cursor_created_at is null or p_cursor_id is null
        or (
          case filter.sort_mode
            when 'followers' then coalesce(sort_analytics.followers_count, 0)
            when 'views' then coalesce(sort_analytics.views, 0)
            else 0::bigint
          end,
          profile.created_at,
          profile.id
        ) < (coalesce(p_cursor_metric, 0), p_cursor_created_at, p_cursor_id)
      )
      and (p_group_id is null or membership.group_id = p_group_id)
      and (
        p_created_on is null
        or (
          profile.created_at >= (p_created_on::timestamp at time zone 'America/Sao_Paulo')
          and profile.created_at < ((p_created_on + 1)::timestamp at time zone 'America/Sao_Paulo')
        )
      )
      and (filter.status_filter is null or profile.status::text = filter.status_filter)
      and (
        filter.situation_filter is null
        or (filter.situation_filter = 'online' and profile.status::text = 'online')
        or (filter.situation_filter = 'error' and (profile.status::text = 'reauthorization_required' or profile.last_error_message is not null))
        or (filter.situation_filter = 'paused' and profile.status::text in ('offline', 'no_data'))
      )
      and (
        filter.publication_filter = 'all'
        or (
          filter.publication_filter = 'posted'
          and exists (
            select 1
            from public.profile_publication_catalog_current catalog_filter
            where catalog_filter.organization_id = profile.organization_id
              and catalog_filter.profile_id = profile.id
              and catalog_filter.published_total > 0
          )
        )
      )
      and (
        filter.search_query is null
        or lower(profile.username) like '%' || trim(leading '@' from filter.search_query) || '%'
        or lower(coalesce(profile.display_name, '')) like '%' || filter.search_query || '%'
        or lower(coalesce(connection.label, '')) like '%' || filter.search_query || '%'
      )
    order by sort_metric desc, profile.created_at desc, profile.id desc
    limit (select page_limit + 1 from normalized)
  ), page as (
    select candidate.*
    from candidates candidate
    order by candidate.sort_metric desc, candidate.created_at desc, candidate.id desc
    limit (select page_limit from normalized)
  ), publication_metrics as (
    -- Somente a fila ativa. O histórico publicado vem do rollup.
    select
      item.profile_id,
      count(*) filter (where item.execute_at is null or item.execute_at > timezone('utc', now()))::integer as scheduled_total,
      count(*) filter (where item.format = 'reel' and (item.execute_at is null or item.execute_at > timezone('utc', now())))::integer as scheduled_reel,
      count(*) filter (where item.format = 'story' and (item.execute_at is null or item.execute_at > timezone('utc', now())))::integer as scheduled_story,
      count(*) filter (where item.format = 'image' and (item.execute_at is null or item.execute_at > timezone('utc', now())))::integer as scheduled_image,
      count(*) filter (where item.format = 'carousel' and (item.execute_at is null or item.execute_at > timezone('utc', now())))::integer as scheduled_carousel
    from public.publication_items item
    join page on page.id = item.profile_id
    where item.organization_id = p_organization_id
      and item.status in ('waiting', 'ready', 'preparing', 'publishing')
    group by item.profile_id
  )
  select
    page.id,
    page.instagram_user_id,
    page.username,
    page.display_name,
    page.profile_picture_url,
    page.account_type,
    page.status,
    page.provider,
    page.zernio_account_id,
    page.zernio_connection_id,
    page.token_expires_at,
    page.last_checked_at,
    page.last_error_message,
    page.created_at,
    page.group_id,
    page.group_name,
    page.zernio_connection_label,
    coalesce(metrics.scheduled_total, 0),
    coalesce(metrics.scheduled_reel, 0),
    coalesce(metrics.scheduled_story, 0),
    coalesce(metrics.scheduled_image, 0),
    coalesce(metrics.scheduled_carousel, 0),
    coalesce(catalog.published_total, 0),
    coalesce(catalog.published_reel, 0),
    coalesce(catalog.published_story, 0),
    coalesce(catalog.published_image, 0),
    coalesce(catalog.published_carousel, 0),
    coalesce(analytics.followers_count, 0),
    coalesce(analytics.followers_delta, 0),
    coalesce(analytics.views, 0),
    coalesce(analytics.reach, 0),
    coalesce(analytics.impressions, 0),
    coalesce(analytics.total_interactions, 0),
    coalesce(analytics.engagement_rate, 0),
    greatest(coalesce(analytics.posts_count, 0), coalesce(catalog.published_total, 0))::integer,
    catalog.latest_published_at,
    coalesce(analytics.sync_status::text, 'pending'),
    analytics.unavailable_reason,
    analytics.current_synced_at,
    page.sort_metric,
    (select count(*) > (select page_limit from normalized) from candidates)
  from page
  left join publication_metrics metrics on metrics.profile_id = page.id
  left join public.profile_publication_catalog_current catalog
    on catalog.organization_id = p_organization_id
   and catalog.profile_id = page.id
  left join public.profile_analytics_current analytics
    on analytics.organization_id = p_organization_id
   and analytics.profile_id = page.id
   and analytics.deleted_at is null
  order by page.sort_metric desc, page.created_at desc, page.id desc;
$$;


revoke all on function public.list_instagram_profiles_catalog_page(uuid, integer, timestamptz, uuid, text, uuid, text, text, text, text, bigint, date) from public, anon;
grant execute on function public.list_instagram_profiles_catalog_page(uuid, integer, timestamptz, uuid, text, uuid, text, text, text, text, bigint, date) to authenticated, service_role;

-- Ids do filtro corrente -------------------------------------------------------

drop function if exists public.list_instagram_profiles_catalog_ids(uuid, integer, text, uuid, text, text, text);
drop function if exists public.list_instagram_profiles_catalog_ids(uuid, integer, text, uuid, text, text, text, date);

create function public.list_instagram_profiles_catalog_ids(
  p_organization_id uuid,
  p_limit integer default 2000,
  p_query text default null,
  p_group_id uuid default null,
  p_status text default null,
  p_situation text default null,
  p_publication text default 'all',
  p_created_on date default null
)
returns table (id uuid)
language sql stable security definer set search_path = public, extensions as $$
  with allowed as (
    select coalesce(auth.role(), '') = 'service_role'
      or public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) as ok
  ), normalized as (
    select
      least(greatest(coalesce(p_limit, 2000), 1), 2000) as page_limit,
      nullif(lower(trim(coalesce(p_query, ''))), '') as search_query,
      nullif(lower(trim(coalesce(p_status, ''))), '') as status_filter,
      nullif(lower(trim(coalesce(p_situation, ''))), '') as situation_filter,
      coalesce(nullif(lower(trim(coalesce(p_publication, 'all'))), ''), 'all') as publication_filter
  ), candidates as (
    select distinct profile.id, profile.created_at
    from public.instagram_profiles profile
    cross join normalized filter
    cross join allowed
    left join public.profile_group_members membership
      on membership.organization_id = profile.organization_id
     and membership.profile_id = profile.id
    left join public.zernio_connections connection
      on connection.organization_id = profile.organization_id
     and connection.id = profile.zernio_connection_id
     and connection.deleted_at is null
    where allowed.ok
      and profile.organization_id = p_organization_id
      and profile.deleted_at is null
      and (p_group_id is null or membership.group_id = p_group_id)
      and (
        p_created_on is null
        or (
          profile.created_at >= (p_created_on::timestamp at time zone 'America/Sao_Paulo')
          and profile.created_at < ((p_created_on + 1)::timestamp at time zone 'America/Sao_Paulo')
        )
      )
      and (filter.status_filter is null or profile.status::text = filter.status_filter)
      and (
        filter.situation_filter is null
        or (filter.situation_filter = 'online' and profile.status::text = 'online')
        or (filter.situation_filter = 'error' and (profile.status::text = 'reauthorization_required' or profile.last_error_message is not null))
        or (filter.situation_filter = 'paused' and profile.status::text in ('offline', 'no_data'))
      )
      and (
        filter.publication_filter = 'all'
        or (
          filter.publication_filter = 'posted'
          and exists (
            select 1
            from public.profile_publication_catalog_current catalog_filter
            where catalog_filter.organization_id = profile.organization_id
              and catalog_filter.profile_id = profile.id
              and catalog_filter.published_total > 0
          )
        )
      )
      and (
        filter.search_query is null
        or lower(profile.username) like '%' || trim(leading '@' from filter.search_query) || '%'
        or lower(coalesce(profile.display_name, '')) like '%' || filter.search_query || '%'
        or lower(coalesce(connection.label, '')) like '%' || filter.search_query || '%'
      )
  )
  select candidate.id
  from candidates candidate
  order by candidate.created_at desc, candidate.id desc
  limit (select page_limit from normalized);
$$;

revoke all on function public.list_instagram_profiles_catalog_ids(uuid, integer, text, uuid, text, text, text, date) from public, anon;
grant execute on function public.list_instagram_profiles_catalog_ids(uuid, integer, text, uuid, text, text, text, date) to authenticated, service_role;

-- Resumo -----------------------------------------------------------------------

drop function if exists public.get_instagram_profiles_catalog_summary(uuid, text, uuid, text, text, text);
drop function if exists public.get_instagram_profiles_catalog_summary(uuid, text, uuid, text, text, text, date);

create function public.get_instagram_profiles_catalog_summary(
  p_organization_id uuid,
  p_query text default null,
  p_group_id uuid default null,
  p_status text default null,
  p_situation text default null,
  p_publication text default 'all',
  p_created_on date default null
)
returns table (
  total bigint,
  online bigint,
  error bigint,
  paused bigint,
  published_items bigint,
  filtered_total bigint
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with base as (
    select profile.id, profile.status::text as status, profile.last_error_message
    from public.instagram_profiles profile
    where profile.organization_id = p_organization_id
      and profile.deleted_at is null
      and public.is_organization_member(p_organization_id)
  ), filtered as (
    select distinct profile.id
    from public.instagram_profiles profile
    left join public.profile_group_members membership
      on membership.organization_id = profile.organization_id
     and membership.profile_id = profile.id
    left join public.zernio_connections connection
      on connection.organization_id = profile.organization_id
     and connection.id = profile.zernio_connection_id
     and connection.deleted_at is null
    left join public.profile_publication_catalog_current publication
      on publication.organization_id = profile.organization_id
     and publication.profile_id = profile.id
    where profile.organization_id = p_organization_id
      and profile.deleted_at is null
      and public.is_organization_member(p_organization_id)
      and (p_group_id is null or membership.group_id = p_group_id)
      and (
        p_created_on is null
        or (
          profile.created_at >= (p_created_on::timestamp at time zone 'America/Sao_Paulo')
          and profile.created_at < ((p_created_on + 1)::timestamp at time zone 'America/Sao_Paulo')
        )
      )
      and (nullif(lower(trim(coalesce(p_status, ''))), '') is null or profile.status::text = lower(trim(p_status)))
      and (
        nullif(lower(trim(coalesce(p_situation, ''))), '') is null
        or (lower(trim(p_situation)) = 'online' and profile.status::text = 'online')
        or (lower(trim(p_situation)) = 'error' and (profile.status::text = 'reauthorization_required' or profile.last_error_message is not null))
        or (lower(trim(p_situation)) = 'paused' and profile.status::text in ('offline', 'no_data'))
      )
      and (
        coalesce(nullif(lower(trim(coalesce(p_publication, 'all'))), ''), 'all') = 'all'
        or (lower(trim(p_publication)) = 'posted' and coalesce(publication.published_total, 0) > 0)
      )
      and (
        nullif(lower(trim(coalesce(p_query, ''))), '') is null
        or lower(profile.username) like '%' || trim(leading '@' from lower(trim(p_query))) || '%'
        or lower(coalesce(profile.display_name, '')) like '%' || lower(trim(p_query)) || '%'
        or lower(coalesce(connection.label, '')) like '%' || lower(trim(p_query)) || '%'
      )
  ), publication_total as (
    select coalesce(sum(publication.published_total), 0)::bigint as value
    from public.profile_publication_catalog_current publication
    where publication.organization_id = p_organization_id
  )
  select
    count(*)::bigint,
    count(*) filter (where base.status = 'online')::bigint,
    count(*) filter (where base.status = 'reauthorization_required' or base.last_error_message is not null)::bigint,
    count(*) filter (where base.status in ('offline', 'no_data'))::bigint,
    (select value from publication_total),
    (select count(*)::bigint from filtered)
  from base;
$$;

revoke all on function public.get_instagram_profiles_catalog_summary(uuid, text, uuid, text, text, text, date) from public, anon;
grant execute on function public.get_instagram_profiles_catalog_summary(uuid, text, uuid, text, text, text, date) to authenticated, service_role;

notify pgrst, 'reload schema';
