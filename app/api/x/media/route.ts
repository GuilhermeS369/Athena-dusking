import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { validateTwitterMedia } from '@/lib/twitter/media';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

function extension(mimeType: string) {
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov' } as Record<string, string>)[mimeType];
}

export async function GET() {
  const auth = await getTwitterRequestContext();
  if ('response' in auth) return auth.response;
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from('twitter_media_assets').select('*')
    .eq('organization_id', auth.context.activeOrganization.id).is('deleted_at', null).eq('status', 'ready').order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: 'Não foi possível carregar a galeria X.' }, { status: 500 });
  const signed = await Promise.all((data ?? []).map(async (asset) => {
    const { data: url } = await admin.storage.from('twitter-media').createSignedUrl(asset.storage_path, 900);
    return { ...asset, signedUrl: url?.signedUrl ?? null };
  }));
  return NextResponse.json({ assets: signed });
}

export async function POST(request: Request) {
  const auth = await getTwitterRequestContext('operator');
  if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => ({})) as { name?: unknown; mimeType?: unknown; size?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 255) : '';
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType : '';
  const size = typeof body.size === 'number' ? body.size : Number.NaN;
  const validation = validateTwitterMedia({ type: mimeType, size });
  if (!name || !validation.valid) return NextResponse.json({ error: !name ? 'Nome de arquivo inválido.' : validation.error }, { status: 400 });
  const id = randomUUID();
  const storagePath = `${auth.context.activeOrganization.id}/assets/${id}.${extension(mimeType)}`;
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from('twitter_media_assets').insert({
    id, organization_id: auth.context.activeOrganization.id, storage_path: storagePath,
    original_name: name, mime_type: mimeType, media_kind: validation.kind, byte_size: size,
    created_by: auth.context.user.id,
  });
  if (error) return NextResponse.json({ error: 'Não foi possível reservar o upload X.' }, { status: 500 });
  return NextResponse.json({ assetId: id, storagePath }, { status: 201 });
}
