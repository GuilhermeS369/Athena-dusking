import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { removeMediaObjects, signMediaPreviewUrl, uploadMediaObject } from '@/lib/storage/media-storage';
import { objectExistsInR2 } from '@/lib/storage/r2-client';

function mediaStorageBackend() {
  return (process.env.MEDIA_STORAGE_BACKEND || 'supabase').toLowerCase();
}
const r2Bucket = process.env.R2_BUCKET_INSTAGRAM_MEDIA || 'instagram-media';

// O limite da API precisa ficar abaixo do limite efetivo das funções/serverless
// (Vercel/Next normalmente rejeitam o body antes de executar este handler).
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ALLOWED_TYPES = new Map([
  ['image/jpeg', 'image'],
  ['image/png', 'image'],
  ['image/webp', 'image'],
  ['video/mp4', 'video'],
  ['video/quicktime', 'video'],
]);

const MEDIA_SELECT = 'id, original_name, mime_type, kind, size_bytes, width, height, duration_ms, status, processing_error, storage_path, thumbnail_storage_path, first_published_at, created_at, updated_at';
const PAGE_SIZE = 30;

type MediaCursor = { createdAt: string; id: string };
type ComposerUsageFilter = 'available' | 'all' | 'scheduled' | 'published';
type GallerySituationFilter = 'all' | 'schedulable' | 'unposted' | 'scheduled' | 'posted' | 'posted_scheduled' | 'uploaded' | 'processing' | 'ready' | 'failed';
const GALLERY_SITUATION_FILTERS = new Set<GallerySituationFilter>(['all', 'schedulable', 'unposted', 'scheduled', 'posted', 'posted_scheduled', 'uploaded', 'processing', 'ready', 'failed']);
type MediaAssetRow = {
  id: string;
  original_name: string;
  mime_type: string;
  kind: 'image' | 'video';
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  status: 'uploaded' | 'processing' | 'ready' | 'failed' | 'deleted';
  processing_error: string | null;
  storage_path: string;
  thumbnail_storage_path: string | null;
  first_published_at: string | null;
  created_at: string;
  updated_at: string;
};

function decodeCursor(value: string | null): MediaCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<MediaCursor>;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string' || Number.isNaN(Date.parse(parsed.createdAt))) return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

function encodeCursor(asset: { created_at: string; id: string }) {
  return Buffer.from(JSON.stringify({ createdAt: asset.created_at, id: asset.id })).toString('base64url');
}

function safeFileName(name: string) {
  return name.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 150) || 'arquivo';
}

async function assignAssetToUploadGroup(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  organizationId: string,
  assetId: string,
  groupId: string | null,
) {
  if (!groupId) return [];
  const { data, error } = await supabase.rpc('update_media_group_assignments_bulk', {
    p_organization_id: organizationId,
    p_media_asset_ids: [assetId],
    p_group_ids: [groupId],
    p_action: 'add',
  });
  if (error) {
    console.warn('[media] Upload registrado, mas falhou ao associar grupo', { assetId, groupId, message: error.message, code: error.code });
    return [];
  }
  return [...new Set(((data ?? []) as Array<{ media_asset_id: string; group_id: string }>)
    .filter((assignment) => assignment.media_asset_id === assetId)
    .map((assignment) => assignment.group_id))];
}

