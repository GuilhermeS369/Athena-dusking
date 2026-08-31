import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import PageLoadingSkeleton from '@/app/components/page-loading-skeleton';
import GalleryClient from '@/app/galeria/gallery-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { signMediaPreviewUrl } from '@/lib/storage/media-storage';

export const dynamic = 'force-dynamic';

export default function GalleryPage() {
  return (
    <Suspense fallback={<PageLoadingSkeleton variant="gallery" />}>
      <GalleryPageContent />
    </Suspense>
  );
}

async function GalleryPageContent() {
  const context = await getOrganizationContext();

  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  const supabase = await createSupabaseServerClient();
  const [assetsResult, groupsResult, totalCountResult] = await Promise.all([
    supabase
      .from('media_assets')
      .select('id, original_name, mime_type, kind, size_bytes, width, height, duration_ms, status, processing_error, storage_path, thumbnail_storage_path, first_published_at, created_at, updated_at')
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null)
      // Mesmo filtro de `list_gallery_media_ids`: sem isso, recarregar a página
      // durante uma fila de exclusão trazia de volta as mídias já enfileiradas.
      .is('deletion_requested_at', null)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(25),
    supabase
      .from('profile_groups')
      .select('id, name, consumption_mode')
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null)
      .order('name', { ascending: true }),
    supabase
      .from('media_assets')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null)
      .is('deletion_requested_at', null),
  ]);

  if (assetsResult.error || groupsResult.error || totalCountResult.error) {
    throw new Error('Não foi possível carregar a galeria.');
  }

  const initialAssets = (assetsResult.data ?? []).slice(0, 24);
  const initialHasMoreAssets = (assetsResult.data ?? []).length > 24;
  const initialNextCursor = initialHasMoreAssets && initialAssets.length
    ? Buffer.from(JSON.stringify({ createdAt: initialAssets[initialAssets.length - 1].created_at, id: initialAssets[initialAssets.length - 1].id })).toString('base64url')
    : null;

  const initialAssetIds = initialAssets.map((asset) => asset.id);
  const [assignmentsResult, mediaPublicationStatesResult] = initialAssetIds.length
    ? await Promise.all([
      supabase
        .from('media_group_assignments')
        .select('media_asset_id, group_id')
        .eq('organization_id', context.activeOrganization.id)
        .in('media_asset_id', initialAssetIds),
      supabase
        .rpc('get_media_publication_states', {
          p_organization_id: context.activeOrganization.id,
          p_media_asset_ids: initialAssetIds,
        }),
    ])
    : [{ data: [], error: null }, { data: [], error: null }];

  if (assignmentsResult.error || mediaPublicationStatesResult.error) {
    throw new Error('Não foi possível carregar as relações das mídias.');
  }

  const mediaPublicationStates = new Map<string, { scheduled_count: number; next_scheduled_at: string | null }>();
  for (const row of mediaPublicationStatesResult.data ?? []) {
    if (!row.scheduled_count) continue;
    mediaPublicationStates.set(row.media_asset_id, {
      scheduled_count: row.scheduled_count,
      next_scheduled_at: row.next_scheduled_at,
    });
  }

  const signedAssets = await Promise.all(initialAssets.map(async (asset) => {
    const [signed, thumbnail] = await Promise.all([
      asset.kind === 'image' || asset.kind === 'video'
        ? signMediaPreviewUrl(supabase, asset.storage_path, 60 * 30, asset.kind === 'image' ? { width: 240, height: 240, resize: 'contain', quality: 60, format: 'origin' } : undefined)
        : Promise.resolve({ data: null }),
      asset.thumbnail_storage_path ? signMediaPreviewUrl(supabase, asset.thumbnail_storage_path, 60 * 10) : Promise.resolve({ data: null }),
    ]);
    return {
      ...asset,
      signed_url: signed.data?.signedUrl ?? null,
      thumbnail_url: thumbnail.data?.signedUrl ?? null,
      publication_state: mediaPublicationStates.get(asset.id) ?? null,
    };
  }));

  return (
    <GalleryClient activeOrganization={context.activeOrganization} assets={signedAssets} initialHasMoreAssets={initialHasMoreAssets} initialNextCursor={initialNextCursor} initialTotal={totalCountResult.count ?? 0} groups={groupsResult.data ?? []} assignments={assignmentsResult.data ?? []} />
  );
}
