import { createVerifiedTemporaryMediaUrl, type PublicationResult, type PublicationWorkItem } from '@/lib/integrations/instagram-publisher';
import { createZernioClientForConnection, createZernioClientForOrganization, type ZernioError, type ZernioPost } from '@/lib/integrations/zernio-client';

function publicationDataError(message: string, code = 'invalid_zernio_publication_data') {
  const error = new Error(message) as Error & { retryable?: boolean; code?: string };
  error.retryable = false;
  error.code = code;
  return error;
}

function zernioPostId(post: ZernioPost | undefined) {
  return post?._id ?? post?.id ?? null;
}

function zernioPlatformEntry(post: ZernioPost | undefined) {
  return post?.platforms?.find((entry) => entry.platform === 'instagram') ?? post?.platforms?.[0] ?? null;
}

function remoteId(value: unknown) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return [record._id, record.id, record.accountId].find((entry): entry is string => typeof entry === 'string') ?? null;
}

function matchesWorkItem(post: ZernioPost, item: PublicationWorkItem) {
  const platform = post.platforms?.find((entry) => entry.platform === 'instagram'
    && remoteId(entry.accountId) === item.profile.zernio_account_id);
  if (!platform) return false;
  const contentType = (platform.platformSpecificData as Record<string, unknown> | undefined)?.contentType;
  if (item.format === 'story' && contentType !== 'story') return false;
  if (item.format !== 'story' && contentType === 'story') return false;
  const urls = (post.mediaItems ?? []).map((media) => String(media.url ?? ''));
  return item.media.length > 0 && item.media.every((media) => urls.some((url) => {
    try {
      const pathname = decodeURIComponent(new URL(url).pathname);
      return pathname.endsWith(`/${media.storage_path}`) || pathname.includes(`athena-${media.id}.`);
    } catch {
      return url.includes(media.storage_path) || url.includes(`athena-${media.id}.`);
    }
  }));
}

