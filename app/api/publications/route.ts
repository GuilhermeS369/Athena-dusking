import { NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { fetchAllRowsByIds } from '@/lib/supabase/chunk';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { isPostingTimeSlot, MAX_PUBLICATION_CAPTION_LENGTH, validateMediaForFormat } from '@/lib/publications/composer';
import { signMediaPreviewUrl } from '@/lib/storage/media-storage';

export const maxDuration = 60;

const formats = new Set(['image', 'reel', 'story', 'carousel']);
const initialBatchLimit = 5;
const maximumBatchPageSize = 10;
const synchronousPublicationLimit = 500;
const maximumAsyncPublicationItems = 50_000;
// Acima do limite síncrono, os itens já são encaminhados ao job incremental.
// O compositor Repetir pode montar a sequência completa para muitos perfis.
const maximumPublicationInputItems = maximumAsyncPublicationItems;
const asyncGenerationChunkSize = 500;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const queueStatusFilters: Record<string, string[]> = {
  scheduled: ['waiting', 'ready'],
  processing: ['preparing', 'publishing'],
  failed: ['failed'],
  suspended: ['suspended'],
  published: ['published'],
};

type PublicationQueueProfile = {
  id: string;
  username: string;
  display_name: string | null;
  provider: 'meta_official' | 'zernio';
  zernio_account_id: string | null;
  zernio_connection_id: string | null;
  zernio_connection_label?: string | null;
};

type PublicationInput = {
  profileId?: unknown;
  groupId?: unknown;
  format?: unknown;
  mediaIds?: unknown;
  caption?: unknown;
  executeAt?: unknown;
  scheduleTime?: unknown;
  scheduleBaseAt?: unknown;
};

function cleanCaption(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && value.length <= MAX_PUBLICATION_CAPTION_LENGTH ? value : undefined;
}

function parseDate(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;

  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function idempotencyKey(batchId: string, item: {
  profileId: string;
  format: string;
  mediaIds: string[];
  caption: string | null;
  executeAt: string | null;
}, index: number) {
  const canonical = JSON.stringify({
    batchId,
    index,
    profileId: item.profileId,
    format: item.format,
    mediaIds: item.mediaIds,
    caption: item.caption,
    executeAt: item.executeAt,
  });
  return `v1:${createHash('sha256').update(canonical).digest('hex')}`;
}

async function loadQueueProfiles(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  organizationId: string,
  profileIds: string[],
) {
  const uniqueProfileIds = [...new Set(profileIds)].filter(Boolean);
  if (uniqueProfileIds.length === 0) return new Map<string, PublicationQueueProfile>();

  const { data: profiles, error: profilesError } = await fetchAllRowsByIds(uniqueProfileIds, (chunk, from, to) => supabase
    .from('instagram_profiles_safe')
    .select('id, username, display_name, provider, zernio_account_id, zernio_connection_id')
    .eq('organization_id', organizationId)
    .in('id', chunk)
    .order('id', { ascending: true })
    .range(from, to));

  if (profilesError) throw profilesError;

  const zernioConnectionIds = [...new Set((profiles ?? [])
    .map((profile) => profile.zernio_connection_id)
    .filter((id): id is string => Boolean(id)))] ;
  const { data: connections, error: connectionsError } = zernioConnectionIds.length
    ? await supabase
      .from('zernio_connections_safe')
      .select('id, label')
      .eq('organization_id', organizationId)
      .in('id', zernioConnectionIds)
    : { data: [], error: null };

  if (connectionsError) throw connectionsError;

  const connectionLabelById = new Map((connections ?? []).map((connection) => [connection.id, connection.label]));
  return new Map((profiles ?? []).map((profile) => [profile.id, {
    ...profile,
    zernio_connection_label: profile.zernio_connection_id ? connectionLabelById.get(profile.zernio_connection_id) ?? null : null,
  } as PublicationQueueProfile]));
}

export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const requestedLimit = Number.parseInt(searchParams.get('limit') ?? '', 10);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, maximumBatchPageSize)
    : initialBatchLimit;
  const cursorCreatedAt = searchParams.get('cursorCreatedAt');
  const cursorId = searchParams.get('cursorId');
  const statusFilter = searchParams.get('status');
  const formatFilter = searchParams.get('format');
  const timingFilter = searchParams.get('timing');
  const profileFilter = searchParams.get('profileId');
  const groupFilter = searchParams.get('groupId');
  const archivedFilter = searchParams.get('archived') ?? 'exclude';
  const acknowledgedFailuresFilter = searchParams.get('acknowledgedFailures') ?? 'exclude';
  const hasCursor = Boolean(cursorCreatedAt || cursorId);
  if (hasCursor && (!cursorCreatedAt || Number.isNaN(new Date(cursorCreatedAt).valueOf()) || !cursorId || !uuidPattern.test(cursorId))) {
    return NextResponse.json({ error: 'Cursor de paginação inválido.' }, { status: 400 });
  }
  if (statusFilter && !queueStatusFilters[statusFilter]) {
    return NextResponse.json({ error: 'Filtro de status inválido.' }, { status: 400 });
  }
  if (formatFilter && !formats.has(formatFilter)) {
    return NextResponse.json({ error: 'Filtro de formato inválido.' }, { status: 400 });
  }
  if (timingFilter && !['immediate', 'scheduled'].includes(timingFilter)) {
    return NextResponse.json({ error: 'Filtro de execução inválido.' }, { status: 400 });
  }
  if (profileFilter && !uuidPattern.test(profileFilter)) {
    return NextResponse.json({ error: 'Filtro de perfil inválido.' }, { status: 400 });
  }
  if (groupFilter && groupFilter !== 'none' && !uuidPattern.test(groupFilter)) {
    return NextResponse.json({ error: 'Filtro de grupo inválido.' }, { status: 400 });
  }
  if (!['exclude', 'only', 'include'].includes(archivedFilter)) {
    return NextResponse.json({ error: 'Filtro de arquivamento inválido.' }, { status: 400 });
  }
  if (!['exclude', 'only', 'include'].includes(acknowledgedFailuresFilter)) {
    return NextResponse.json({ error: 'Filtro de falhas confirmadas inválido.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  let includedProfileIds: string[] | null = profileFilter ? [profileFilter] : null;
  let excludedProfileIds: string[] = [];

  if (groupFilter) {
    if (groupFilter === 'none') {
      // Antes isto lia profile_groups com profile_group_members embutido. O teto
      // de linhas do PostgREST se aplica ao recurso de topo, e o comportamento em
      // recursos embutidos depende da versão — ler os vínculos diretamente, com
      // paginação explícita, elimina a dúvida e é mais barato.
      const { data: groupedMembers, error: allGroupsError } = await fetchAllRows<{ profile_id: string }>((from, to) => supabase
        .from('profile_group_members')
        .select('profile_id, profile_groups!inner(id)')
        .eq('organization_id', context.activeOrganization!.id)
        .is('profile_groups.deleted_at', null)
        .order('profile_id', { ascending: true })
        .order('group_id', { ascending: true })
        .range(from, to));

      if (allGroupsError) return NextResponse.json({ error: 'Não foi possível carregar o filtro de grupo.' }, { status: 500 });

      excludedProfileIds = [...new Set(groupedMembers.map((member) => member.profile_id))];
      if (profileFilter && excludedProfileIds.includes(profileFilter)) {
        return NextResponse.json({ batches: [], hasMore: false, nextCursor: null });
      }
    } else {
      const { data: groupMembers, error: groupsForFilterError } = await fetchAllRows<{ profile_id: string }>((from, to) => supabase
        .from('profile_group_members')
        .select('profile_id, profile_groups!inner(id)')
        .eq('organization_id', context.activeOrganization!.id)
        .eq('group_id', groupFilter)
        .is('profile_groups.deleted_at', null)
        .order('profile_id', { ascending: true })
        .range(from, to));

      if (groupsForFilterError) {
        return NextResponse.json({ error: 'Não foi possível carregar o filtro de grupo.' }, { status: 500 });
      }

      const memberProfileIds = [...new Set(groupMembers.map((member) => member.profile_id))];
      if (memberProfileIds.length === 0 || (profileFilter && !memberProfileIds.includes(profileFilter))) {
        return NextResponse.json({ batches: [], hasMore: false, nextCursor: null });
      }
      includedProfileIds = profileFilter ? [profileFilter] : memberProfileIds;
    }
  }

  let query = supabase
    .from('publication_batches')
    .select('id, name, status, scheduled_for, timezone, review_confirmed_at, created_at, updated_at, created_by, created_by_email, publication_batch_circuit_breakers(consecutive_failures, paused_at, paused_reason), publication_items!inner(id, profile_id, format, status, execute_at, caption, attempt_count, next_attempt_at, last_error_code, last_error_message, published_at, suspended_at, suspension_reason, created_at, updated_at, cancelled_at, archived_at, publication_failure_acknowledgements!left(publication_item_id, acknowledged_at, acknowledged_by), publication_item_events(id, event_type, previous_status, status, actor_label, error_code, error_message, metadata, created_at), publication_item_media(position, media_assets(id, original_name, mime_type, kind, size_bytes, storage_path, thumbnail_storage_path, status, deleted_at)))')
    .eq('organization_id', context.activeOrganization.id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);

  if (statusFilter) query = query.in('publication_items.status', queueStatusFilters[statusFilter]);
  if (formatFilter) query = query.eq('publication_items.format', formatFilter);
  if (timingFilter === 'immediate') query = query.is('publication_items.execute_at', null);
  if (timingFilter === 'scheduled') query = query.not('publication_items.execute_at', 'is', null);
  if (includedProfileIds) query = query.in('publication_items.profile_id', includedProfileIds);
  if (excludedProfileIds.length > 0) query = query.not('publication_items.profile_id', 'in', `(${excludedProfileIds.join(',')})`);
  if (archivedFilter === 'exclude') query = query.is('publication_items.archived_at', null);
  if (archivedFilter === 'only') query = query.not('publication_items.archived_at', 'is', null);
  if (acknowledgedFailuresFilter === 'exclude') query = query.is('publication_items.publication_failure_acknowledgements.publication_item_id', null);
  if (acknowledgedFailuresFilter === 'only') query = query.not('publication_items.publication_failure_acknowledgements.publication_item_id', 'is', null);

  if (hasCursor) {
    query = query.or(`created_at.lt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.lt.${cursorId})`);
  }

  const { data, error } = await query;

  if (error) return NextResponse.json({ error: 'Não foi possível carregar a fila.' }, { status: 500 });

  const hasMore = (data ?? []).length > limit;
  const page = (data ?? []).slice(0, limit);

  const creatorIds = [...new Set(page.map((batch) => batch.created_by))];
  const { data: creators, error: creatorsError } = creatorIds.length === 0
    ? { data: [], error: null }
    : await supabase
      .from('user_profiles')
      .select('user_id, display_name')
      .in('user_id', creatorIds);

  if (creatorsError) return NextResponse.json({ error: 'Não foi possível carregar os responsáveis pelas publicações.' }, { status: 500 });

  let profileById: Map<string, PublicationQueueProfile>;
  try {
    profileById = await loadQueueProfiles(
      supabase,
      context.activeOrganization.id,
      page.flatMap((batch) => (batch.publication_items ?? []).map((item) => item.profile_id)),
    );
  } catch (profileError) {
    console.error('Não foi possível carregar os provedores da fila.', profileError);
    return NextResponse.json({ error: 'Não foi possível carregar os provedores das publicações.' }, { status: 500 });
  }

  const creatorNameById = new Map((creators ?? []).map((creator) => [creator.user_id, creator.display_name]));
  const batches = await Promise.all(page.map(async (batch) => ({
    ...batch,
    created_by_name: creatorNameById.get(batch.created_by) ?? null,
    publication_items: await Promise.all((batch.publication_items ?? []).map(async (item) => ({
      ...item,
      profile: profileById.get(item.profile_id) ?? null,
      publication_item_media: await Promise.all((item.publication_item_media ?? []).map(async (media) => {
        const asset = Array.isArray(media.media_assets) ? media.media_assets[0] ?? null : media.media_assets;
        if (!asset) return { ...media, media_assets: null };
        if (asset.deleted_at || asset.status === 'deleted') return { ...media, media_assets: { ...asset, signed_url: null, thumbnail_url: null } };
        const [signed, thumbnail] = await Promise.all([
          signMediaPreviewUrl(supabase, asset.storage_path, 60 * 30, asset.kind === 'image' ? { width: 320, height: 320, resize: 'contain', quality: 65, format: 'origin' } : undefined),
          asset.thumbnail_storage_path ? signMediaPreviewUrl(supabase, asset.thumbnail_storage_path, 60 * 10) : Promise.resolve({ data: null }),
        ]);
        return { ...media, media_assets: { ...asset, signed_url: signed.data?.signedUrl ?? null, thumbnail_url: thumbnail.data?.signedUrl ?? null } };
      })),
    }))),
  })));

  const lastBatch = batches.at(-1);
  return NextResponse.json({
    batches,
    hasMore,
    nextCursor: hasMore && lastBatch ? { createdAt: lastBatch.created_at, id: lastBatch.id } : null,
  });
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  const organization = context.organizations.find((item) => item.id === context.activeOrganization?.id);

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }
  if (!organization || !['admin', 'operator'].includes(organization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  let body: { name?: unknown; scheduledFor?: unknown; items?: unknown };
  try {
    body = await request.json() as { name?: unknown; scheduledFor?: unknown; items?: unknown };
  } catch {
    return NextResponse.json({ error: 'Corpo da requisição inválido.' }, { status: 400 });
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: 'Informe ao menos um item de publicação.' }, { status: 400 });
  }
  if (body.items.length > maximumPublicationInputItems) {
    return NextResponse.json({ error: `O envio direto aceita até ${maximumPublicationInputItems.toLocaleString('pt-BR')} itens-base por requisição.` }, { status: 400 });
  }

  const inputs = body.items as PublicationInput[];
  const organizationId = context.activeOrganization.id;
  const scheduledFor = parseDate(body.scheduledFor);
  if (scheduledFor === undefined) {
    return NextResponse.json({ error: 'A data de agendamento do lote é inválida.' }, { status: 400 });
  }

  const cleanItems = inputs.map((item) => {
    const caption = cleanCaption(item.caption);
    const mediaIds = Array.isArray(item.mediaIds) && item.mediaIds.every((id) => typeof id === 'string')
      ? [...new Set(item.mediaIds as string[])]
      : null;
    const executeAt = parseDate(item.executeAt);
    const scheduleBaseAt = parseDate(item.scheduleBaseAt);
    const scheduleTime = typeof item.scheduleTime === 'string' && isPostingTimeSlot(item.scheduleTime)
      ? item.scheduleTime
      : item.scheduleTime === undefined || item.scheduleTime === null || item.scheduleTime === '' ? null : undefined;

    return {
      profileId: typeof item.profileId === 'string' ? item.profileId : null,
      groupId: typeof item.groupId === 'string' ? item.groupId : null,
      format: typeof item.format === 'string' && formats.has(item.format) ? item.format : null,
      mediaIds,
      caption,
      executeAt,
      scheduleBaseAt,
      scheduleTime,
      invalidCaption: caption === undefined,
      invalidSchedule: executeAt === undefined || scheduleBaseAt === undefined || scheduleTime === undefined
        || (scheduleTime !== null && executeAt !== null)
        || (scheduleTime !== null && scheduleBaseAt === null),
    };
  });

  if (cleanItems.some((item) => (!item.profileId && !item.groupId) || !item.format || !item.mediaIds || item.mediaIds.length === 0 || item.invalidCaption || item.invalidSchedule)) {
    return NextResponse.json({ error: 'Cada item precisa de perfil, formato, mídia e dados válidos.' }, { status: 400 });
  }

  const executionModes = new Set(cleanItems.map((item) => item.executeAt || item.scheduleTime ? 'scheduled' : 'immediate'));
  if (executionModes.size > 1) {
    return NextResponse.json({ error: 'Uma run deve ser totalmente imediata ou totalmente programada.' }, { status: 400 });
  }
  if (executionModes.has('scheduled') && cleanItems.some((item) => item.executeAt && new Date(item.executeAt).getTime() <= Date.now())) {
    return NextResponse.json({ error: 'Todas as publicações programadas precisam ter um horário futuro.' }, { status: 400 });
  }
  const supabase = await createSupabaseServerClient();
  const groupIds = [...new Set(cleanItems.flatMap((item) => item.groupId ? [item.groupId] : []))];
  const { data: groups, error: groupsError } = groupIds.length === 0
    ? { data: [], error: null }
    : await supabase
      .from('profile_groups')
      .select('id, default_caption, consumption_mode, profile_group_members(profile_id)')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .in('id', groupIds);

  if (groupsError || (groups ?? []).length !== groupIds.length) {
    return NextResponse.json({ error: 'Um ou mais grupos não pertencem à organização ativa.' }, { status: 400 });
  }

  const groupById = new Map((groups ?? []).map((group) => [group.id, group]));
  const groupPolicyError = cleanItems.some((item) => {
    if (!item.groupId) return false;
    const group = groupById.get(item.groupId);
    return !item.profileId && group?.consumption_mode === 'single_use' && item.format === 'carousel';
  });
  if (groupPolicyError) {
    return NextResponse.json({ error: 'Carrosséis por grupo exigem mídia reutilizável. Para mídia de uso único, publique os carrosséis por perfil.' }, { status: 400 });
  }

  const insufficientSingleUseMedia = cleanItems.some((item) => {
    if (!item.groupId) return false;
    const group = groupById.get(item.groupId);
    return !item.profileId && group?.consumption_mode === 'single_use' && item.mediaIds!.length !== (group.profile_group_members ?? []).length;
  });
  if (insufficientSingleUseMedia) {
    return NextResponse.json({ error: 'Em grupos de uso único, selecione exatamente uma mídia compatível para cada perfil do grupo.' }, { status: 400 });
  }

  const expandedItems = cleanItems.flatMap((item) => {
    if (item.profileId) return [item];
    const group = item.groupId ? groupById.get(item.groupId) : null;
    const members = group?.profile_group_members ?? [];
    return members.map((member, index) => ({
      ...item,
      profileId: member.profile_id,
      mediaIds: group?.consumption_mode === 'single_use' ? [item.mediaIds![index]] : item.mediaIds,
      caption: item.caption ?? group?.default_caption ?? null,
    }));
  });

  if (expandedItems.length === 0) {
    return NextResponse.json({ error: 'O grupo selecionado não possui perfis conectados.' }, { status: 400 });
  }
  if (expandedItems.length > maximumAsyncPublicationItems) {
    return NextResponse.json({ error: `A seleção resulta em mais de ${maximumAsyncPublicationItems.toLocaleString('pt-BR')} publicações. Divida em mais de um envio por enquanto.` }, { status: 400 });
  }
  const plannedSlots = new Set<string>();
  for (const item of expandedItems) {
    if (!item.executeAt) continue;
    const key = `${item.profileId}:${item.format}:${item.executeAt}`;
    if (plannedSlots.has(key)) {
      return NextResponse.json({ error: 'O mesmo perfil não pode ter duas postagens do mesmo formato na mesma data e horário.' }, { status: 400 });
    }
    plannedSlots.add(key);
  }
  const profileIds = [...new Set(expandedItems.map((item) => item.profileId!))];
  const mediaIds = [...new Set(expandedItems.flatMap((item) => item.mediaIds!))];
  // A seleção pode passar de 1.000 perfis/mídias (o teto deste envio é
  // maximumAsyncPublicationItems). Sem ler por blocos, o PostgREST devolve 1.000
  // linhas, a comparação de comprimento abaixo falha e o agendamento é recusado
  // com uma mensagem que não descreve o problema real.
  const [profilesResult, mediaResult] = await Promise.all([
    fetchAllRowsByIds(profileIds, (chunk, from, to) => supabase.from('instagram_profiles').select('id').eq('organization_id', organizationId).is('deleted_at', null).in('id', chunk).order('id', { ascending: true }).range(from, to)),
    fetchAllRowsByIds(mediaIds, (chunk, from, to) => supabase.from('media_assets').select('id, kind, mime_type, original_name, storage_path').eq('organization_id', organizationId).is('deleted_at', null).is('deletion_requested_at', null).eq('status', 'ready').in('id', chunk).order('id', { ascending: true }).range(from, to)),
  ]);

  if (profilesResult.error || mediaResult.error || profilesResult.data.length !== profileIds.length || mediaResult.data.length !== mediaIds.length) {
    return NextResponse.json({ error: 'Um ou mais perfis ou mídias não pertencem à organização ativa ou não estão prontos.' }, { status: 400 });
  }

  const storageChecks = await Promise.all((mediaResult.data ?? []).map(async (asset) => {
    const { data } = await signMediaPreviewUrl(supabase, asset.storage_path, 60);
    return { asset, available: Boolean(data?.signedUrl) };
  }));
  const missingStorage = storageChecks.filter((check) => !check.available);
  if (missingStorage.length > 0) {
    const names = missingStorage.slice(0, 3).map((check) => `“${check.asset.original_name}”`).join(', ');
    return NextResponse.json({
      error: `Uma ou mais mídias não possuem arquivo físico no Storage (${names}${missingStorage.length > 3 ? '…' : ''}). Reenvie os arquivos na galeria antes de agendar.`,
    }, { status: 400 });
  }

  const mediaById = new Map((mediaResult.data ?? []).map((asset) => [asset.id, asset]));
  for (const item of expandedItems) {
    const error = validateMediaForFormat(item.format! as import('@/lib/publications/composer').ComposerFormat, item.mediaIds!.map((id) => ({ id, kind: mediaById.get(id)?.kind ?? 'image' })));
    if (error) return NextResponse.json({ error }, { status: 400 });
  }

  const explicitGroupItems = cleanItems.filter((item) => item.groupId && item.profileId);
  for (const item of explicitGroupItems) {
    const group = item.groupId ? groupById.get(item.groupId) : null;
    const isMember = (group?.profile_group_members ?? []).some((member) => member.profile_id === item.profileId);
    if (!isMember) return NextResponse.json({ error: 'Todos os perfis precisam pertencer ao grupo selecionado.' }, { status: 400 });
  }
  const singleUseGroups = new Set(explicitGroupItems.filter((item) => item.groupId && groupById.get(item.groupId)?.consumption_mode === 'single_use').map((item) => item.groupId!));
  for (const groupId of singleUseGroups) {
    const used = explicitGroupItems.filter((item) => item.groupId === groupId).flatMap((item) => item.mediaIds ?? []);
    if (new Set(used).size !== used.length) {
      return NextResponse.json({ error: 'No modo de uso único, uma mídia não pode ser repetida entre os perfis deste envio.' }, { status: 400 });
    }
  }

  const idempotencyBatchSeed = randomUUID();
  const rows = expandedItems.map((item, index) => ({
    profile_id: item.profileId!,
    format: item.format!,
    execute_at: item.executeAt,
    schedule_time: item.scheduleTime,
    schedule_base_at: item.scheduleBaseAt,
    caption: item.caption,
    mediaIds: item.mediaIds!,
    idempotency_key: idempotencyKey(idempotencyBatchSeed, {
      profileId: item.profileId!,
      format: item.format!,
      mediaIds: item.mediaIds!,
      caption: item.caption ?? null,
      executeAt: item.executeAt ?? null,
    }, index),
  }));

  if (rows.length > synchronousPublicationLimit) {
    const items = rows.map((row) => ({
      profileId: row.profile_id,
      format: row.format,
      executeAt: row.execute_at,
      scheduleTime: row.schedule_time,
      scheduleBaseAt: row.schedule_base_at,
      caption: row.caption,
      idempotencyKey: row.idempotency_key,
      mediaIds: row.mediaIds,
    }));

    const { data: generationJob, error: generationJobError } = await supabase.rpc('create_publication_generation_job', {
      p_organization_id: organizationId,
      p_name: typeof body.name === 'string' ? body.name : null,
      p_scheduled_for: scheduledFor,
      p_payload: {
        kind: 'publication-generation',
        version: 1,
        source: 'publications-api',
        items,
      },
      p_expected_items: rows.length,
      p_chunk_size: asyncGenerationChunkSize,
      p_metadata: {
        source: 'publications-api-large-submission',
        synchronousLimit: synchronousPublicationLimit,
        expandedItems: rows.length,
        inputItems: cleanItems.length,
        createdByEmail: context.user.email ?? null,
      },
    });

    if (generationJobError || !generationJob) {
      console.error('Não foi possível criar job assíncrono de publicações.', generationJobError);
      return NextResponse.json({ error: 'Não foi possível criar o job assíncrono de publicações.' }, { status: 500 });
    }

    return NextResponse.json({
      async: true,
      generationJob: (generationJob as { job?: unknown }).job ?? generationJob,
      acceptedItems: rows.length,
      chunkSize: asyncGenerationChunkSize,
    }, { status: 202 });
  }

  const { data: queued, error: queueError } = await supabase.rpc('queue_publication_batch', {
    p_organization_id: organizationId,
    p_name: typeof body.name === 'string' ? body.name : null,
    p_scheduled_for: scheduledFor,
    p_items: rows.map((row) => ({
      profileId: row.profile_id,
      format: row.format,
      executeAt: row.execute_at,
      scheduleTime: row.schedule_time,
      scheduleBaseAt: row.schedule_base_at,
      caption: row.caption,
      idempotencyKey: row.idempotency_key,
      mediaIds: row.mediaIds,
    })),
  });
  if (queueError || !queued) {
    if (queueError?.message.includes('minute_conflict') || queueError?.message.includes('slot_conflict') || queueError?.code === '23505') {
      return NextResponse.json({ error: 'Já há uma postagem agendada para este horário neste perfil.' }, { status: 409 });
    }
    console.error('Não foi possível reservar os slots de publicação.', queueError);
    return NextResponse.json({ error: 'Não foi possível criar os itens da fila.' }, { status: 500 });
  }

  const result = queued as { batch: { id: string; name: string | null; status: string; scheduled_for: string | null; timezone: string; review_confirmed_at: string | null; created_at: string; updated_at: string }; itemIds: string[] };
  // itemIds vem do lote recém-criado e pode chegar a maximumAsyncPublicationItems
  // (50.000): a confirmação precisa ser lida por blocos.
  const { data: createdItems, error: createdItemsError } = await fetchAllRowsByIds(result.itemIds, (chunk, from, to) => supabase
    .from('publication_items')
    .select('id, profile_id, format, status, execute_at, caption, attempt_count, next_attempt_at')
    .in('id', chunk)
    .order('id', { ascending: true })
    .range(from, to));
  if (createdItemsError) return NextResponse.json({ error: 'A publicação foi reservada, mas não foi possível carregar a confirmação.' }, { status: 500 });

  const hasImmediateItems = expandedItems.some((item) => !item.executeAt && !item.scheduleTime);
  const dispatch = hasImmediateItems
    ? {
      started: false,
      mode: 'vps_worker_primary' as const,
      fallback: 'vercel_cron_when_vps_worker_is_stale' as const,
    }
    : {
      started: false,
      mode: 'scheduled_queue' as const,
    };

  return NextResponse.json({ batch: result.batch, items: createdItems, dispatch }, { status: 201 });
}
