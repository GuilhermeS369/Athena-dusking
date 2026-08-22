import { notFound, redirect } from 'next/navigation';

import TwitterGalleryClient from '@/app/x/twitter-gallery-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterModuleEnabled } from '@/lib/twitter/feature';

export const dynamic = 'force-dynamic';

export default async function TwitterGalleryPage() {
  const context = await getOrganizationContext(); if (!context.user) redirect('/login'); if (!context.activeOrganization) redirect('/onboarding'); if (!isTwitterModuleEnabled(context.activeOrganization.id)) notFound();
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from('twitter_media_assets').select('id,original_name,mime_type,media_kind,byte_size,storage_path').eq('organization_id', context.activeOrganization.id).eq('status', 'ready').is('deleted_at', null).order('created_at', { ascending: false });
  if (error) throw new Error('Não foi possível carregar a galeria X.');
  const assets = await Promise.all((data ?? []).map(async (asset) => { const { data: signed } = await admin.storage.from('twitter-media').createSignedUrl(asset.storage_path, 900); return { ...asset, signedUrl: signed?.signedUrl ?? null }; }));
  return <div className="page-stack gallery-page"><header className="page-heading"><div><span className="eyebrow">X / Twitter</span><h1>Galeria</h1><p>Mídias exclusivas do módulo X, em bucket isolado.</p></div></header><TwitterGalleryClient assets={assets} canEdit={context.activeOrganization.role !== 'viewer'} /></div>;
}
