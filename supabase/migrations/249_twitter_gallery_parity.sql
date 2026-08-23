-- Paridade operacional da galeria Instagram para o catálogo isolado do X.

alter table public.twitter_media_assets
  add column if not exists thumbnail_storage_path text
    check (thumbnail_storage_path is null or char_length(thumbnail_storage_path) between 10 and 1000),
  add column if not exists first_published_at timestamptz,
  add column if not exists deletion_requested_at timestamptz;

-- Canários antigos podiam registrar o mesmo hash mais de uma vez. Preserva os
-- assets e suas referências, mas mantém o hash somente no canônico mais antigo
-- antes de ativar a unicidade para todos os uploads novos.
with ranked as (
  select id,row_number() over(partition by organization_id,sha256 order by created_at,id) position
  from public.twitter_media_assets where sha256 is not null
)
update public.twitter_media_assets asset set sha256=null
from ranked where ranked.id=asset.id and ranked.position>1;

create unique index if not exists twitter_media_assets_org_sha256_idx
  on public.twitter_media_assets(organization_id, sha256)
  where sha256 is not null;
create index if not exists twitter_media_assets_gallery_idx
  on public.twitter_media_assets(organization_id, created_at desc, id desc)
  where deleted_at is null;
create index if not exists twitter_media_assets_missing_thumbnail_idx
  on public.twitter_media_assets(organization_id, created_at)
  where deleted_at is null and media_kind='video' and thumbnail_storage_path is null;

create or replace function public.twitter_media_asset_has_storage_object(p_storage_path text)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from storage.objects object where object.bucket_id='twitter-media' and object.name=p_storage_path);
$$;

create or replace function public.twitter_mark_published_media_reused()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status='published' and old.status is distinct from new.status and new.media_set_client_key is not null then
    update public.twitter_media_assets asset set first_published_at=coalesce(asset.first_published_at,timezone('utc',now()))
    where asset.id in(
      select link.asset_id from public.twitter_program_media_sets media_set
      join public.twitter_program_media_set_assets link on link.media_set_id=media_set.id
      where media_set.program_id=new.program_id and media_set.client_key=new.media_set_client_key
    );
  end if;
  return new;
end; $$;
drop trigger if exists twitter_publication_items_mark_media_reused on public.twitter_publication_items;
create trigger twitter_publication_items_mark_media_reused after update of status on public.twitter_publication_items
for each row execute function public.twitter_mark_published_media_reused();

