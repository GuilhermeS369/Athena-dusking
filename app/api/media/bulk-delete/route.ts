import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { removeMediaObjectsEverywhere } from '@/lib/storage/media-storage';

const MAX_BULK_DELETE_SIZE = 100;
const MAX_FILTER_DELETE_SIZE = 50000;
type GallerySituationFilter = 'all' | 'schedulable' | 'unposted' | 'scheduled' | 'posted' | 'posted_scheduled' | 'uploaded' | 'processing' | 'ready' | 'failed';
const GALLERY_SITUATION_FILTERS = new Set<GallerySituationFilter>(['all', 'schedulable', 'unposted', 'scheduled', 'posted', 'posted_scheduled', 'uploaded', 'processing', 'ready', 'failed']);

type DeletedMediaResult = {
  media_asset_id: string;
  storage_path: string;
  thumbnail_storage_path: string | null;
  affected_item_ids: string[] | null;
  affected_batch_ids: string[] | null;
};

type DeleteJobResult = {
  job_id: string;
  total_count: number;
};

type BulkDeleteBody = {
  assetIds?: unknown;
  selectAllMatching?: unknown;
  dryRun?: unknown;
  filters?: {
    search?: unknown;
    type?: unknown;
    status?: unknown;
    group?: unknown;
  };
};

function parseFilters(body: BulkDeleteBody) {
  const filters = body.filters ?? {};
  const type = filters.type === 'image' || filters.type === 'video' ? filters.type : 'all';
  const status = GALLERY_SITUATION_FILTERS.has(filters.status as GallerySituationFilter) ? filters.status as GallerySituationFilter : 'all';
  const group = typeof filters.group === 'string' ? filters.group : 'all';
  return {
    search: typeof filters.search === 'string' ? filters.search.trim().slice(0, 100) : '',
    type,
    status,
    groupId: group !== 'all' && group !== 'none' ? group : null,
    ungrouped: group === 'none',
  };
}

