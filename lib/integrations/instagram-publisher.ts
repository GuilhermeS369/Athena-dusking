import { createHash } from 'node:crypto';
import { decryptToken } from '@/lib/security/token-crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createR2SignedUrl } from '@/lib/storage/r2-client';
import { isRetryableGraphFailure, metaContainerVerdict } from '@/lib/integrations/meta-graph-errors';

// 'supabase' (padrão) usa o Storage do Supabase, que cobra egress por byte
// transferido. 'r2' usa Cloudflare R2 (egress $0), mantendo o mesmo
// comportamento de gerar uma signed URL nova por despacho.
function mediaStorageBackend() {
  return (process.env.MEDIA_STORAGE_BACKEND || 'supabase').toLowerCase();
}

export type PublicationFormat = 'image' | 'reel' | 'story' | 'carousel';

type PublicationMedia = {
  id: string;
  storage_path: string;
  kind: 'image' | 'video';
};

export type PublicationCover = {
  id: string;
  storage_path: string;
  kind: 'image';
};

type PublicationProfile = {
  id: string;
  organization_id?: string;
  provider?: 'meta_official' | 'zernio';
  instagram_user_id: string;
  encrypted_access_token: string | null;
  zernio_account_id?: string | null;
  zernio_connection_id?: string | null;
};

export type PublicationWorkItem = {
  id: string;
  execute_at?: string | null;
  format: PublicationFormat;
  caption: string | null;
  creation_id: string | null;
  profile: PublicationProfile;
  media: PublicationMedia[];
  cover?: PublicationCover | null;
};

export type PublicationResult =
  | { state: 'published'; metaMediaId: string | null; recovered?: boolean }
  | { state: 'processing'; creationId: string }
  | { state: 'deferred'; reason: 'daily_profile_limit' }
  | { state: 'removed'; retryable: false; errorCode: string; errorMessage: string }
  | { state: 'failed'; retryable: boolean; errorCode: string; errorMessage: string };

const graphVersion = process.env.META_GRAPH_API_VERSION ?? 'v26.0';
const metaRequestTimeoutMs = 25_000;
/**
 * `media_publish` ganha limite proprio, e maior. Diagnosticado em 05/09/2026,
 * depois que os timeouts passaram a ser rotulados por operacao: TODOS estouravam
 * em `meta_timeout_publicar` -- nenhum ao criar o conteiner, nenhum ao consultar
 * o status. Faz sentido: consultar status e leitura barata e criar conteiner e
 * registro, enquanto publicar e a operacao em que a Meta faz trabalho de verdade.
 *
 * Dar 25 s aos tres produzia atrito so na terceira. E o limite dos outros dois
 * FICA onde esta de proposito: consultar status demorando 25 s seria sinal de
 * problema, e afrouxar isso nos cegaria de novo.
 *
 * Retentar aqui e seguro: se a Meta ja tiver publicado quando o tempo estoura, a
 * proxima rodada le `status_code = PUBLISHED` e devolve sucesso sem republicar.
 * Verificado em 1.905 publicacoes: zero `creation_id` publicado duas vezes.
 */
const metaPublishTimeoutMs = 60_000;
const mediaProbeTimeoutMs = 12_000;
const maxConcurrentMetaRequests = 5;
let activeMetaRequests = 0;
const pendingMetaRequests: Array<() => void> = [];

function graphUrl(path: string) {
  return `https://graph.instagram.com/${graphVersion}/${path.replace(/^\//, '')}`;
}

async function withMetaRequestLimit<T>(operation: () => Promise<T>): Promise<T> {
  if (activeMetaRequests >= maxConcurrentMetaRequests) {
    await new Promise<void>((resolve) => pendingMetaRequests.push(resolve));
  }

  activeMetaRequests += 1;
  try {
    return await operation();
  } finally {
    activeMetaRequests -= 1;
    pendingMetaRequests.shift()?.();
  }
}

/**
 * `operacao` existe porque um timeout sem rótulo não diz nada. Em 04/09/2026
 * apareceram 112 falhas com "The operation was aborted due to timeout" e não
 * havia como saber se estourava ao CRIAR o contêiner, ao CONSULTAR o status ou
 * ao PUBLICAR — e sem isso qualquer ajuste no limite de 25 s seria chute.
 *
 * O timeout continua retentável: é transitório por definição.
 */