function normalizedStatus(value: unknown) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function diagnosticText(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text
    .replace(/https?:\/\/[^\s"']+/gi, '[URL ocultada]')
    .replace(/bearer\s+[^\s"']+/gi, 'Bearer [oculto]')
    .slice(0, 700);
}

function zernioErrorMessage(error: ZernioError) {
  const parts = [error.message];
  const details = diagnosticText(error.details);
  if (details) parts.push(`Detalhes da Zernio: ${details}`);
  if (error.requestId) parts.push(`ID da requisição Zernio: ${error.requestId}`);
  return parts.join(' — ').slice(0, 1200);
}

function statusResult(post: ZernioPost): PublicationResult {
  const platform = zernioPlatformEntry(post);
  const platformStatus = normalizedStatus(platform?.status);
  const postStatus = normalizedStatus(post.status);
  const published = ['published', 'success', 'posted', 'completed'].includes(platformStatus)
    || ['published', 'success', 'posted', 'completed'].includes(postStatus);
  if (published) {
    return { state: 'published', metaMediaId: platform?.platformPostUrl ?? post.platformPostUrl ?? zernioPostId(post) };
  }

  const failed = ['failed', 'error', 'rejected', 'cancelled'].includes(platformStatus)
    || ['failed', 'error', 'rejected', 'cancelled'].includes(postStatus);
  if (failed) {
    const message = platform?.failureReason
      ?? platform?.error
      ?? platform?.errorMessage
      ?? platform?.message
      ?? 'Zernio informou falha ao publicar no Instagram sem detalhar o motivo.';
    const category = typeof platform?.errorCategory === 'string' ? platform.errorCategory : null;
    const source = typeof platform?.errorSource === 'string' ? platform.errorSource : null;
    return {
      state: 'failed',
      retryable: false,
      errorCode: category ?? (platformStatus || postStatus || 'zernio_publication_failed'),
      errorMessage: `${String(message)}${source ? ` (origem: ${source})` : ''}`.slice(0, 1200),
    };
  }

  const id = zernioPostId(post);
  if (!id) throw publicationDataError('Zernio não retornou o identificador do post.', 'missing_zernio_post_id');
  return { state: 'processing', creationId: id };
}

async function preparedMediaUrls(item: PublicationWorkItem, media: PublicationWorkItem['media']) {
  if (!item.profile.organization_id) throw publicationDataError('Organização do perfil Zernio ausente.');
  // Gera uma signed URL nova por despacho (nunca reaproveita a mesma URL entre
  // publicações): a Zernio rejeita como "duplicate content" quando a mesma URL
  // física é enviada de novo para a mesma conta em menos de 24h (ver
  // docs/athena-publication-pipeline-v2-2026-08-24.md, seção "Reversão da
  // hospedagem antecipada — 27/08/2026").
  const verified = await Promise.all(media.map((asset) => createVerifiedTemporaryMediaUrl(asset.storage_path, asset.kind)));
  return verified.map((entry) => entry.url);
}

async function buildMediaItems(item: PublicationWorkItem) {
  const urls = await preparedMediaUrls(item, item.media);
  return item.media.map((media, index) => ({ type: media.kind, url: urls[index] }));
}

function validateZernioMedia(item: PublicationWorkItem) {
  if (item.format === 'image') {
    if (item.media.length !== 1) throw publicationDataError('Publicação de imagem via Zernio requer exatamente uma mídia.', 'zernio_image_media_count_invalid');
    if (item.media[0].kind !== 'image') throw publicationDataError('Publicação de imagem via Zernio requer arquivo de imagem.', 'zernio_image_media_invalid');
    return;
  }

  if (item.format === 'reel') {
    if (item.media.length !== 1) throw publicationDataError('Reel via Zernio requer exatamente um vídeo.', 'zernio_reel_media_count_invalid');
    if (item.media[0].kind !== 'video') throw publicationDataError('Reel via Zernio requer arquivo de vídeo.', 'zernio_reel_media_invalid');
    return;
  }

  if (item.format === 'story') {
    if (item.media.length !== 1) throw publicationDataError('Story via Zernio requer exatamente uma mídia.', 'zernio_story_media_count_invalid');
    if (item.media[0].kind !== 'image' && item.media[0].kind !== 'video') throw publicationDataError('Story via Zernio requer imagem ou vídeo.', 'zernio_story_media_invalid');
    return;
  }

  if (item.format === 'carousel') {
    if (item.media.length < 2 || item.media.length > 10) throw publicationDataError('Carrossel via Zernio requer entre 2 e 10 mídias.', 'zernio_carousel_media_count_invalid');
    if (item.media.some((media) => media.kind !== 'image' && media.kind !== 'video')) throw publicationDataError('Carrossel via Zernio aceita apenas imagens e vídeos.', 'zernio_carousel_media_invalid');
    return;
  }

  throw publicationDataError('Formato não suportado pela Zernio.', 'zernio_format_not_supported');
}

async function platformSpecificData(item: PublicationWorkItem) {
  const format = item.format;
  if (format === 'story') return { contentType: 'story' };
  if (format === 'reel') return {
    shareToFeed: true,
    ...(item.cover ? { instagramThumbnail: (await preparedMediaUrls(item, [item.cover]))[0] } : {}),
  };
  return undefined;
}

async function createZernioPost(item: PublicationWorkItem) {
  const accountId = item.profile.zernio_account_id;
  if (!item.profile.organization_id) throw publicationDataError('Organização do perfil Zernio ausente.');
  if (!accountId) throw publicationDataError('Perfil não possui social account da Zernio.');
  validateZernioMedia(item);
  if (item.cover && item.format !== 'reel') throw publicationDataError('Capa personalizada só pode ser enviada em Reel.', 'zernio_cover_format_invalid');

  const client = item.profile.zernio_connection_id
    ? await createZernioClientForConnection(item.profile.organization_id, item.profile.zernio_connection_id)
    : await createZernioClientForOrganization(item.profile.organization_id);
  const specificData = await platformSpecificData(item);
  const response = await client.createPost({
    content: item.caption ?? '',
    mediaItems: await buildMediaItems(item),
    platforms: [{
      platform: 'instagram',
      accountId,
      ...(specificData ? { platformSpecificData: specificData } : {}),
    }],
    publishNow: true,
  }, `athena-${item.id}`);

  const post = response.post ?? response.existingPost;
  const result = statusResult(post ?? {});
  if (result.state === 'processing') return result.creationId;
  if (result.state === 'published') return zernioPostId(post) ?? result.metaMediaId ?? item.id;
  if (result.state === 'failed' || result.state === 'removed') {
    throw publicationDataError(result.errorMessage, result.errorCode);
  }
  throw publicationDataError('A Zernio adiou a publicação de forma inesperada.', 'zernio_unexpected_deferred_state');
}

async function reconcileCreation(item: PublicationWorkItem, error: ZernioError) {
  if (!item.profile.organization_id || !item.profile.zernio_account_id) return null;
  const client = item.profile.zernio_connection_id
    ? await createZernioClientForConnection(item.profile.organization_id, item.profile.zernio_connection_id)
    : await createZernioClientForOrganization(item.profile.organization_id);
  let posts: ZernioPost[] = [];
  if (error.existingPostId) {
    const response = await client.getPost(error.existingPostId);
    if (response.post) posts = [response.post];
  } else {
    const anchor = item.execute_at && !Number.isNaN(Date.parse(item.execute_at)) ? Date.parse(item.execute_at) : Date.now();
    const response = await client.listPosts({
      accountId: item.profile.zernio_account_id,
      source: 'zernio',
      dateFrom: new Date(anchor - 10 * 60_000).toISOString(),
      dateTo: new Date(Math.max(Date.now() + 5 * 60_000, anchor + 2 * 60 * 60_000)).toISOString(),
      limit: 100,
      sortBy: 'created-asc',
    });
    posts = response.posts ?? [];
  }
  const matches = posts.filter((post) => matchesWorkItem(post, item));
  if (matches.length !== 1) return null;
  const result = statusResult(matches[0]);
  return result.state === 'published' ? { ...result, recovered: true } : result;
}

export async function processZernioInstagramPublication(item: PublicationWorkItem): Promise<PublicationResult> {
  try {
    if (!item.creation_id) return { state: 'processing', creationId: await createZernioPost(item) };

    if (!item.profile.organization_id) throw publicationDataError('Organização do perfil Zernio ausente.');
    const client = item.profile.zernio_connection_id
      ? await createZernioClientForConnection(item.profile.organization_id, item.profile.zernio_connection_id)
      : await createZernioClientForOrganization(item.profile.organization_id);
    const response = await client.getPost(item.creation_id);
    if (!response.post) throw publicationDataError('Zernio não retornou dados do post.', 'zernio_post_missing');
    return statusResult(response.post);
  } catch (error) {
    const typed = error as Error & { retryable?: boolean; code?: string };
    const zernioError = typed as ZernioError;
    const outcomeUnknown = zernioError.httpStatus === 409
      || (typeof zernioError.httpStatus === 'number' && zernioError.httpStatus >= 500)
      || typeof zernioError.httpStatus !== 'number';
    if (!item.creation_id && outcomeUnknown) {
      try {
        const reconciled = await reconcileCreation(item, zernioError);
        if (reconciled) return reconciled;
      } catch {
        // A falha de consulta não autoriza uma segunda criação automática.
      }
      return {
        state: 'failed',
        retryable: false,
        errorCode: 'zernio_creation_outcome_unknown',
        errorMessage: 'A criação Zernio não retornou confirmação e não pôde ser reconciliada sem risco de duplicidade.',
      };
    }
    return {
      state: 'failed',
      retryable: typed.retryable ?? true,
      errorCode: typed.code ?? 'zernio_request_failed',
      errorMessage: zernioErrorMessage(zernioError),
    };
  }
}