async function deleteAssetsNow(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  organizationId: string,
  assetIds: string[],
) {
  const { data, error: deleteError } = await supabase.rpc('delete_media_assets_and_remove_publication_items', {
    p_organization_id: organizationId,
    p_media_asset_ids: assetIds,
  });
  const assets = (data ?? []) as DeletedMediaResult[];

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message || 'Não foi possível excluir as mídias.' }, { status: deleteError.code === '42501' ? 403 : 400 });
  }

  const existingIds = assets.map((asset) => asset.media_asset_id);
  if (!existingIds.length) {
    return NextResponse.json({ error: 'Nenhuma mídia selecionada está disponível para exclusão.' }, { status: 404 });
  }

  const storagePaths = [...new Set(assets.flatMap((asset) => [
    asset.storage_path,
    ...(asset.thumbnail_storage_path ? [asset.thumbnail_storage_path] : []),
  ]))];
  const { error: storageError } = await removeMediaObjectsEverywhere(supabase, storagePaths);

  const responseBody = {
    deletedIds: existingIds,
    affectedItemIds: [...new Set(assets.flatMap((asset) => asset.affected_item_ids ?? []))],
    affectedBatchIds: [...new Set(assets.flatMap((asset) => asset.affected_batch_ids ?? []))],
  };

  if (storageError) {
    return NextResponse.json({
      ...responseBody,
      error: 'Mídias apagadas da galeria, mas alguns arquivos físicos não puderam ser removidos.',
    }, { status: 207 });
  }

  return NextResponse.json(responseBody);
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  const organization = context.organizations.find(
    (item) => item.id === context.activeOrganization?.id,
  );

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  if (!organization || !['admin', 'operator'].includes(organization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  let body: BulkDeleteBody;
  try {
    body = await request.json() as BulkDeleteBody;
  } catch {
    return NextResponse.json({ error: 'Dados da exclusão inválidos.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  if (body.selectAllMatching === true) {
    const filters = parseFilters(body);
    const { data: total, error: totalError } = await supabase.rpc('count_gallery_media_ids', {
      p_organization_id: context.activeOrganization.id,
      p_situation_filter: filters.status,
      p_type_filter: filters.type,
      p_group_id: filters.groupId,
      p_ungrouped: filters.ungrouped,
      p_search: filters.search,
    });
    if (totalError) return NextResponse.json({ error: 'Não foi possível contar as mídias deste filtro.' }, { status: 500 });
    if (!total) return NextResponse.json({ error: 'Nenhuma mídia deste filtro está disponível para exclusão.' }, { status: 404 });
    if (total > MAX_FILTER_DELETE_SIZE) {
      return NextResponse.json({ error: `Este filtro contém mais de ${MAX_FILTER_DELETE_SIZE} mídias. Refine os filtros antes de excluir em massa.` }, { status: 400 });
    }
    if (body.dryRun === true) return NextResponse.json({ total }, { headers: { 'Cache-Control': 'no-store' } });

    if (total <= MAX_BULK_DELETE_SIZE) {
      const { data: idRows, error: idsError } = await supabase.rpc('list_gallery_media_ids_for_deletion', {
        p_organization_id: context.activeOrganization.id,
        p_situation_filter: filters.status,
        p_type_filter: filters.type,
        p_group_id: filters.groupId,
        p_ungrouped: filters.ungrouped,
        p_search: filters.search,
        p_limit: MAX_BULK_DELETE_SIZE,
      });
      if (idsError) return NextResponse.json({ error: 'Não foi possível localizar as mídias deste filtro.' }, { status: 500 });
      return deleteAssetsNow(supabase, context.activeOrganization.id, ((idRows ?? []) as Array<{ media_asset_id: string }>).map((row) => row.media_asset_id));
    }

    const { data: jobRows, error: jobError } = await supabase.rpc('create_gallery_filter_media_deletion_job', {
      p_organization_id: context.activeOrganization.id,
      p_situation_filter: filters.status,
      p_type_filter: filters.type,
      p_group_id: filters.groupId,
      p_ungrouped: filters.ungrouped,
      p_search: filters.search,
    });
    if (jobError) return NextResponse.json({ error: jobError.message || 'Não foi possível criar a fila de exclusão.' }, { status: jobError.code === '42501' ? 403 : 400 });
    const job = ((jobRows ?? []) as DeleteJobResult[])[0];
    if (!job?.total_count) return NextResponse.json({ error: 'Nenhuma mídia deste filtro está disponível para exclusão.' }, { status: 404 });
    return NextResponse.json({ queued: true, job: { id: job.job_id, totalCount: job.total_count } }, { status: 202 });
  }

  const assetIds = Array.isArray(body.assetIds)
    ? [...new Set(body.assetIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : [];

  if (!assetIds.length) {
    return NextResponse.json({ error: 'Selecione ao menos uma mídia para excluir.' }, { status: 400 });
  }

  if (assetIds.length <= MAX_BULK_DELETE_SIZE) {
    return deleteAssetsNow(supabase, context.activeOrganization.id, assetIds);
  }

  const { data: jobRows, error: jobError } = await supabase.rpc('create_media_deletion_job', {
    p_organization_id: context.activeOrganization.id,
    p_media_asset_ids: assetIds,
  });
  if (jobError) return NextResponse.json({ error: jobError.message || 'Não foi possível criar a fila de exclusão.' }, { status: jobError.code === '42501' ? 403 : 400 });
  const job = ((jobRows ?? []) as DeleteJobResult[])[0];
  if (!job?.total_count) return NextResponse.json({ error: 'Nenhuma mídia selecionada está disponível para exclusão.' }, { status: 404 });

  return NextResponse.json({ queued: true, job: { id: job.job_id, totalCount: job.total_count }, queuedAssetIds: assetIds }, { status: 202 });
}