function metaFetch(input: RequestInfo | URL, init: RequestInit, operacao = 'meta', limiteMs = metaRequestTimeoutMs) {
  return withMetaRequestLimit(async () => {
    try {
      return await fetch(input, init);
    } catch (error) {
      const nome = (error as { name?: string } | null)?.name;
      if (nome !== 'TimeoutError' && nome !== 'AbortError') throw error;
      const rotulado = new Error(
        `Tempo esgotado ao ${operacao} na Meta (limite de ${limiteMs / 1000}s).`,
      ) as Error & { retryable?: boolean; code?: string };
      rotulado.retryable = true;
      rotulado.code = `meta_timeout_${operacao}`;
      throw rotulado;
    }
  });
}

function publicationDataError(message: string, code = 'invalid_publication_data') {
  const error = new Error(message) as Error & { retryable?: boolean; code?: string };
  error.retryable = false;
  error.code = code;
  return error;
}

function storageSignedUrlError(error: unknown) {
  const details = error && typeof error === 'object'
    ? error as { message?: unknown; statusCode?: unknown; status?: unknown; name?: unknown }
    : {};
  const message = typeof details.message === 'string' ? details.message : '';
  const status = Number(details.statusCode ?? details.status);
  const missingObject = status === 404 || /object not found/i.test(message);
  const typed = new Error(missingObject
    ? 'Arquivo da mídia não encontrado no Storage. Reenvie a mídia na galeria antes de publicar.'
    : 'Não foi possível criar URL temporária da mídia.') as Error & { retryable?: boolean; code?: string };
  typed.retryable = !missingObject;
  typed.code = missingObject ? 'media_storage_object_missing' : 'storage_signed_url_failed';
  return typed;
}

