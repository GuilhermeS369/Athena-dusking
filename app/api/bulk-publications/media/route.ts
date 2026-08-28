import { NextResponse } from 'next/server';

import { decodeBulkMediaCursor, encodeBulkMediaCursor } from '@/lib/publications/bulk-api';
import type { BulkRotationFormat } from '@/lib/publications/bulk-rotation';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { signMediaPreviewUrl } from '@/lib/storage/media-storage';

export const dynamic = 'force-dynamic';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  const url = new URL(request.url);
  const originType = url.searchParams.get('originType');
  const groupId = url.searchParams.get('groupId');
  const format = url.searchParams.get('format') as BulkRotationFormat | null;
  const rawCursor = url.searchParams.get('cursor');
  const cursor = decodeBulkMediaCursor(rawCursor);
  const requestedLimit = Number(url.searchParams.get('limit') ?? 60);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 60;
  if (!['group', 'ungrouped'].includes(originType ?? '') || !['image', 'reel', 'story'].includes(format ?? '')) return NextResponse.json({ error: 'Origem ou formato inválido.' }, { status: 400 });
  if (originType === 'group' && (!groupId || !uuidPattern.test(groupId))) return NextResponse.json({ error: 'Grupo inválido.' }, { status: 400 });
  if (originType === 'ungrouped' && groupId) return NextResponse.json({ error: 'Origem sem grupo inválida.' }, { status: 400 });
  if (rawCursor && !cursor) return NextResponse.json({ error: 'Cursor inválido.' }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const args = { p_organization_id: context.activeOrganization.id, p_origin_type: originType, p_origin_group_id: originType === 'group' ? groupId : null, p_format: format };
  const [{ data: summary, error: summaryError }, { data: rows, error: rowsError }] = await Promise.all([
    supabase.rpc('get_bulk_rotation_media_summary', args),
    supabase.rpc('list_bulk_rotation_media_ids', { ...args, p_cursor_created_at: cursor?.createdAt ?? null, p_cursor_id: cursor?.id ?? null, p_limit: limit + 1 }),
  ]);
  if (summaryError || rowsError) return NextResponse.json({ error: 'Não foi possível revisar as mídias da origem.' }, { status: 500 });
  const pageRows = (rows ?? []).slice(0, limit) as Array<{ media_asset_id: string; created_at: string }>;
  const hasMore = (rows?.length ?? 0) > limit;
  const ids = pageRows.map((row) => row.media_asset_id);
  const { data: assets, error: assetError } = ids.length ? await supabase.from('media_assets').select('id, original_name, kind, thumbnail_storage_path, storage_path').eq('organization_id', context.activeOrganization.id).in('id', ids) : { data: [], error: null };
  if (assetError) return NextResponse.json({ error: 'Não foi possível carregar as miniaturas.' }, { status: 500 });
  const byId = new Map((assets ?? []).map((asset) => [asset.id, asset]));
  const preview = await Promise.all(ids.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []).map(async (asset) => {
    const path = asset.thumbnail_storage_path ?? asset.storage_path;
    const signed = await signMediaPreviewUrl(supabase, path, 60 * 10, asset.kind === 'image' && !asset.thumbnail_storage_path ? { width: 240, height: 240, resize: 'contain', quality: 60, format: 'origin' } : undefined);
    return { id: asset.id, originalName: asset.original_name, kind: asset.kind, thumbnailUrl: signed.data?.signedUrl ?? null };
  }));
  const last = pageRows.at(-1);
  return NextResponse.json({ summary, assets: preview, hasMore, nextCursor: hasMore && last ? encodeBulkMediaCursor({ createdAt: last.created_at, id: last.media_asset_id }) : null }, { headers: { 'Cache-Control': 'no-store' } });
}
