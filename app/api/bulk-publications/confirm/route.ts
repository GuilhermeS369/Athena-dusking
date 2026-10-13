import { NextResponse } from 'next/server';

import {
  bulkDatabaseErrorResponse,
  hasBulkManageRole,
  isBulkVideoVariantAllowed,
  parseBulkIdempotencyKey,
  parseBulkRotationRequest,
  verifyBulkReviewToken,
} from '@/lib/publications/bulk-api';
import { bulkPublishingEnabled } from '@/lib/publications/bulk-feature';
import { BULK_ROTATION_ALGORITHM_VERSION } from '@/lib/publications/bulk-rotation';
import { isLegacySchedulingEnabled, LEGACY_SCHEDULING_DISABLED_CODE, LEGACY_SCHEDULING_DISABLED_MESSAGE } from '@/lib/publications/legacy-scheduling';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // Programar em massa: criação de plano desativada pela flag, antes de qualquer
  // acesso ao banco.
  if (!isLegacySchedulingEnabled()) {
    return NextResponse.json({ error: LEGACY_SCHEDULING_DISABLED_MESSAGE, code: LEGACY_SCHEDULING_DISABLED_CODE }, { status: 410 });
  }

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

  let body: Record<string, unknown>;
  let compactRequest;
  let idempotencyKey: string;
  try {
    const parsedBody = await request.json();
    if (!parsedBody || typeof parsedBody !== 'object') throw new RangeError('Corpo da requisição inválido.');
    body = parsedBody as Record<string, unknown>;
    compactRequest = parseBulkRotationRequest(body.request);
    idempotencyKey = parseBulkIdempotencyKey(request.headers.get('Idempotency-Key') ?? body.idempotencyKey);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Corpo da requisição inválido.' }, { status: 400 });
  }

  const reviewToken = typeof body.reviewToken === 'string' ? body.reviewToken : '';
  if (!reviewToken || !verifyBulkReviewToken(reviewToken, context.activeOrganization.id, compactRequest)) {
    return NextResponse.json({ error: 'Revisão expirada ou incompatível. Revise o plano novamente.' }, { status: 409 });
  }

  // Variante de vídeo por post (436): só organizações liberadas. Conferido aqui e
  // na revisão; o painel esconde a opção, mas quem decide é o servidor.
  const videoVariant = compactRequest.videoVariant ?? null;
  if (videoVariant && !isBulkVideoVariantAllowed(context.activeOrganization.id)) {
    return NextResponse.json({ error: 'Variante de vídeo por post ainda não está liberada para esta organização.' }, { status: 403 });
  }

  const supabase = await createSupabaseServerClient();
  if (compactRequest.reelCover.enabled) {
    // A capa vale para a API oficial da Meta e para a Zernio (433). A função de
    // criação do plano repete esta validação dentro da transação.
    const { data: eligible, error: coverError } = await supabase.rpc('bulk_reel_cover_is_eligible', {
      p_organization_id: context.activeOrganization.id,
      p_media_asset_id: compactRequest.reelCover.mediaAssetId,
      p_origin_type: compactRequest.reelCover.origin.type,
      p_origin_group_id: compactRequest.reelCover.origin.groupId,
    });
    if (coverError || eligible !== true) return NextResponse.json({ error: 'A imagem de capa não está mais disponível. Revise o plano novamente.' }, { status: 409 });
  }
  // Sem receita nem lista o caminho é exatamente o de antes (funções v2). Com
  // receita, os wrappers v3 da 436. Com lista de legendas, os v4 da 437 (chamam a
  // v3, então a receita continua valendo junto).
  const captionVariants = compactRequest.captionVariants ?? null;
  const planVersion = captionVariants ? 'v4' : videoVariant ? 'v3' : 'v2';
  const planFunction = compactRequest.scheduleMode === 'daily_time'
    ? `create_bulk_daily_rotation_plan_${planVersion}`
    : compactRequest.scheduleMode === 'sequential'
      ? `create_bulk_sequential_rotation_plan_${planVersion}`
      : `create_bulk_rotation_plan_${planVersion}`;
  const baseArgs = compactRequest.scheduleMode === 'sequential'
    ? {
      p_organization_id: context.activeOrganization.id,
      p_request_key: idempotencyKey,
      p_name: compactRequest.name,
      p_profile_ids: compactRequest.profileIds,
      p_origin_type: compactRequest.origin.type,
      p_origin_group_id: compactRequest.origin.groupId,
      p_format: compactRequest.format,
      p_interval_minutes: compactRequest.intervalMinutes,
      p_post_count: compactRequest.postCount,
      p_start_at: compactRequest.startAt,
      p_caption: compactRequest.caption,
      p_order_mode: compactRequest.orderMode,
      p_rotation_seed: compactRequest.rotationSeed,
      p_reel_cover_media_asset_id: compactRequest.reelCover.enabled ? compactRequest.reelCover.mediaAssetId : null,
      p_reel_cover_origin_type: compactRequest.reelCover.enabled ? compactRequest.reelCover.origin.type : null,
      p_reel_cover_origin_group_id: compactRequest.reelCover.enabled ? compactRequest.reelCover.origin.groupId : null,
      p_algorithm_version: BULK_ROTATION_ALGORITHM_VERSION,
      p_chunk_size: 500,
    }
    : compactRequest.scheduleMode === 'daily_time'
    ? {
      p_organization_id: context.activeOrganization.id,
      p_request_key: idempotencyKey,
      p_name: compactRequest.name,
      p_profile_ids: compactRequest.profileIds,
      p_origin_type: compactRequest.origin.type,
      p_origin_group_id: compactRequest.origin.groupId,
      p_format: compactRequest.format,
      p_repeat_days: compactRequest.durationDays,
      p_daily_time: compactRequest.dailyTime,
      p_caption: compactRequest.caption,
      p_order_mode: compactRequest.orderMode,
      p_rotation_seed: compactRequest.rotationSeed,
      p_reel_cover_media_asset_id: compactRequest.reelCover.enabled ? compactRequest.reelCover.mediaAssetId : null,
      p_reel_cover_origin_type: compactRequest.reelCover.enabled ? compactRequest.reelCover.origin.type : null,
      p_reel_cover_origin_group_id: compactRequest.reelCover.enabled ? compactRequest.reelCover.origin.groupId : null,
      p_algorithm_version: BULK_ROTATION_ALGORITHM_VERSION,
      p_chunk_size: 500,
    }
    : {
    p_organization_id: context.activeOrganization.id,
    p_request_key: idempotencyKey,
    p_name: compactRequest.name,
    p_profile_ids: compactRequest.profileIds,
    p_origin_type: compactRequest.origin.type,
    p_origin_group_id: compactRequest.origin.groupId,
    p_format: compactRequest.format,
    p_interval_minutes: compactRequest.intervalMinutes,
    p_duration_days: compactRequest.durationDays,
    p_caption: compactRequest.caption,
    p_order_mode: compactRequest.orderMode,
    p_rotation_seed: compactRequest.rotationSeed,
    p_reel_cover_media_asset_id: compactRequest.reelCover.enabled ? compactRequest.reelCover.mediaAssetId : null,
    p_reel_cover_origin_type: compactRequest.reelCover.enabled ? compactRequest.reelCover.origin.type : null,
    p_reel_cover_origin_group_id: compactRequest.reelCover.enabled ? compactRequest.reelCover.origin.groupId : null,
    p_algorithm_version: BULK_ROTATION_ALGORITHM_VERSION,
    p_chunk_size: 500,
    };
  const planArgs = captionVariants
    ? { ...baseArgs, p_video_variant_recipe: videoVariant, p_caption_variants: captionVariants }
    : videoVariant ? { ...baseArgs, p_video_variant_recipe: videoVariant } : baseArgs;
  const { data, error } = await supabase.rpc(planFunction, planArgs);

  if (error) {
    console.error('[bulk-confirm-rpc-failure]', {
      organizationId: context.activeOrganization.id,
      planFunction,
      scheduleMode: compactRequest.scheduleMode,
      videoVariant,
      // Só a quantidade: as legendas são conteúdo do cliente e não vão para o log.
      captionVariantCount: captionVariants?.length ?? 0,
      format: compactRequest.format,
      profileCount: compactRequest.profileIds.length,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    const mapped = bulkDatabaseErrorResponse(error);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }

  return NextResponse.json(data, {
    status: (data as { created?: boolean } | null)?.created === false ? 200 : 201,
    headers: { 'Cache-Control': 'no-store' },
  });
}
