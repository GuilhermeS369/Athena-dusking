import { NextResponse } from 'next/server';

import {
  bulkDatabaseErrorResponse,
  hasBulkManageRole,
  parseBulkIdempotencyKey,
  parseBulkRotationRequest,
  verifyBulkReviewToken,
} from '@/lib/publications/bulk-api';
import { bulkPublishingEnabled } from '@/lib/publications/bulk-feature';
import { BULK_ROTATION_ALGORITHM_VERSION } from '@/lib/publications/bulk-rotation';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { fetchAllRowsByIds } from '@/lib/supabase/chunk';

export const dynamic = 'force-dynamic';

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

  const supabase = await createSupabaseServerClient();
  if (compactRequest.reelCover.enabled) {
    // Mesmo truncamento do /review: sem ler por blocos, mais de 1.000 perfis
    // faziam a confirmação falhar culpando os perfis Zernio.
    const organizationId = context.activeOrganization.id;
    const [{ data: selectedProfiles, error: profilesError }, { data: eligible, error: coverError }] = await Promise.all([
      fetchAllRowsByIds(compactRequest.profileIds, (chunk, from, to) => supabase.from('instagram_profiles').select('id, provider').eq('organization_id', organizationId).in('id', chunk).order('id', { ascending: true }).range(from, to)),
      supabase.rpc('bulk_reel_cover_is_eligible', {
        p_organization_id: context.activeOrganization.id,
        p_media_asset_id: compactRequest.reelCover.mediaAssetId,
        p_origin_type: compactRequest.reelCover.origin.type,
        p_origin_group_id: compactRequest.reelCover.origin.groupId,
      }),
    ]);
    if (profilesError || selectedProfiles.length !== compactRequest.profileIds.length || selectedProfiles.some((profile) => profile.provider !== 'zernio')) {
      return NextResponse.json({ error: 'A capa personalizada está disponível apenas para perfis Zernio. Revise o plano novamente.' }, { status: 409 });
    }
    if (coverError || eligible !== true) return NextResponse.json({ error: 'A imagem de capa não está mais disponível. Revise o plano novamente.' }, { status: 409 });
  }
  const planFunction = compactRequest.scheduleMode === 'daily_time'
    ? 'create_bulk_daily_rotation_plan_v2'
    : 'create_bulk_rotation_plan_v2';
  const planArgs = compactRequest.scheduleMode === 'daily_time'
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
  const { data, error } = await supabase.rpc(planFunction, planArgs);

  if (error) {
    console.error('[bulk-confirm-rpc-failure]', {
      organizationId: context.activeOrganization.id,
      planFunction,
      scheduleMode: compactRequest.scheduleMode,
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
