-- Limita o trabalho de manutenção Zernio por transação. Chamadores antigos
-- continuam podendo enviar os limites anteriores; a função aplica um teto
-- interno curto para não disputar I/O com publicações no horário.

create or replace function public.reset_due_zernio_media_preparation(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
  effective_limit integer;
begin
  if p_limit not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Limite de reabertura de preparação inválido';
  end if;
  effective_limit := least(p_limit, 100);

  with candidates as (
    select item.id
    from public.publication_items item
    join public.instagram_profiles profile
      on profile.id = item.profile_id and profile.organization_id = item.organization_id
    where profile.provider = 'zernio'
      and item.pipeline_version = 2
      and item.status in ('waiting', 'ready')
      and item.creation_id is null
      and item.preparation_status = 'ready'
      and item.execute_at > timezone('utc', now())
      and item.execute_at <= timezone('utc', now()) + interval '24 hours'
      and (
        exists (
          select 1
          from public.publication_item_media item_media
          left join public.zernio_prepared_media prepared
            on prepared.organization_id = item.organization_id
           and prepared.media_asset_id = item_media.media_asset_id
           and prepared.status = 'ready'
           and prepared.expires_at > item.execute_at + interval '2 hours'
          where item_media.publication_item_id = item.id
            and prepared.media_asset_id is null
        )
        or (
          item.reel_cover_media_asset_id is not null
          and not exists (
            select 1 from public.zernio_prepared_media cover
            where cover.organization_id = item.organization_id
              and cover.media_asset_id = item.reel_cover_media_asset_id
              and cover.status = 'ready'
              and cover.expires_at > item.execute_at + interval '2 hours'
          )
        )
      )
    order by item.execute_at, item.id
    limit effective_limit
    for update of item skip locked
  )
  update public.publication_items item
  set preparation_status = 'pending', prepared_at = null,
      preparation_claimed_by = null, preparation_lease_until = null,
      next_preparation_at = null, preparation_error_code = null,
      preparation_error_message = null
  from candidates
  where item.id = candidates.id
    and item.preparation_status = 'ready';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.reset_due_zernio_media_preparation(integer) from public, anon, authenticated;
grant execute on function public.reset_due_zernio_media_preparation(integer) to service_role;

create or replace function public.promote_cached_zernio_media_preparation(p_limit integer default 250)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
  effective_limit integer;
begin
  if p_limit not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'Limite de promoção de preparação inválido';
  end if;
  effective_limit := least(p_limit, 250);

  with candidates as (
    select item.id
    from public.publication_items item
    join public.instagram_profiles profile
      on profile.id = item.profile_id and profile.organization_id = item.organization_id
    where profile.provider = 'zernio'
      and profile.status = 'online'
      and profile.deleted_at is null
      and profile.zernio_account_id is not null
      and item.pipeline_version = 2
      and item.status in ('waiting', 'ready')
      and item.creation_id is null
      and item.preparation_status = 'pending'
      and item.execute_at > timezone('utc', now())
      and item.execute_at <= timezone('utc', now()) + interval '24 hours'
      and case item.format
        when 'image' then (
          select count(*) = 1 and bool_and(asset.kind = 'image' and asset.status = 'ready' and asset.deleted_at is null)
          from public.publication_item_media item_media
          join public.media_assets asset on asset.id = item_media.media_asset_id
          where item_media.publication_item_id = item.id and asset.organization_id = item.organization_id
        )
        when 'reel' then (
          select count(*) = 1 and bool_and(asset.kind = 'video' and asset.status = 'ready' and asset.deleted_at is null)
          from public.publication_item_media item_media
          join public.media_assets asset on asset.id = item_media.media_asset_id
          where item_media.publication_item_id = item.id and asset.organization_id = item.organization_id
        )
        when 'story' then (
          select count(*) = 1 and bool_and(asset.kind in ('image', 'video') and asset.status = 'ready' and asset.deleted_at is null)
          from public.publication_item_media item_media
          join public.media_assets asset on asset.id = item_media.media_asset_id
          where item_media.publication_item_id = item.id and asset.organization_id = item.organization_id
        )
        when 'carousel' then (
          select count(*) between 2 and 10 and bool_and(asset.kind in ('image', 'video') and asset.status = 'ready' and asset.deleted_at is null)
          from public.publication_item_media item_media
          join public.media_assets asset on asset.id = item_media.media_asset_id
          where item_media.publication_item_id = item.id and asset.organization_id = item.organization_id
        )
        else false
      end
      and not exists (
        select 1
        from public.publication_item_media item_media
        left join public.zernio_prepared_media prepared
          on prepared.organization_id = item.organization_id
         and prepared.media_asset_id = item_media.media_asset_id
         and prepared.status = 'ready'
         and prepared.expires_at > item.execute_at + interval '2 hours'
        where item_media.publication_item_id = item.id
          and prepared.media_asset_id is null
      )
      and (
        item.reel_cover_media_asset_id is null
        or exists (
          select 1
          from public.media_assets cover_asset
          join public.zernio_prepared_media cover
            on cover.organization_id = item.organization_id
           and cover.media_asset_id = cover_asset.id
           and cover.status = 'ready'
           and cover.expires_at > item.execute_at + interval '2 hours'
          where cover_asset.id = item.reel_cover_media_asset_id
            and cover_asset.organization_id = item.organization_id
            and cover_asset.kind = 'image'
            and cover_asset.status = 'ready'
            and cover_asset.deleted_at is null
        )
      )
    order by item.execute_at, item.id
    limit effective_limit
    for update of item skip locked
  )
  update public.publication_items item
  set preparation_status = 'ready', prepared_at = timezone('utc', now()),
      preparation_claimed_by = null, preparation_lease_until = null,
      next_preparation_at = null, preparation_error_code = null,
      preparation_error_message = null
  from candidates
  where item.id = candidates.id
    and item.preparation_status = 'pending';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.promote_cached_zernio_media_preparation(integer) from public, anon, authenticated;
grant execute on function public.promote_cached_zernio_media_preparation(integer) to service_role;