export async function GET(request: Request) {
  const context = await getOrganizationContext();

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const supabase = await createSupabaseServerClient();
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get('limit') ?? String(PAGE_SIZE));
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), PAGE_SIZE) : PAGE_SIZE;
  const type = url.searchParams.get('type');
  const statusParam = url.searchParams.get('status');
  const situation: GallerySituationFilter = GALLERY_SITUATION_FILTERS.has(statusParam as GallerySituationFilter) ? statusParam as GallerySituationFilter : 'all';
  const groupId = url.searchParams.get('group');
  const search = url.searchParams.get('search')?.trim().slice(0, 100) ?? '';
  const cursor = decodeCursor(url.searchParams.get('cursor'));
  const composerMode = url.searchParams.get('composer') === 'true';
  const usageParam = url.searchParams.get('usage');
  const usage: ComposerUsageFilter = ['available', 'all', 'scheduled', 'published'].includes(usageParam ?? '')
    ? usageParam as ComposerUsageFilter
    : 'available';

  if (composerMode) {
    const idsOnly = url.searchParams.get('idsOnly') === 'true';
    const rawComposerLimit = Number(url.searchParams.get('limit') ?? String(PAGE_SIZE));
    const composerLimit = Number.isInteger(rawComposerLimit) ? Math.min(Math.max(rawComposerLimit, 1), PAGE_SIZE) : PAGE_SIZE;
    const composerGroupId = groupId && groupId !== 'none' ? groupId : null;
    const composerUngrouped = groupId === 'none';
    const rpcArgs = {
      p_organization_id: context.activeOrganization.id,
      p_usage_filter: usage,
      p_group_id: composerGroupId,
      p_ungrouped: composerUngrouped,
      p_cursor_created_at: cursor?.createdAt ?? null,
      p_cursor_id: cursor?.id ?? null,
      p_limit: composerLimit + 1,
    };
    const totalPromise = supabase.rpc('count_composer_media_ids', {
      p_organization_id: context.activeOrganization.id,
      p_usage_filter: usage,
      p_group_id: composerGroupId,
      p_ungrouped: composerUngrouped,
    });
    const { data: idRows, error: idsError } = await supabase.rpc('list_composer_media_ids', rpcArgs);
    const { data: composerTotal, error: totalError } = await totalPromise;

    if (idsError || totalError) return NextResponse.json({ error: 'Não foi possível carregar a biblioteca do compositor.' }, { status: 500 });

    const rows = (idRows ?? []) as Array<{ media_asset_id: string; created_at: string }>;
    const pageRows = rows.slice(0, composerLimit);
    const hasMore = rows.length > composerLimit;
    const lastRow = pageRows.at(-1);
    const nextCursor = hasMore && lastRow ? encodeCursor({ id: lastRow.media_asset_id, created_at: lastRow.created_at }) : null;

    if (idsOnly) {
      return NextResponse.json({
        assetIds: pageRows.map((row) => row.media_asset_id),
        hasMore,
        nextCursor,
        total: composerTotal ?? 0,
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const pageAssetIds = pageRows.map((row) => row.media_asset_id);
    if (!pageAssetIds.length) {
      return NextResponse.json({ assets: [], hasMore: false, nextCursor: null, total: composerTotal ?? 0 }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const [assetsResult, publicationStatesResult] = await Promise.all([
      supabase
        .from('media_assets')
      .select('id, original_name, mime_type, kind, size_bytes, storage_path, thumbnail_storage_path')
      .eq('organization_id', context.activeOrganization.id)
      .is('deletion_requested_at', null)
      .in('id', pageAssetIds),
      supabase.rpc('get_media_publication_states', {
        p_organization_id: context.activeOrganization.id,
        p_media_asset_ids: pageAssetIds,
      }),
    ]);

    if (assetsResult.error || publicationStatesResult.error) {
      return NextResponse.json({ error: 'Não foi possível carregar os detalhes das mídias do compositor.' }, { status: 500 });
    }

    const states = new Map<string, { scheduled_count: number; next_scheduled_at: string | null; has_published: boolean }>();
    for (const row of publicationStatesResult.data ?? []) {
      states.set(row.media_asset_id, {
        scheduled_count: row.scheduled_count,
        next_scheduled_at: row.next_scheduled_at,
        has_published: row.has_published,
      });
    }
    const assetsById = new Map((assetsResult.data ?? []).map((asset) => [asset.id, asset]));
    const assets = await Promise.all(pageAssetIds.flatMap((id) => {
      const asset = assetsById.get(id);
      if (!asset) return [];
      return [asset];
    }).map(async (asset) => {
      const [signed, thumbnail] = await Promise.all([
        asset.kind === 'image'
          ? signMediaPreviewUrl(supabase, asset.storage_path, 60 * 30, { width: 320, height: 320, resize: 'contain', quality: 65, format: 'origin' })
          : Promise.resolve({ data: null }),
        asset.thumbnail_storage_path ? signMediaPreviewUrl(supabase, asset.thumbnail_storage_path, 60 * 10) : Promise.resolve({ data: null }),
      ]);
      return {
        ...asset,
        signed_url: signed.data?.signedUrl ?? null,
        thumbnail_url: thumbnail.data?.signedUrl ?? null,
        publication_state: states.get(asset.id) ?? { scheduled_count: 0, next_scheduled_at: null, has_published: false },
      };
    }));

    return NextResponse.json({ assets, hasMore, nextCursor, total: composerTotal ?? 0 }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const galleryGroupId = groupId && groupId !== 'none' ? groupId : null;
  const galleryUngrouped = groupId === 'none';
  const galleryType = type === 'image' || type === 'video' ? type : 'all';
  const rpcArgs = {
    p_organization_id: context.activeOrganization.id,
    p_situation_filter: situation,
    p_type_filter: galleryType,
    p_group_id: galleryGroupId,
    p_ungrouped: galleryUngrouped,
    p_search: search,
    p_cursor_created_at: cursor?.createdAt ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_limit: limit + 1,
  };
  const totalArgs = {
    p_organization_id: context.activeOrganization.id,
    p_situation_filter: situation,
    p_type_filter: galleryType,
    p_group_id: galleryGroupId,
    p_ungrouped: galleryUngrouped,
    p_search: search,
  };

  // A listagem, a paginação e o total agora são calculados pelo mesmo filtro de
  // situação no banco. Isso elimina a lógica duplicada de abas disponíveis/postados.
  const [{ data: idRows, error }, { data: total, error: totalError }] = await Promise.all([
    supabase.rpc('list_gallery_media_ids', rpcArgs),
    supabase.rpc('count_gallery_media_ids', totalArgs),
  ]);

  if (error || totalError) {
    return NextResponse.json({ error: 'Não foi possível carregar a galeria.' }, { status: 500 });
  }

  const rows = (idRows ?? []) as Array<{ media_asset_id: string; created_at: string }>;
  const pageRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const pageAssetIds = pageRows.map((row) => row.media_asset_id);
  if (!pageAssetIds.length) {
    return NextResponse.json({ assets: [], hasMore: false, nextCursor: null, total: total ?? 0 }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const [assetsResult, publicationLinksResult, assignmentsResult] = pageAssetIds.length
    ? await Promise.all([
      supabase
        .from('media_assets')
        .select(MEDIA_SELECT)
        .eq('organization_id', context.activeOrganization.id)
        .is('deletion_requested_at', null)
        .in('id', pageAssetIds),
      supabase.rpc('get_media_publication_states', {
        p_organization_id: context.activeOrganization.id,
        p_media_asset_ids: pageAssetIds,
      }),
      supabase
        .from('media_group_assignments')
        .select('media_asset_id, group_id')
        .eq('organization_id', context.activeOrganization.id)
        .in('media_asset_id', pageAssetIds),
    ])
    : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];

  if (assetsResult.error || publicationLinksResult.error || assignmentsResult.error) {
    return NextResponse.json({ error: 'Não foi possível carregar as relações das mídias.' }, { status: 500 });
  }

  const publicationStates = new Map<string, { scheduled_count: number; next_scheduled_at: string | null; has_published: boolean }>();
  for (const row of publicationLinksResult.data ?? []) {
    publicationStates.set(row.media_asset_id, {
      scheduled_count: row.scheduled_count,
      next_scheduled_at: row.next_scheduled_at,
      has_published: row.has_published,
    });
  }

  const groupIdsByAsset = new Map<string, string[]>();
  for (const assignment of assignmentsResult.data ?? []) {
    groupIdsByAsset.set(assignment.media_asset_id, [...(groupIdsByAsset.get(assignment.media_asset_id) ?? []), assignment.group_id]);
  }

  const assetsById = new Map(((assetsResult.data ?? []) as MediaAssetRow[]).map((asset) => [asset.id, asset]));
  const page = pageAssetIds.flatMap((id) => {
    const asset = assetsById.get(id);
    return asset ? [asset] : [];
  });

  const assets = await Promise.all(page.map(async (asset: MediaAssetRow) => {
    const [signed, thumbnail] = await Promise.all([
      // Vídeos também precisam da URL original quando já possuem uma referência
      // de miniatura: se o objeto da miniatura foi removido ou corrompido, o
      // cliente ainda consegue recriá-la a partir do vídeo sem alterar o filtro.
      asset.kind === 'image' || asset.kind === 'video'
        ? signMediaPreviewUrl(supabase, asset.storage_path, 60 * 30, asset.kind === 'image' ? { width: 240, height: 240, resize: 'contain', quality: 60, format: 'origin' } : undefined)
        : Promise.resolve({ data: null }),
      asset.thumbnail_storage_path ? signMediaPreviewUrl(supabase, asset.thumbnail_storage_path, 60 * 10) : Promise.resolve({ data: null }),
    ]);

    return { ...asset, signed_url: signed.data?.signedUrl ?? null, thumbnail_url: thumbnail.data?.signedUrl ?? null, group_ids: groupIdsByAsset.get(asset.id) ?? [], publication_state: publicationStates.get(asset.id) ?? null };
  }));

  return NextResponse.json(
    {
      assets,
      hasMore,
      nextCursor: hasMore && pageRows.length ? encodeCursor({ id: pageRows[pageRows.length - 1].media_asset_id, created_at: pageRows[pageRows.length - 1].created_at }) : null,
      total: total ?? 0,
    },
    { headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=60' } },
  );

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
  const organizationId = context.activeOrganization.id;

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const thumbnail = formData.get('thumbnail');
    const rawGroupId = formData.get('groupId');
    const uploadGroupId = typeof rawGroupId === 'string' && rawGroupId.trim() ? rawGroupId : null;

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Envie um arquivo válido.' }, { status: 400 });
    }
    const uploadFile = file;

    const kind = ALLOWED_TYPES.get(uploadFile.type);
    if (!kind) {
      return NextResponse.json({ error: 'Formato não suportado. Use JPG, PNG, WebP, MP4 ou MOV.' }, { status: 415 });
    }

    if (uploadFile.size <= 0 || uploadFile.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'Vídeos e imagens devem ter no máximo 50 MB nesta galeria. O arquivo selecionado excede esse limite.' }, { status: 413 });
    }

    if (thumbnail !== null && (!(thumbnail instanceof File) || thumbnail.type !== 'image/jpeg' || thumbnail.size <= 0 || thumbnail.size > 2 * 1024 * 1024)) {
      return NextResponse.json({ error: 'A miniatura precisa ser uma imagem JPEG de até 2 MB.' }, { status: 400 });
    }
    if (kind === 'video' && !(thumbnail instanceof File)) {
      return NextResponse.json({ error: 'Não foi possível gerar a miniatura do vídeo. Tente enviar o arquivo novamente.' }, { status: 422 });
    }

    const bytes = Buffer.from(await uploadFile.arrayBuffer());
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const extension = safeFileName(uploadFile.name).split('.').pop() || 'bin';
    const storagePath = `${organizationId}/${crypto.randomUUID()}.${extension}`;
    const thumbnailStoragePath = thumbnail instanceof File ? `${organizationId}/thumbnails/${crypto.randomUUID()}.jpg` : null;
    const supabase = await createSupabaseServerClient();

    async function uploadCurrentFileToStorage() {
      const { error: uploadError } = await uploadMediaObject(supabase, storagePath, bytes, uploadFile.type, false);

      if (uploadError) {
        console.error('[media] Falha ao armazenar arquivo', {
          name: uploadFile.name,
          type: uploadFile.type,
          size: uploadFile.size,
          message: uploadError.message,
        });
        throw new Error(`Não foi possível armazenar o arquivo no storage: ${uploadError.message}`);
      }

      if (thumbnail instanceof File && thumbnailStoragePath) {
        const { error: thumbnailUploadError } = await uploadMediaObject(supabase, thumbnailStoragePath, Buffer.from(await thumbnail.arrayBuffer()), 'image/jpeg', false);
        if (thumbnailUploadError) {
          await removeMediaObjects(supabase, [storagePath]);
          throw new Error(`Não foi possível armazenar a miniatura: ${thumbnailUploadError.message}`);
        }
      }
    }

    async function deleteInvalidExistingAsset(assetId: string) {
      const { error } = await supabase
        .from('media_assets')
        .delete()
        .eq('id', assetId)
        .eq('organization_id', organizationId);

      if (error) {
        const quarantineChecksum = `${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 64);
        const { error: quarantineError } = await supabase
          .from('media_assets')
          .update({ checksum_sha256: quarantineChecksum, status: 'failed', processing_error: `Registro antigo quebrado liberado para reenvio em ${new Date().toISOString()}: ${error.message}`, deleted_at: new Date().toISOString() })
          .eq('id', assetId)
          .eq('organization_id', organizationId);

        if (quarantineError) {
          throw new Error(`Existe um registro antigo quebrado deste arquivo e ele não pôde ser liberado automaticamente: ${quarantineError.message}.`);
        }
      }
    }

    const { data: existing } = await supabase
      .from('media_assets')
      .select('id, original_name, mime_type, kind, size_bytes, width, height, duration_ms, status, processing_error, storage_path, thumbnail_storage_path, first_published_at, created_at, updated_at, deleted_at, deletion_requested_at')
      .eq('organization_id', organizationId)
      .eq('checksum_sha256', checksum)
      .maybeSingle();

    if (existing) {
      if (existing.deletion_requested_at) {
        return NextResponse.json({ error: 'Esta mídia já está em uma fila de exclusão. Aguarde a exclusão terminar antes de reenviar o mesmo arquivo.' }, { status: 409 });
      }

      const storageExists = existing.deleted_at || existing.deletion_requested_at
        ? { data: false, error: null }
        : mediaStorageBackend() === 'r2'
          ? { data: await objectExistsInR2(r2Bucket, existing.storage_path), error: null as { message: string } | null }
          : await supabase.rpc('media_asset_has_storage_object', { p_storage_path: existing.storage_path });

      if (storageExists.error) {
        return NextResponse.json({ error: `Não foi possível verificar se o arquivo já existente ainda está no storage: ${storageExists.error.message}` }, { status: 500 });
      }

      if (!storageExists.data) {
        await deleteInvalidExistingAsset(existing.id);
      } else {
        const { data: renamedExisting, error: renameExistingError } = await supabase
          .from('media_assets')
          .update({ original_name: uploadFile.name.slice(0, 255), mime_type: uploadFile.type, kind, size_bytes: uploadFile.size, status: 'ready', processing_error: null })
          .eq('id', existing.id)
          .eq('organization_id', organizationId)
          .is('deletion_requested_at', null)
          .select('id, original_name, mime_type, kind, size_bytes, width, height, duration_ms, status, processing_error, storage_path, thumbnail_storage_path, first_published_at, created_at, updated_at')
          .single();
        if (renameExistingError || !renamedExisting) return NextResponse.json({ error: `O arquivo já existia, mas não pôde ser atualizado para aparecer com o nome reenviado: ${renameExistingError?.message ?? 'erro no banco'}.` }, { status: 400 });
        const [signed, thumbnailSigned] = await Promise.all([
          signMediaPreviewUrl(supabase, renamedExisting.storage_path, 60 * 10),
          renamedExisting.thumbnail_storage_path ? signMediaPreviewUrl(supabase, renamedExisting.thumbnail_storage_path, 60 * 10) : Promise.resolve({ data: null }),
        ]);
        const groupIds = await assignAssetToUploadGroup(supabase, organizationId, renamedExisting.id, uploadGroupId);
        return NextResponse.json({ asset: { ...renamedExisting, signed_url: signed.data?.signedUrl ?? null, thumbnail_url: thumbnailSigned.data?.signedUrl ?? null, group_ids: groupIds }, duplicated: true }, { status: 200 });
      }
    }

    await uploadCurrentFileToStorage();

    const { data: asset, error: insertError } = await supabase
      .from('media_assets')
      .insert({
        organization_id: organizationId,
        uploaded_by: context.user.id,
        storage_path: storagePath,
        original_name: uploadFile.name.slice(0, 255),
        mime_type: uploadFile.type,
        kind,
        size_bytes: uploadFile.size,
        checksum_sha256: checksum,
        thumbnail_storage_path: thumbnailStoragePath,
        status: 'ready',
      })
      .select('id, original_name, mime_type, kind, size_bytes, width, height, duration_ms, status, processing_error, storage_path, thumbnail_storage_path, first_published_at, created_at, updated_at')
      .single();

    if (insertError || !asset) {
      await removeMediaObjects(supabase, [storagePath, ...(thumbnailStoragePath ? [thumbnailStoragePath] : [])]);
      console.error('[media] Falha ao registrar metadados', {
        name: uploadFile.name,
        message: insertError?.message,
        code: insertError?.code,
        details: insertError?.details,
      });
      return NextResponse.json({ error: `O arquivo foi armazenado, mas não pôde ser registrado na galeria: ${insertError?.message ?? 'resposta vazia do banco de dados.'}` }, { status: 400 });
    }

    const [signed, thumbnailSigned] = await Promise.all([
      signMediaPreviewUrl(supabase, storagePath, 60 * 10),
      thumbnailStoragePath ? signMediaPreviewUrl(supabase, thumbnailStoragePath, 60 * 10) : Promise.resolve({ data: null }),
    ]);
    const groupIds = await assignAssetToUploadGroup(supabase, organizationId, asset.id, uploadGroupId);

    return NextResponse.json({ asset: { ...asset, signed_url: signed.data?.signedUrl ?? null, thumbnail_url: thumbnailSigned.data?.signedUrl ?? null, group_ids: groupIds } }, { status: 201 });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'erro inesperado no servidor';
    console.error('[media] Erro inesperado no upload', reason);
    return NextResponse.json({ error: `Upload inválido: ${reason}` }, { status: 400 });
  }
}
