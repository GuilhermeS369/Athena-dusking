-- Rollups de publicações para a dashboard.
-- Evita carregar centenas/milhares de publication_items recentes só para montar
-- gráficos de status, formato, série temporal e melhores horários no cliente.

create or replace function public.get_dashboard_publication_rollups(
  p_organization_id uuid,
  p_days integer default 365
)
returns table (
  kind text,
  profile_id uuid,
  label text,
  total integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_days not between 1 and 366 then
    raise exception using errcode = '22023', message = 'Período deve estar entre 1 e 366 dias.';
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
    select
      item.profile_id,
      item.status::text as status_label,
      item.format::text as format_label,
      coalesce(item.published_at, item.execute_at, item.created_at) as event_at
    from public.publication_items as item
    join profile_rows as profile on profile.id = item.profile_id
    where item.organization_id = p_organization_id
      and item.status not in ('removed', 'cancelled', 'ignored')
  ), recent_items as (
    select *
    from scoped_items
    where event_at >= timezone('utc', now()) - make_interval(days => p_days)
  )
  select 'status'::text, item.profile_id, item.status_label, count(*)::integer
  from scoped_items as item
  group by item.profile_id, item.status_label

  union all

  select 'format'::text, item.profile_id, item.format_label, count(*)::integer
  from scoped_items as item
  group by item.profile_id, item.format_label

  union all

  select 'day'::text, item.profile_id, to_char(timezone('America/Sao_Paulo', item.event_at), 'DD/MM'), count(*)::integer
  from recent_items as item
  group by item.profile_id, to_char(timezone('America/Sao_Paulo', item.event_at), 'DD/MM'), date_trunc('day', timezone('America/Sao_Paulo', item.event_at))

  union all

  select
    'hour'::text,
    item.profile_id,
    concat(
      case extract(dow from timezone('America/Sao_Paulo', item.event_at))::integer
        when 0 then 'dom'
        when 1 then 'seg'
        when 2 then 'ter'
        when 3 then 'qua'
        when 4 then 'qui'
        when 5 then 'sex'
        else 'sáb'
      end,
      ' ',
      lpad(extract(hour from timezone('America/Sao_Paulo', item.event_at))::integer::text, 2, '0'),
      'h'
    ),
    count(*)::integer
  from recent_items as item
  group by item.profile_id, extract(dow from timezone('America/Sao_Paulo', item.event_at)), extract(hour from timezone('America/Sao_Paulo', item.event_at));
end;
$$;

revoke all on function public.get_dashboard_publication_rollups(uuid, integer) from public, anon;
grant execute on function public.get_dashboard_publication_rollups(uuid, integer) to authenticated, service_role;
