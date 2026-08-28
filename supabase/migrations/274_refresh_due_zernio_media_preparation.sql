-- Mantém a janela móvel de 24h após a migração inicial: itens que entram na
-- janela ou cuja mídia preparada expirou voltam à preparação em páginas curtas.

create or replace function public.reset_due_zernio_media_preparation(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  if p_limit not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Limite de reabertura de preparação inválido';
  end if;
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
    limit p_limit
    for update of item skip locked
  )
  update public.publication_items item
  set preparation_status = 'pending', prepared_at = null,
      preparation_claimed_by = null, preparation_lease_until = null,
      next_preparation_at = null, preparation_error_code = null,
      preparation_error_message = null
  from candidates
  where item.id = candidates.id;
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.reset_due_zernio_media_preparation(integer) from public, anon, authenticated;
grant execute on function public.reset_due_zernio_media_preparation(integer) to service_role;
