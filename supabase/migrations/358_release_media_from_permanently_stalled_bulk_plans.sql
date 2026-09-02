-- Solta as mídias presas por planos compactos que nunca mais vão gerar nada.
--
-- Contexto do incidente (org "Vini farmando cash", grupo "Julio", 2026-09-02):
-- o plano "Julio / 17/08 23h / Reels" ficou em `paused` desde 18/08 porque 3 dos
-- 92 perfis estavam offline quando o worker chegou neles. O tratamento de perfil
-- offline em `process_bulk_rotation_generation_chunk` marca o chunk como
-- `paused` e o plan_profile como `suspended` ("retomada manual necessária"), e
-- não existe nenhum caminho no código que volte um plan_profile de `suspended`
-- para ativo. Como `refresh_bulk_rotation_plan_state` mantém o plano em `paused`
-- enquanto houver chunk pausado, o plano fica nesse estado para sempre.
--
-- `media_asset_is_in_active_generation_job` considerava qualquer plano em
-- ('queued','generating','paused') como ativo, então as 69 mídias do grupo
-- continuavam bloqueadas para exclusão indefinidamente — e sem nenhuma pista na
-- interface, porque a galeria só devolvia "Nenhuma mídia selecionada está
-- disponível para exclusão".
--
-- Aqui um plano pausado só continua segurando mídia enquanto sobrar chunk que
-- ainda possa gerar, isto é, cujo plan_profile não esteja suspenso nem
-- cancelado. Pausa operacional (`set_bulk_rotation_plan_generation_hold`) segue
-- protegida: ela pausa os chunks mas deixa os plan_profiles ativos.

