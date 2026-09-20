import { NextResponse } from 'next/server';

import {
  bulkDatabaseErrorResponse,
  bulkRotationFingerprint,
  createBulkReviewToken,
  hasBulkManageRole,
  isBulkVideoVariantAllowed,
  parseBulkRotationRequest,
  reelCoverIneligibleReason,
  sequentialStartAtError,
} from '@/lib/publications/bulk-api';
import { bulkPublishingEnabled } from '@/lib/publications/bulk-feature';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { signMediaPreviewUrl } from '@/lib/storage/media-storage';

export const dynamic = 'force-dynamic';
const REVIEW_TTL_MS = 10 * 60 * 1000;

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }
  if (!hasBulkManageRole(context.activeOrganization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }
  if (!bulkPublishingEnabled(context.activeOrganization.role)) {
    return NextResponse.json({ error: 'Programação em massa indisponível neste rollout.' }, { status: 403 });
  }

  let compactRequest;
  try {
    compactRequest = parseBulkRotationRequest(await request.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Corpo da requisição inválido.' }, { status: 400 });
  }

  const startAtError = compactRequest.scheduleMode === 'sequential' ? sequentialStartAtError(compactRequest.startAt) : null;
  if (startAtError) return NextResponse.json({ error: startAtError }, { status: 400 });

  const organizationId = context.activeOrganization.id;
  // Variante de vídeo por post (436): só organizações liberadas. A confirmação repete.
  if (compactRequest.videoVariant && !isBulkVideoVariantAllowed(organizationId)) {
    return NextResponse.json({ error: 'Variante de vídeo por post ainda não está liberada para esta organização.' }, { status: 403 });
  }
  const supabase = await createSupabaseServerClient();
  let cover: { id: string; originalName: string; originName: string; thumbnailUrl: string | null } | null = null;
  if (compactRequest.reelCover.enabled) {
    // Desde 16/09/2026 (migration 433) a capa vale para perfis da API oficial da
    // Meta, que recebe a imagem em `cover_url`: só JPEG até 8 MB. O formato é
    // conferido antes da validação do banco para a mensagem dizer o motivo.
    const { data: coverFormat } = await supabase.from('media_assets').select('mime_type, size_bytes').eq('organization_id', organizationId).eq('id', compactRequest.reelCover.mediaAssetId).maybeSingle();
    const formatReason = coverFormat ? reelCoverIneligibleReason(coverFormat) : null;
    if (formatReason) return NextResponse.json({ error: formatReason }, { status: 400 });
    const { data: eligible, error: coverError } = await supabase.rpc('bulk_reel_cover_is_eligible', {
      p_organization_id: organizationId,
      p_media_asset_id: compactRequest.reelCover.mediaAssetId,
      p_origin_type: compactRequest.reelCover.origin.type,
      p_origin_group_id: compactRequest.reelCover.origin.groupId,
    });
    if (coverError || eligible !== true) return NextResponse.json({ error: 'A imagem de capa não está mais disponível na origem selecionada.' }, { status: 400 });
    const { data: coverAsset } = await supabase.from('media_assets').select('id, original_name, storage_path').eq('organization_id', organizationId).eq('id', compactRequest.reelCover.mediaAssetId).single();
    if (!coverAsset) return NextResponse.json({ error: 'A imagem de capa não está mais disponível.' }, { status: 400 });
    const originName = compactRequest.reelCover.origin.type === 'ungrouped'
      ? 'Sem grupo'
      : (await supabase.from('profile_groups').select('name').eq('organization_id', organizationId).eq('id', compactRequest.reelCover.origin.groupId).maybeSingle()).data?.name ?? 'Grupo de capas';
    const signed = await signMediaPreviewUrl(supabase, coverAsset.storage_path, 60 * 10, { width: 180, height: 320, resize: 'contain', quality: 70, format: 'origin' });
    cover = { id: coverAsset.id, originalName: coverAsset.original_name, originName, thumbnailUrl: signed.data?.signedUrl ?? null };
  }
  const mediaArgs = {
    p_organization_id: organizationId,
    p_origin_type: compactRequest.origin.type,
    p_origin_group_id: compactRequest.origin.groupId,
    p_format: compactRequest.format,
  };
  const scheduleFunction = compactRequest.scheduleMode === 'daily_time'
    ? 'review_bulk_daily_rotation_schedule'
    : compactRequest.scheduleMode === 'sequential'
      ? 'review_bulk_sequential_rotation_schedule'
      : 'review_bulk_rotation_schedule';
  const scheduleArgs = compactRequest.scheduleMode === 'daily_time'
    ? {
      p_organization_id: organizationId,
      p_profile_ids: compactRequest.profileIds,
      p_repeat_days: compactRequest.durationDays,
      p_daily_time: compactRequest.dailyTime,
    }
    : compactRequest.scheduleMode === 'sequential'
    ? {
      p_organization_id: organizationId,
      p_profile_ids: compactRequest.profileIds,
      p_interval_minutes: compactRequest.intervalMinutes,
      p_post_count: compactRequest.postCount,
      p_start_at: compactRequest.startAt,
      p_format: compactRequest.format,
    }
    : {
      p_organization_id: organizationId,
      p_profile_ids: compactRequest.profileIds,
      p_interval_minutes: compactRequest.intervalMinutes,
      p_duration_days: compactRequest.durationDays,
      p_format: compactRequest.format,
    };
  const [{ data: schedule, error: scheduleError }, { data: media, error: mediaError }] = await Promise.all([
    supabase.rpc(scheduleFunction, scheduleArgs),
    supabase.rpc('get_bulk_rotation_media_summary', mediaArgs),
  ]);

  const databaseError = scheduleError ?? mediaError;
  if (databaseError) {
    console.error('[bulk-review-rpc-failure]', {
      organizationId,
      scheduleMode: compactRequest.scheduleMode,
      format: compactRequest.format,
      profileCount: compactRequest.profileIds.length,
      scheduleError: scheduleError ? {
        code: scheduleError.code,
        message: scheduleError.message,
        details: scheduleError.details,
        hint: scheduleError.hint,
      } : null,
      mediaError: mediaError ? {
        code: mediaError.code,
        message: mediaError.message,
        details: mediaError.details,
        hint: mediaError.hint,
      } : null,
    });
    const mapped = bulkDatabaseErrorResponse(databaseError);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }

  const mediaSummary = media as { eligible?: unknown } | null;
  if (!mediaSummary || typeof mediaSummary.eligible !== 'string' || !/^\d+$/.test(mediaSummary.eligible)) {
    return NextResponse.json({ error: 'Resumo de mídias inválido.' }, { status: 500 });
  }
  if (mediaSummary.eligible === '0') {
    return NextResponse.json({ error: 'A origem não possui mídias elegíveis para o formato.', media }, { status: 400 });
  }

  const now = Date.now();
  const expiresAt = now + REVIEW_TTL_MS;
  const reviewToken = createBulkReviewToken({
    organizationId,
    fingerprint: bulkRotationFingerprint(compactRequest),
    expiresAt,
  });

  return NextResponse.json({
    request: compactRequest,
    schedule,
    media,
    cover,
    reviewToken,
    expiresAt: new Date(expiresAt).toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
