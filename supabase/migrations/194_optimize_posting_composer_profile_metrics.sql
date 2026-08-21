-- Corrige o timeout do compositor de postagem.
-- A implementação anterior executava várias subconsultas correlacionadas para
-- cada perfil, relendo o mesmo conjunto de publication_items repetidamente.
-- Esta versão percorre os itens elegíveis uma vez e agrega tudo por profile_id.

create or replace function public.get_posting_composer_profile_metrics(
  p_organization_id uuid,
  p_slot_horizon_days integer default 90
)
returns table (
  profile_id uuid,
  scheduled_post_count integer,
  scheduled_execute_ats jsonb,
  scheduled_execute_ats_by_format jsonb,
  scheduled_counts jsonb,
  published_counts jsonb
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_slot_horizon_days not between 1 and 366 then
    raise exception using errcode = '22023', message = 'Horizonte de agenda deve estar entre 1 e 366 dias.';
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  return query
  with profile_rows as materialized (
    select profile.id
    from public.instagram_profiles as profile
    where profile.organization_id = p_organization_id
      and profile.deleted_at is null
  ), eligible_items as materialized (
    select item.profile_id, item.format, item.status, item.execute_at
    from public.publication_items as item
    join profile_rows as profile on profile.id = item.profile_id
    where item.organization_id = p_organization_id
      and (
        item.status = 'published'
        or (
          item.status in ('waiting', 'ready', 'preparing', 'publishing')
          and (item.execute_at is null or item.execute_at > now())
        )
      )
  ), aggregated as (
    select
      item.profile_id,
      count(*) filter (
        where item.status in ('waiting', 'ready', 'preparing', 'publishing')
      )::integer as scheduled_post_count,
      coalesce(
        jsonb_agg(item.execute_at order by item.execute_at) filter (
          where item.status in ('waiting', 'ready', 'preparing', 'publishing')
            and item.execute_at is not null
            and item.execute_at <= now() + make_interval(days => p_slot_horizon_days)
        ),
        '[]'::jsonb
      ) as scheduled_execute_ats,
      jsonb_build_object(
        'reel', coalesce(jsonb_agg(item.execute_at order by item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'reel' and item.execute_at is not null and item.execute_at <= now() + make_interval(days => p_slot_horizon_days)), '[]'::jsonb),
        'story', coalesce(jsonb_agg(item.execute_at order by item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'story' and item.execute_at is not null and item.execute_at <= now() + make_interval(days => p_slot_horizon_days)), '[]'::jsonb),
        'image', coalesce(jsonb_agg(item.execute_at order by item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'image' and item.execute_at is not null and item.execute_at <= now() + make_interval(days => p_slot_horizon_days)), '[]'::jsonb),
        'carousel', coalesce(jsonb_agg(item.execute_at order by item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'carousel' and item.execute_at is not null and item.execute_at <= now() + make_interval(days => p_slot_horizon_days)), '[]'::jsonb)
      ) as scheduled_execute_ats_by_format,
      jsonb_build_object(
        'reel', count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'reel'),
        'story', count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'story'),
        'image', count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'image'),
        'carousel', count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'carousel'),
        'total', count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing'))
      ) as scheduled_counts,
      jsonb_build_object(
        'reel', count(*) filter (where item.status = 'published' and item.format = 'reel'),
        'story', count(*) filter (where item.status = 'published' and item.format = 'story'),
        'image', count(*) filter (where item.status = 'published' and item.format = 'image'),
        'carousel', count(*) filter (where item.status = 'published' and item.format = 'carousel'),
        'total', count(*) filter (where item.status = 'published')
      ) as published_counts
    from eligible_items as item
    group by item.profile_id
  )
  select
    profile.id as profile_id,
    coalesce(metric.scheduled_post_count, 0) as scheduled_post_count,
    coalesce(metric.scheduled_execute_ats, '[]'::jsonb) as scheduled_execute_ats,
    coalesce(metric.scheduled_execute_ats_by_format, jsonb_build_object('reel', '[]'::jsonb, 'story', '[]'::jsonb, 'image', '[]'::jsonb, 'carousel', '[]'::jsonb)) as scheduled_execute_ats_by_format,
    coalesce(metric.scheduled_counts, jsonb_build_object('reel', 0, 'story', 0, 'image', 0, 'carousel', 0, 'total', 0)) as scheduled_counts,
    coalesce(metric.published_counts, jsonb_build_object('reel', 0, 'story', 0, 'image', 0, 'carousel', 0, 'total', 0)) as published_counts
  from profile_rows as profile
  left join aggregated as metric on metric.profile_id = profile.id;
end;
$$;

revoke all on function public.get_posting_composer_profile_metrics(uuid, integer) from public, anon;
grant execute on function public.get_posting_composer_profile_metrics(uuid, integer) to authenticated, service_role;