create or replace function public.bulk_rotation_plan_can_still_generate(
  p_plan_id uuid,
  p_plan_status text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    -- Plano recém-criado ainda pode não ter chunk materializado: sempre segura.
    when p_plan_status in ('queued', 'generating') then true
    when p_plan_status <> 'paused' then false
    else exists (
      select 1
      from public.bulk_publication_generation_chunks chunk
      join public.bulk_publication_plan_profiles profile_plan
        on profile_plan.id = chunk.plan_profile_id
      where chunk.plan_id = p_plan_id
        and chunk.status in ('queued', 'processing', 'paused')
        and profile_plan.status not in ('suspended', 'cancelled')
    )
  end;
$$;

create or replace function public.media_asset_is_in_active_generation_job(
  p_organization_id uuid,
  p_media_asset_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.publication_generation_jobs job
    cross join lateral jsonb_array_elements(case when jsonb_typeof(job.payload -> 'items') = 'array' then job.payload -> 'items' else '[]'::jsonb end) payload_item(item)
    where job.organization_id = p_organization_id and job.status in ('queued', 'processing', 'paused')
      and jsonb_typeof(payload_item.item -> 'mediaIds') = 'array'
      and exists (select 1 from jsonb_array_elements_text(payload_item.item -> 'mediaIds') media_value(id) where media_value.id = p_media_asset_id::text)
  ) or exists (
    select 1 from public.publication_generation_job_chunks chunk
    join public.publication_generation_jobs job on job.id = chunk.job_id
    cross join lateral jsonb_array_elements(case when jsonb_typeof(chunk.payload) = 'array' then chunk.payload else '[]'::jsonb end) payload_item(item)
    where chunk.organization_id = p_organization_id and job.organization_id = p_organization_id
      and job.status in ('queued', 'processing', 'paused') and chunk.status in ('queued', 'processing', 'failed')
      and jsonb_typeof(payload_item.item -> 'mediaIds') = 'array'
      and exists (select 1 from jsonb_array_elements_text(payload_item.item -> 'mediaIds') media_value(id) where media_value.id = p_media_asset_id::text)
  ) or exists (
    select 1 from public.bulk_publication_plan_media plan_media
    join public.bulk_publication_plans plan on plan.id = plan_media.plan_id
    where plan_media.organization_id = p_organization_id and plan_media.media_asset_id = p_media_asset_id
      and plan.status in ('queued', 'generating', 'paused')
      and public.bulk_rotation_plan_can_still_generate(plan.id, plan.status)
  ) or exists (
    select 1 from public.bulk_publication_plans plan
    where plan.organization_id = p_organization_id and plan.reel_cover_media_asset_id = p_media_asset_id
      and plan.status in ('queued', 'generating', 'paused')
      and public.bulk_rotation_plan_can_still_generate(plan.id, plan.status)
  ) or exists (
    select 1 from public.publication_items item
    where item.organization_id = p_organization_id and item.reel_cover_media_asset_id = p_media_asset_id
      and item.status in ('draft', 'waiting', 'preparing', 'ready', 'publishing', 'failed', 'suspended')
  );
$$;

-- A migration 066 acrescentou o guarda de geração ativa em
-- `count_gallery_media_ids` e em `list_gallery_media_ids_for_deletion`, mas
-- `list_gallery_media_ids` ficou na versão da 052, sem o guarda. O total e a
-- listagem da galeria vinham de filtros diferentes: a grade mostrava mídia que a
-- exclusão recusava sem explicar por quê. Aqui as três funções voltam a usar o
-- mesmo filtro.
create or replace function public.list_gallery_media_ids(
  p_organization_id uuid,
  p_situation_filter text default 'all',
  p_type_filter text default 'all',
  p_group_id uuid default null,
  p_ungrouped boolean default false,
  p_search text default '',
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 31
)
returns table (media_asset_id uuid, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  with media_state as (
    select asset.id, asset.created_at, asset.status, (asset.first_published_at is not null) as is_published,
      exists (
        select 1 from public.publication_item_media link
        join public.publication_items item on item.id = link.publication_item_id and item.organization_id = link.organization_id
        where link.organization_id = p_organization_id and link.media_asset_id = asset.id
          and public.media_item_is_active_schedule(item.status, item.execute_at, item.published_at)
      ) as is_scheduled
    from public.media_assets asset
    where asset.organization_id = p_organization_id
      and asset.deleted_at is null
      and asset.deletion_requested_at is null
      and public.media_asset_has_storage_object(asset.storage_path)
      and public.is_organization_member(p_organization_id)
      and not public.media_asset_is_in_active_generation_job(p_organization_id, asset.id)
      and (p_type_filter = 'all' or asset.kind::text = p_type_filter)
      and (coalesce(nullif(trim(p_search), ''), '') = '' or asset.original_name ilike ('%' || replace(replace(replace(trim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%') escape '\')
      and ((p_group_id is null and not p_ungrouped) or (p_group_id is not null and exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id and assignment.group_id = p_group_id)) or (p_ungrouped and not exists (select 1 from public.media_group_assignments assignment where assignment.organization_id = p_organization_id and assignment.media_asset_id = asset.id)))
  )
  select state.id, state.created_at
  from media_state state
  where (p_situation_filter = 'all'
    or (p_situation_filter = 'schedulable' and state.status = 'ready' and not state.is_published and not state.is_scheduled)
    or (p_situation_filter = 'unposted' and not state.is_published and not state.is_scheduled)
    or (p_situation_filter = 'scheduled' and state.is_scheduled)
    or (p_situation_filter = 'posted' and state.is_published)
    or (p_situation_filter = 'posted_scheduled' and state.is_published and state.is_scheduled)
    or (p_situation_filter in ('uploaded', 'processing', 'ready', 'failed') and state.status::text = p_situation_filter))
    and (p_cursor_created_at is null or state.created_at < p_cursor_created_at or (state.created_at = p_cursor_created_at and state.id < p_cursor_id))
  order by state.created_at desc, state.id desc
  limit greatest(1, least(p_limit, 101));
$$;

revoke all on function public.bulk_rotation_plan_can_still_generate(uuid, text) from public, anon;
revoke all on function public.media_asset_is_in_active_generation_job(uuid, uuid) from public, anon;
revoke all on function public.list_gallery_media_ids(uuid, text, text, uuid, boolean, text, timestamptz, uuid, integer) from public, anon;

grant execute on function public.bulk_rotation_plan_can_still_generate(uuid, text) to service_role;
grant execute on function public.media_asset_is_in_active_generation_job(uuid, uuid) to service_role;
grant execute on function public.list_gallery_media_ids(uuid, text, text, uuid, boolean, text, timestamptz, uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