export async function createTemporaryUrl(storagePath: string) {
  if (mediaStorageBackend() === 'r2') {
    try {
      const bucket = process.env.R2_BUCKET_INSTAGRAM_MEDIA || 'instagram-media';
      // Vídeos podem continuar em processamento após esta execução curta do worker.
      // Mantemos a URL disponível por 24 horas para a Meta/Zernio finalizar o download.
      return await createR2SignedUrl(bucket, storagePath, 60 * 60 * 24);
    } catch (error) {
      throw storageSignedUrlError(error);
    }
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.storage
    .from('instagram-media')
    .createSignedUrl(storagePath, 60 * 60 * 24);

  if (error || !data?.signedUrl) throw storageSignedUrlError(error);
  return data.signedUrl;
}

export type VerifiedTemporaryMediaUrl = {
  url: string;
  fingerprint: string;
  httpStatus: number;
  contentType: string;
};

function mediaUrlProbeError(message: string, code: string, retryable = true) {
  const error = new Error(message) as Error & { retryable?: boolean; code?: string };
  error.retryable = retryable;
  error.code = code;
  return error;
}

function compatibleMediaType(kind: PublicationMedia['kind'], contentType: string) {
  return kind === 'video' ? /^video\//i.test(contentType) : /^image\//i.test(contentType);
}

export async function probeTemporaryMediaUrl(url: string, kind: PublicationMedia['kind']): Promise<VerifiedTemporaryMediaUrl> {
  const probe = async (method: 'HEAD' | 'GET', range = false) => {
    const response = await fetch(url, {
      method,
      headers: range ? { Range: 'bytes=0-1023' } : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(mediaProbeTimeoutMs),
    });
    const contentType = response.headers.get('content-type') ?? '';
    await response.body?.cancel().catch(() => undefined);
    return { response, contentType };
  };

  let result: { response: Response; contentType: string };
  try {
    result = await probe('HEAD');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw mediaUrlProbeError('A verificação externa da URL da mídia expirou.', 'media_url_probe_timeout');
    throw mediaUrlProbeError('Não foi possível verificar externamente a URL da mídia.', 'media_url_probe_network');
  }

  if (!result.response.ok || !compatibleMediaType(kind, result.contentType)) {
    try {
      result = await probe('GET', true);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') throw mediaUrlProbeError('A leitura parcial da URL da mídia expirou.', 'media_url_range_probe_timeout');
      throw mediaUrlProbeError('Não foi possível ler externamente a URL da mídia.', 'media_url_range_probe_network');
    }
  }

  if (!result.response.ok) throw mediaUrlProbeError(`A URL temporária da mídia retornou HTTP ${result.response.status}.`, `media_url_probe_http_${result.response.status}`, result.response.status >= 500);
  if (!compatibleMediaType(kind, result.contentType)) throw mediaUrlProbeError('A URL temporária retornou tipo de conteúdo incompatível com a mídia.', 'media_url_probe_mime_invalid', false);
  return {
    url,
    fingerprint: createHash('sha256').update(url).digest('hex'),
    httpStatus: result.response.status,
    contentType: result.contentType,
  };
}

export async function createVerifiedTemporaryMediaUrl(storagePath: string, kind: PublicationMedia['kind']) {
  return probeTemporaryMediaUrl(await createTemporaryUrl(storagePath), kind);
}

async function readResponse(response: Response) {
  const body = await response.json().catch(() => ({})) as {
    id?: string;
    status_code?: string;
    /** Motivo em texto do status. So chega porque containerStatus o pede. */
    status?: string;
    error?: { code?: number; message?: string; is_transient?: boolean };
  };

  if (!response.ok) {
    const message = body.error?.message ?? `Instagram retornou HTTP ${response.status}.`;
    const graphCode = body.error?.code;
    const error = new Error(message) as Error & { retryable?: boolean; code?: string };
    error.retryable = isRetryableGraphFailure(response.status, graphCode, body.error?.is_transient);
    error.code = String(graphCode ?? response.status);
    throw error;
  }

  return body;
}

async function createContainer(
  profileId: string,
  accessToken: string,
  fields: Record<string, string>,
) {
  const body = new URLSearchParams(fields);
  const response = await metaFetch(graphUrl(`${encodeURIComponent(profileId)}/media`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(metaRequestTimeoutMs),
  }, 'criar_container');
  const result = await readResponse(response);
  if (!result.id) throw new Error('Instagram não retornou o creation_id do contêiner.');
  return result.id;
}

async function containerStatus(creationId: string, accessToken: string) {
  const url = new URL(graphUrl(encodeURIComponent(creationId)));
  // `status` junto com `status_code`, e nao so o segundo. O `status_code` diz
  // apenas ERROR; o `status` traz o motivo em texto, que e a unica coisa que
  // permite distinguir midia inacessivel de formato recusado de conta bloqueada.
  //
  // Medido em 04/09/2026: 73 publicacoes foram encerradas como falha terminal
  // com a mensagem "Instagram informou ERROR", e nenhuma delas dizia por que --
  // porque nunca perguntamos. Pior: consultados depois, os mesmos conteineres
  // respondiam FINISHED, entao o veredito nem sequer se sustentava.
  url.searchParams.set('fields', 'status_code,status');
  const response = await metaFetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(metaRequestTimeoutMs),
  }, 'consultar_status');
  return readResponse(response);
}

async function publishContainer(profileId: string, creationId: string, accessToken: string) {
  const response = await metaFetch(graphUrl(`${encodeURIComponent(profileId)}/media_publish`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: creationId }),
    cache: 'no-store',
    signal: AbortSignal.timeout(metaPublishTimeoutMs),
  }, 'publicar', metaPublishTimeoutMs);
  const result = await readResponse(response);
  if (!result.id) throw new Error('Instagram não retornou o media_id publicado.');
  return result.id;
}

