-- Métricas agregadas para o compositor de postagem.
-- Remove a necessidade de carregar todas as publicações futuras/publicadas na
-- abertura da tela e deixa a agregação perto dos índices do Postgres.

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

  if not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  return query
  with profile_rows as (
    select profile.id
    from public.instagram_profiles as profile
    where profile.organization_id = p_organization_id
      and profile.deleted_at is null
  ), scoped_items as (
    select item.profile_id, item.format, item.status, item.execute_at
    from public.publication_items as item
    join profile_rows as profile on profile.id = item.profile_id
    where item.organization_id = p_organization_id
      and (
        item.status = 'published'
        or (
          item.status in ('waiting', 'ready', 'preparing', 'publishing')
          and (item.execute_at is null or item.execute_at > timezone('utc', now()))
        )
      )
  ), slot_items as (
    select *
    from scoped_items
    where status in ('waiting', 'ready', 'preparing', 'publishing')
      and execute_at is not null
      and execute_at > timezone('utc', now())
      and execute_at <= timezone('utc', now()) + make_interval(days => p_slot_horizon_days)
  )
  select
    profile.id as profile_id,
    coalesce((
      select count(*)::integer
      from scoped_items as item
      where item.profile_id = profile.id
        and item.status in ('waiting', 'ready', 'preparing', 'publishing')
    ), 0) as scheduled_post_count,
    coalesce((
      select jsonb_agg(item.execute_at order by item.execute_at)
      from slot_items as item
      where item.profile_id = profile.id
    ), '[]'::jsonb) as scheduled_execute_ats,
    jsonb_build_object(
      'reel', coalesce((select jsonb_agg(item.execute_at order by item.execute_at) from slot_items as item where item.profile_id = profile.id and item.format = 'reel'), '[]'::jsonb),
      'story', coalesce((select jsonb_agg(item.execute_at order by item.execute_at) from slot_items as item where item.profile_id = profile.id and item.format = 'story'), '[]'::jsonb),
      'image', coalesce((select jsonb_agg(item.execute_at order by item.execute_at) from slot_items as item where item.profile_id = profile.id and item.format = 'image'), '[]'::jsonb),
      'carousel', coalesce((select jsonb_agg(item.execute_at order by item.execute_at) from slot_items as item where item.profile_id = profile.id and item.format = 'carousel'), '[]'::jsonb)
    ) as scheduled_execute_ats_by_format,
    jsonb_build_object(
      'reel', coalesce((select count(*)::integer from scoped_items as item where item.profile_id = profile.id and item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'reel'), 0),
      'story', coalesce((select count(*)::integer from scoped_items as item where item.profile_id = profile.id and item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'story'), 0),
      'image', coalesce((select count(*)::integer from scoped_items as item where item.profile_id = profile.id and item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'image'), 0),
      'carousel', coalesce((select count(*)::integer from scoped_items as item where item.profile_id = profile.id and item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'carousel'), 0),
      'total', coalesce((select count(*)::integer from scoped_items as item where item.profile_id = profile.id and item.status in ('waiting', 'ready', 'preparing', 'publishing')), 0)
    ) as scheduled_counts,
    jsonb_build_object(
      'reel', coalesce((select count(*)::integer from scoped_items as item where item.profile_id = profile.id and item.status = 'published' and item.format = 'reel'), 0),
      'story', coalesce((select count(*)::integer from scoped_items as item where item.profile_id = profile.id and item.status = 'published' and item.format = 'story'), 0),
      'image', coalesce((select count(*)::integer from scoped_items as item where item.profile_id = profile.id and item.status = 'published' and item.format = 'image'), 0),
      'carousel', coalesce((select count(*)::integer from scoped_items as item where item.profile_id = profile.id and item.status = 'published' and item.format = 'carousel'), 0),
      'total', coalesce((select count(*)::integer from scoped_items as item where item.profile_id = profile.id and item.status = 'published'), 0)
    ) as published_counts
  from profile_rows as profile;
end;
$$;

revoke all on function public.get_posting_composer_profile_metrics(uuid, integer) from public, anon;
grant execute on function public.get_posting_composer_profile_metrics(uuid, integer) to authenticated, service_role;
