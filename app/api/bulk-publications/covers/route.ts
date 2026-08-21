import { NextResponse } from 'next/server';

import { decodeBulkMediaCursor, encodeBulkMediaCursor } from '@/lib/publications/bulk-api';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });

  const url = new URL(request.url);
  const originType = url.searchParams.get('originType');
  const groupId = url.searchParams.get('groupId');
  const rawCursor = url.searchParams.get('cursor');
  const cursor = decodeBulkMediaCursor(rawCursor);
  const requestedLimit = Number(url.searchParams.get('limit') ?? 36);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 60) : 36;
  if (!['group', 'ungrouped'].includes(originType ?? '')) return NextResponse.json({ error: 'Origem de capas inválida.' }, { status: 400 });
  if (originType === 'group' && (!groupId || !uuidPattern.test(groupId))) return NextResponse.json({ error: 'Grupo de capas inválido.' }, { status: 400 });
  if (originType === 'ungrouped' && groupId) return NextResponse.json({ error: 'Origem sem grupo inválida.' }, { status: 400 });
  if (rawCursor && !cursor) return NextResponse.json({ error: 'Cursor inválido.' }, { status: 400 });

  const organizationId = context.activeOrganization.id;
  const supabase = await createSupabaseServerClient();
  const { data: rows, error } = await supabase.rpc('list_bulk_rotation_media_ids', {
    p_organization_id: organizationId,
    p_origin_type: originType,
    p_origin_group_id: originType === 'group' ? groupId : null,
    p_format: 'image',
    p_cursor_created_at: cursor?.createdAt ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_limit: limit + 1,
  });
  if (error) return NextResponse.json({ error: 'Não foi possível carregar as capas.' }, { status: 500 });
  const pageRows = (rows ?? []).slice(0, limit) as Array<{ media_asset_id: string; created_at: string }>;
  const ids = pageRows.map((row) => row.media_asset_id);
  const { data: candidates, error: assetError } = ids.length
    ? await supabase.from('media_assets').select('id, original_name, storage_path').eq('organization_id', organizationId).in('id', ids)
    : { data: [], error: null };
  if (assetError) return NextResponse.json({ error: 'Não foi possível carregar as miniaturas das capas.' }, { status: 500 });
  const byId = new Map((candidates ?? []).map((asset) => [asset.id, asset]));
  const eligible = ids.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []);
  const assets = await Promise.all(eligible.map(async (asset) => {
    const signed = await supabase.storage.from('instagram-media').createSignedUrl(asset.storage_path, 60 * 10, {
      transform: { width: 270, height: 480, resize: 'contain', quality: 70, format: 'origin' },
    });
    return { id: asset.id, originalName: asset.original_name, kind: 'image' as const, thumbnailUrl: signed.data?.signedUrl ?? null };
  }));
  const hasMore = (rows?.length ?? 0) > limit;
  const last = pageRows.at(-1);
  return NextResponse.json({
    assets,
    hasMore,
    nextCursor: hasMore && last ? encodeBulkMediaCursor({ createdAt: last.created_at, id: last.media_asset_id }) : null,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