async function createParentContainer(item: PublicationWorkItem, accessToken: string) {
  if (item.media.length === 0) {
    throw publicationDataError('O item da publicação não possui mídia vinculada.');
  }
  if (item.format === 'carousel' && (item.media.length < 2 || item.media.length > 10)) {
    throw publicationDataError('O carrossel deve possuir entre 2 e 10 mídias.');
  }
  if (item.format !== 'carousel' && item.media.length !== 1) {
    throw publicationDataError('Este formato de publicação requer exatamente uma mídia.');
  }

  const urls = await Promise.all(item.media.map(async (media) => (await createVerifiedTemporaryMediaUrl(media.storage_path, media.kind)).url));
  if (item.format === 'image') {
    if (item.media[0].kind !== 'image') throw publicationDataError('Uma publicação de imagem requer arquivo de imagem.');
    return createContainer(item.profile.instagram_user_id, accessToken, { image_url: urls[0], caption: item.caption ?? '' });
  }
  if (item.format === 'reel') {
    if (item.media[0].kind !== 'video') throw publicationDataError('Um Reel requer arquivo de vídeo.');
    return createContainer(item.profile.instagram_user_id, accessToken, { media_type: 'REELS', video_url: urls[0], caption: item.caption ?? '', share_to_feed: 'true' });
  }
  if (item.format === 'story') {
    const media = item.media[0];
    return createContainer(item.profile.instagram_user_id, accessToken, media.kind === 'video'
      ? { media_type: 'STORIES', video_url: urls[0] }
      : { media_type: 'STORIES', image_url: urls[0] });
  }

  const children = await Promise.all(item.media.map((media, index) => createContainer(item.profile.instagram_user_id, accessToken, media.kind === 'video'
    ? { media_type: 'VIDEO', video_url: urls[index], is_carousel_item: 'true' }
    : { image_url: urls[index], is_carousel_item: 'true' })));
  return createContainer(item.profile.instagram_user_id, accessToken, { media_type: 'CAROUSEL', children: children.join(','), caption: item.caption ?? '' });
}

export async function processInstagramPublication(
  item: PublicationWorkItem,
  beforePublish?: () => Promise<boolean>,
): Promise<PublicationResult> {
  try {
    if (item.cover) throw publicationDataError('Capa personalizada de Reel requer um perfil Zernio.', 'custom_reel_cover_requires_zernio');
    if (!item.profile.encrypted_access_token) {
      throw publicationDataError('Perfil Meta sem token de acesso. Reconecte o perfil.', 'missing_meta_access_token');
    }
    const accessToken = decryptToken(item.profile.encrypted_access_token);
    if (!item.creation_id) {
      // Persistir o ID antes de consultar status evita criar outro contêiner na próxima rodada.
      return { state: 'processing', creationId: await createParentContainer(item, accessToken) };
    }

    const creationId = item.creation_id;
    const status = await containerStatus(creationId, accessToken);

    // A decisao vive em metaContainerVerdict, ao lado de isRetryableGraphFailure:
    // e la que fica registrado por que ERROR adia e EXPIRED encerra, e e la que o
    // teste trava a regra. Aqui ficam so os efeitos.
    const veredito = metaContainerVerdict(status.status_code, status.status);

    if (veredito.kind === 'publish') {
      if (beforePublish && !await beforePublish()) return { state: 'deferred', reason: 'daily_profile_limit' };
      const metaMediaId = await publishContainer(item.profile.instagram_user_id, creationId, accessToken);
      return { state: 'published', metaMediaId };
    }

    // A resposta do media_publish pode se perder depois que a Meta concluiu a
    // operacao. Na retomada, PUBLISHED e sucesso remoto e nunca deve disparar
    // outro media_publish para o mesmo creation_id.
    if (veredito.kind === 'already_published') {
      return { state: 'published', metaMediaId: null, recovered: true };
    }

    if (veredito.kind === 'fail') {
      return {
        state: 'failed',
        retryable: veredito.retryable,
        errorCode: status.status_code as string,
        errorMessage: veredito.message,
      };
    }

    if (!status.status_code) {
      const error = new Error('Instagram não retornou o status do contêiner.') as Error & { retryable?: boolean; code?: string };
      error.retryable = true;
      error.code = 'missing_container_status';
      throw error;
    }

    return { state: 'processing', creationId };
  } catch (error) {
    const typed = error as Error & { retryable?: boolean; code?: string };
    return {
      state: 'failed',
      retryable: typed.retryable ?? true,
      errorCode: typed.code ?? 'instagram_request_failed',
      errorMessage: (typed.message || 'Falha desconhecida ao comunicar com o Instagram.').slice(0, 1200),
    };
  }
}
