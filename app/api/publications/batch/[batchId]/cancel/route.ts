import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const ACTIVE_MEDIA_STATUSES = ['waiting', 'ready', 'preparing', 'publishing'];
type CancelScope = 'entire_batch' | 'visible_items';

export async function POST(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const context = await getOrganizationContext();
  const { batchId } = await params;
  const role = context.organizations.find((organization) => organization.id === context.activeOrganization?.id)?.role;
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  if (!role || !['admin', 'operator'].includes(role)) return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });

  let body: { scope?: unknown; itemIds?: unknown };
  try { body = await request.json() as typeof body; } catch { return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 }); }
  const scope: CancelScope | null = body.scope === 'entire_batch' || body.scope === 'visible_items' ? body.scope : null;
  const itemIds = Array.isArray(body.itemIds) && body.itemIds.every((id) => typeof id === 'string') ? [...new Set(body.itemIds)] : null;
  if (!scope || (scope === 'visible_items' && !itemIds?.length)) return NextResponse.json({ error: 'Informe um escopo e itens válidos para cancelar.' }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const organizationId = context.activeOrganization.id;
  const { data: batch, error: batchError } = await supabase.from('publication_batches').select('id').eq('id', batchId).eq('organization_id', organizationId).maybeSingle();
  if (batchError || !batch) return NextResponse.json({ error: 'Lote de publicação não encontrado.' }, { status: 404 });

  const { data: cancelledRows, error: cancelError } = await supabase.rpc('cancel_publication_batch_items', {
    p_batch_id: batchId, p_item_ids: scope === 'visible_items' ? itemIds : null, p_scope: scope,
  });
  if (cancelError) return NextResponse.json({ error: 'Não foi possível cancelar as publicações do lote.' }, { status: 500 });
  const cancelledItemIds = (cancelledRows ?? []).map((row: { cancelled_item_id: string }) => row.cancelled_item_id);

  const [{ data: items, error: itemsError }, { data: batchState, error: batchStateError }] = await Promise.all([
    supabase.from('publication_items').select('id, publication_item_media(media_asset_id)').eq('organization_id', organizationId).eq('batch_id', batchId),
    supabase.from('publication_batches').select('id, status, updated_at').eq('id', batchId).eq('organization_id', organizationId).single(),
  ]);
  if (itemsError || batchStateError || !batchState) return NextResponse.json({ error: 'As publicações foram canceladas, mas não foi possível carregar o resultado.' }, { status: 500 });
  const affectedAssetIds = [...new Set((items ?? []).filter((item) => cancelledItemIds.includes(item.id)).flatMap((item) => (item.publication_item_media ?? []).map((media) => media.media_asset_id)))];
  const { data: mediaRows, error: mediaError } = affectedAssetIds.length ? await supabase.from('publication_item_media').select('media_asset_id, publication_items(status, execute_at, published_at)').eq('organization_id', organizationId).in('media_asset_id', affectedAssetIds) : { data: [], error: null };
  if (mediaError) return NextResponse.json({ error: 'As publicações foram canceladas, mas não foi possível atualizar as mídias.' }, { status: 500 });

  const mediaStates = new Map<string, { scheduled_count: number; next_scheduled_at: string | null; has_published: boolean }>();
  for (const row of mediaRows ?? []) {
    const item = Array.isArray(row.publication_items) ? row.publication_items[0] : row.publication_items;
    if (!item) continue;
    const state = mediaStates.get(row.media_asset_id) ?? { scheduled_count: 0, next_scheduled_at: null, has_published: false };
    if (ACTIVE_MEDIA_STATUSES.includes(item.status)) { state.scheduled_count += 1; if (item.execute_at && (!state.next_scheduled_at || item.execute_at < state.next_scheduled_at)) state.next_scheduled_at = item.execute_at; }
    if (item.status === 'published' || item.published_at) state.has_published = true;
    mediaStates.set(row.media_asset_id, state);
  }
  return NextResponse.json({ batch: batchState, cancelledItemIds, skippedItemIds: (items ?? []).filter((item) => !cancelledItemIds.includes(item.id)).map((item) => item.id), mediaStates: affectedAssetIds.map((assetId) => ({ assetId, ...(mediaStates.get(assetId) ?? { scheduled_count: 0, next_scheduled_at: null, has_published: false }) })) });
}