create or replace function public.twitter_gallery_media_page(
  p_organization_id uuid,
  p_limit integer default 30,
  p_cursor_at timestamptz default null,
  p_cursor_id uuid default null,
  p_type_filter text default 'all',
  p_situation_filter text default 'all',
  p_group_id uuid default null,
  p_ungrouped boolean default false,
  p_search text default ''
) returns table(
  id uuid, original_name text, mime_type text, media_kind text, byte_size bigint,
  width integer, height integer, duration_ms bigint, status text,
  processing_error text, storage_path text, thumbnail_storage_path text,
  first_published_at timestamptz, created_at timestamptz,
  scheduled_count bigint, next_scheduled_at timestamptz
) language sql stable security definer set search_path=public as $$
  with media_activity as (
    select link.asset_id,
      count(*) filter(where item.status in('ready','retry','claimed','outcome_unknown'))::bigint as scheduled_total,
      min(item.execute_at) filter(where item.status in('ready','retry','claimed','outcome_unknown')) as next_scheduled,
      min(item.updated_at) filter(where item.status='published') as published_at
    from public.twitter_program_media_set_assets link
    join public.twitter_program_media_sets media_set on media_set.id=link.media_set_id
    join public.twitter_publication_items item
      on item.program_id=media_set.program_id and item.media_set_client_key=media_set.client_key
      and item.organization_id=p_organization_id
    group by link.asset_id
  ), state as (
    select asset.*,
      activity.next_scheduled,
      coalesce(activity.scheduled_total,0)::bigint as scheduled_total,
      coalesce(asset.first_published_at,activity.published_at) as published_at
    from public.twitter_media_assets asset
    left join media_activity activity on activity.asset_id=asset.id
    where asset.organization_id=p_organization_id and asset.deleted_at is null
      and public.twitter_media_asset_has_storage_object(asset.storage_path)
      and (coalesce(trim(p_search),'')='' or asset.original_name ilike '%'||replace(replace(trim(p_search),'%','\%'),'_','\_')||'%' escape '\')
      and (p_type_filter='all' or asset.media_kind::text=p_type_filter)
      and (p_group_id is null or exists(select 1 from public.twitter_media_group_members member where member.asset_id=asset.id and member.group_id=p_group_id))
      and (not p_ungrouped or not exists(select 1 from public.twitter_media_group_members member where member.asset_id=asset.id))
      and (p_cursor_at is null or (asset.created_at,asset.id)<(p_cursor_at,p_cursor_id))
  )
  select state.id,state.original_name,state.mime_type,state.media_kind::text,state.byte_size,
    state.width,state.height,state.duration_ms,
    case state.status when 'uploading' then 'uploaded' else state.status::text end,
    coalesce(state.failure_message,state.failure_code),state.storage_path,state.thumbnail_storage_path,
    state.published_at,state.created_at,state.scheduled_total,state.next_scheduled
  from state
  where p_situation_filter='all'
    or (p_situation_filter='schedulable' and state.status='ready' and state.published_at is null and state.scheduled_total=0)
    or (p_situation_filter='unposted' and state.published_at is null and state.scheduled_total=0)
    or (p_situation_filter='scheduled' and state.scheduled_total>0)
    or (p_situation_filter='posted' and state.published_at is not null)
    or (p_situation_filter='posted_scheduled' and state.published_at is not null and state.scheduled_total>0)
    or (p_situation_filter='uploaded' and state.status='uploading')
    or (p_situation_filter='processing' and false)
    or (p_situation_filter='ready' and state.status='ready')
    or (p_situation_filter='failed' and state.status='failed')
  order by state.created_at desc,state.id desc
  limit greatest(1,coalesce(p_limit,30));
$$;

create or replace function public.twitter_update_media_group_assignments_bulk(
  p_organization_id uuid,p_media_asset_ids uuid[],p_group_ids uuid[],p_action text,p_actor_user_id uuid
) returns table(media_asset_id uuid,group_id uuid)
language plpgsql security definer set search_path=public as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  if p_action not in('add','remove','replace') then raise exception using errcode='22023',message='Ação de grupos inválida.'; end if;
  if exists(select 1 from unnest(p_media_asset_ids) id left join public.twitter_media_assets asset on asset.id=id and asset.organization_id=p_organization_id and asset.deleted_at is null where asset.id is null)
    or exists(select 1 from unnest(p_group_ids) id left join public.twitter_media_groups media_group on media_group.id=id and media_group.organization_id=p_organization_id and media_group.deleted_at is null where media_group.id is null)
  then raise exception using errcode='22023',message='Mídia ou grupo não pertence à organização.'; end if;
  if p_action='replace' then delete from public.twitter_media_group_members member where member.organization_id=p_organization_id and member.asset_id=any(p_media_asset_ids); end if;
  if p_action='remove' then
    delete from public.twitter_media_group_members member where member.organization_id=p_organization_id and member.asset_id=any(p_media_asset_ids) and member.group_id=any(p_group_ids);
  else
    insert into public.twitter_media_group_members(organization_id,group_id,asset_id,added_by)
    select p_organization_id,group_id,asset_id,p_actor_user_id from unnest(p_group_ids) group_id cross join unnest(p_media_asset_ids) asset_id
    on conflict(group_id,asset_id) do nothing;
  end if;
  return query select member.asset_id,member.group_id from public.twitter_media_group_members member where member.organization_id=p_organization_id and member.asset_id=any(p_media_asset_ids);
end; $$;

create or replace function public.twitter_count_gallery_media(
  p_organization_id uuid,p_type_filter text default 'all',p_situation_filter text default 'all',
  p_group_id uuid default null,p_ungrouped boolean default false,p_search text default ''
) returns bigint language sql stable security definer set search_path=public as $$
  select count(*) from public.twitter_gallery_media_page(
    p_organization_id,2147483647,null,null,p_type_filter,p_situation_filter,p_group_id,p_ungrouped,p_search
  );
$$;

revoke all on function public.twitter_gallery_media_page(uuid,integer,timestamptz,uuid,text,text,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.twitter_gallery_media_page(uuid,integer,timestamptz,uuid,text,text,uuid,boolean,text) to service_role;
revoke all on function public.twitter_media_asset_has_storage_object(text) from public,anon,authenticated;
grant execute on function public.twitter_media_asset_has_storage_object(text) to service_role;
revoke all on function public.twitter_mark_published_media_reused() from public,anon,authenticated;
revoke all on function public.twitter_count_gallery_media(uuid,text,text,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.twitter_count_gallery_media(uuid,text,text,uuid,boolean,text) to service_role;
revoke all on function public.twitter_update_media_group_assignments_bulk(uuid,uuid[],uuid[],text,uuid) from public,anon,authenticated;
grant execute on function public.twitter_update_media_group_assignments_bulk(uuid,uuid[],uuid[],text,uuid) to service_role;
notify pgrst,'reload schema';
