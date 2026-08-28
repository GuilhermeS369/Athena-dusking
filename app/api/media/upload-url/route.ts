import { NextResponse } from 'next/server';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createR2UploadUrl } from '@/lib/storage/r2-client';

const mediaStorageBackend = (process.env.MEDIA_STORAGE_BACKEND || 'supabase').toLowerCase();

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  const organization = context.organizations.find((item) => item.id === context.activeOrganization?.id);
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  if (!organization || !['admin', 'operator'].includes(organization.role)) return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  const organizationId = context.activeOrganization.id;

  const body = await request.json().catch(() => null) as { storagePath?: string } | null;
  const prefix = `${organizationId}/`;
  if (!body?.storagePath || !body.storagePath.startsWith(prefix)) {
    return NextResponse.json({ error: 'Caminho de armazenamento inválido.' }, { status: 400 });
  }

  if (mediaStorageBackend !== 'r2') {
    return NextResponse.json({ backend: 'supabase' as const });
  }

  const bucket = process.env.R2_BUCKET_INSTAGRAM_MEDIA || 'instagram-media';
  const uploadUrl = await createR2UploadUrl(bucket, body.storagePath, 600);
  return NextResponse.json({ backend: 'r2' as const, uploadUrl });
}
