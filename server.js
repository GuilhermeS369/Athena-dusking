require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const INSTAGRAM_API_VERSION = 'v20.0';
const INSTAGRAM_AUTHORIZE_URL = 'https://api.instagram.com/oauth/authorize';
const INSTAGRAM_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const GRAPH_API_URL = `https://graph.instagram.com/${INSTAGRAM_API_VERSION}`;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const POLL_MAX_ATTEMPTS = Number(process.env.POLL_MAX_ATTEMPTS || 60);
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'instagram-media';
const SESSION_COOKIE_NAME = 'instagram_mvp_session';

function sessionKey() {
  const secret = process.env.SESSION_SECRET || 'local-development-only-secret';
  return crypto.createHash('sha256').update(secret).digest();
}

function encodeSession(sessionData) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(sessionData), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted]
    .map((value) => value.toString('base64url'))
    .join('.');
}

function decodeSession(value) {
  try {
    const [iv, authTag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey(), iv);
    decipher.setAuthTag(authTag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
  } catch {
    return {};
  }
}

function setSessionCookie(response, sessionData, maxAge = 86400) {
  const cookie = [
    `${SESSION_COOKIE_NAME}=${encodeSession(sessionData)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(process.env.NODE_ENV === 'production' ? ['Secure'] : []),
  ].join('; ');
  response.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(response) {
  response.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
  );
}

function sessionMiddleware(request, response, next) {
  const cookies = request.headers.cookie || '';
  const sessionCookie = cookies
    .split(';')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
  request.sessionData = sessionCookie
    ? decodeSession(sessionCookie.slice(`${SESSION_COOKIE_NAME}=`.length))
    : {};
  next();
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

function instagramClientId() {
  return process.env.INSTAGRAM_CLIENT_ID || '37412665811681272';
}

function getPublicSupabaseConfig() {
  return {
    url: requiredEnvironment('SUPABASE_URL').replace(/\/$/, ''),
    anonKey: requiredEnvironment('SUPABASE_ANON_KEY'),
    bucket: STORAGE_BUCKET,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readApiResponse(response) {
  const rawBody = await response.text();
  let body;

  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    body = { raw: rawBody };
  }

  if (!response.ok) {
    const apiError = body.error || body;
    const error = new Error(
      apiError.message || `A API retornou HTTP ${response.status}.`,
    );
    error.status = response.status;
    error.apiResponse = body;
    throw error;
  }

  return body;
}

async function exchangeAuthorizationCode(code) {
  const form = new URLSearchParams({
    client_id: instagramClientId(),
    client_secret: requiredEnvironment('INSTAGRAM_CLIENT_SECRET'),
    grant_type: 'authorization_code',
    redirect_uri: requiredEnvironment('REDIRECT_URI'),
    code,
  });

  const response = await fetch(INSTAGRAM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });

  return readApiResponse(response);
}

function getVideoUrlPrefix() {
  const { url, bucket } = getPublicSupabaseConfig();
  return `${url}/storage/v1/object/public/${encodeURIComponent(bucket)}/`;
}

function isAllowedPublicVideoUrl(videoUrl) {
  try {
    const parsedUrl = new URL(videoUrl);
    return (
      parsedUrl.protocol === 'https:' &&
      videoUrl.startsWith(getVideoUrlPrefix())
    );
  } catch {
    return false;
  }
}

async function createVideoContainer(accessToken, videoUrl, caption) {
  const form = new URLSearchParams({
    media_type: 'REELS',
    video_url: videoUrl,
    caption,
  });

  const response = await fetch(`${GRAPH_API_URL}/me/media`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const result = await readApiResponse(response);
  if (!result.id) {
    throw new Error('A Meta não retornou o creation_id do contêiner de vídeo.');
  }

  return result.id;
}

async function getContainerStatus(accessToken, creationId) {
  const fields = encodeURIComponent('status_code');
  const response = await fetch(
    `${GRAPH_API_URL}/${encodeURIComponent(creationId)}?fields=${fields}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  return readApiResponse(response);
}

async function waitForVideoProcessing(accessToken, creationId, onStatus) {
  let previousStatus = null;

  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt += 1) {
    await sleep(POLL_INTERVAL_MS);
    const statusResult = await getContainerStatus(accessToken, creationId);
    const statusCode = statusResult.status_code || 'UNKNOWN';

    if (statusCode !== previousStatus) {
      console.log(
        `[Instagram] creation_id=${creationId} tentativa=${attempt} status=${statusCode}`,
      );
      previousStatus = statusCode;
    } else {
      console.log(
        `[Instagram] creation_id=${creationId} tentativa=${attempt} status=${statusCode} (sem mudança)`,
      );
    }

    onStatus?.({
      phase: 'processing',
      progress: Math.min(85, 15 + Math.round((attempt / POLL_MAX_ATTEMPTS) * 70)),
      attempt,
      maxAttempts: POLL_MAX_ATTEMPTS,
      statusCode,
      creationId,
      message: `Processando vídeo na Meta: ${statusCode} (verificação ${attempt}/${POLL_MAX_ATTEMPTS})`,
    });

    if (statusCode === 'FINISHED') return;
    if (['ERROR', 'EXPIRED'].includes(statusCode)) {
      throw new Error(
        `A Meta informou que o processamento do vídeo falhou: ${statusCode}.`,
      );
    }
  }

  throw new Error(
    `Tempo limite excedido aguardando o processamento do vídeo (${POLL_MAX_ATTEMPTS} tentativas).`,
  );
}

function sendProgress(response, event, data) {
  if (!response || response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function publishVideo(accessToken, creationId) {
  const form = new URLSearchParams({ creation_id: creationId });
  const response = await fetch(`${GRAPH_API_URL}/me/media_publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  return readApiResponse(response);
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(sessionMiddleware);

app.get('/api/config', (request, response) => {
  try {
    response.json(getPublicSupabaseConfig());
  } catch (error) {
    console.error('[Config] Erro:', error.message);
    response.status(500).json({ error: 'Configuração do Supabase indisponível.' });
  }
});

app.get('/api/login', (request, response) => {
  try {
    const state = crypto.randomBytes(24).toString('hex');
    setSessionCookie(response, { state });
    const params = new URLSearchParams({
      client_id: instagramClientId(),
      redirect_uri: requiredEnvironment('REDIRECT_URI'),
      response_type: 'code',
      state,
      scope: 'instagram_business_basic,instagram_business_content_publish',
    });
    response.redirect(`${INSTAGRAM_AUTHORIZE_URL}?${params}`);
  } catch (error) {
    response.status(500).send(error.message);
  }
});

app.get('/api/callback', async (request, response) => {
  const { code, error, error_description: errorDescription } = request.query;

  if (error) {
    console.error('[OAuth] Usuário/Meta recusou autorização:', error, errorDescription);
    return response.redirect(`/?authError=${encodeURIComponent(errorDescription || error)}`);
  }

  if (!code || typeof code !== 'string') {
    return response.redirect('/?authError=Código de autorização ausente.');
  }

  if (!request.sessionData.state || request.query.state !== request.sessionData.state) {
    return response.redirect('/?authError=Falha de segurança no login OAuth (state inválido).');
  }

  try {
    const tokenResult = await exchangeAuthorizationCode(code);
    setSessionCookie(response, {
      instagramAccessToken: tokenResult.access_token,
      instagramUserId: tokenResult.user_id || null,
    });
    console.log('[OAuth] Access token obtido e armazenado em cookie HttpOnly criptografado.');
    return response.redirect('/?authenticated=1');
  } catch (tokenError) {
    console.error('[OAuth] Falha ao trocar o código:', tokenError.apiResponse || tokenError.message);
    return response.redirect(`/?authError=${encodeURIComponent(tokenError.message)}`);
  }
});

app.get('/api/session', (request, response) => {
  response.json({
    authenticated: Boolean(request.sessionData.instagramAccessToken),
    instagramUserId: request.sessionData.instagramUserId || null,
  });
});

app.post('/api/logout', (request, response) => {
  clearSessionCookie(response);
  return response.json({ ok: true });
});

app.post('/api/publish', async (request, response) => {
  const accessToken = request.sessionData.instagramAccessToken;
  const { videoUrl, caption = '' } = request.body || {};
  const wantsStream = request.headers.accept?.includes('text/event-stream');

  if (wantsStream) {
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders?.();
  }

  const fail = (status, body) => {
    if (wantsStream) {
      sendProgress(response, 'error', body);
      return response.end();
    }
    return response.status(status).json(body);
  };

  if (!accessToken) {
    return fail(401, { error: 'Faça login com o Instagram antes de publicar.' });
  }
  if (typeof videoUrl !== 'string' || !isAllowedPublicVideoUrl(videoUrl)) {
    return fail(400, {
      error: 'videoUrl inválida. Use a URL pública HTTPS do bucket configurado no Supabase.',
    });
  }
  if (typeof caption !== 'string' || caption.length > 2200) {
    return fail(400, { error: 'A legenda deve ter no máximo 2.200 caracteres.' });
  }

  try {
    sendProgress(response, 'progress', {
      phase: 'container', progress: 5, message: 'Vídeo recebido. Criando contêiner na Meta...'
    });
    console.log(`[Instagram] Criando contêiner para vídeo ${videoUrl}`);
    const creationId = await createVideoContainer(accessToken, videoUrl, caption);
    console.log(`[Instagram] Contêiner criado: creation_id=${creationId}`);
    sendProgress(response, 'progress', {
      phase: 'processing', progress: 15, creationId,
      message: 'Contêiner criado. A Meta está baixando e processando o vídeo.'
    });

    await waitForVideoProcessing(accessToken, creationId, (status) => {
      sendProgress(response, 'progress', status);
    });
    console.log(`[Instagram] Vídeo processado. Publicando creation_id=${creationId}`);
    sendProgress(response, 'progress', {
      phase: 'publishing', progress: 90, statusCode: 'FINISHED',
      message: 'Processamento concluído. Publicando no Instagram...'
    });

    const publishResult = await publishVideo(accessToken, creationId);
    console.log(`[Instagram] Publicação concluída: media_id=${publishResult.id || 'não informado'}`);

    const result = { ok: true, mediaId: publishResult.id, creationId };
    if (wantsStream) {
      sendProgress(response, 'complete', { ...result, progress: 100, message: 'Publicado com sucesso!' });
      return response.end();
    }
    return response.json(result);
  } catch (error) {
    console.error('[Instagram] Falha na publicação:', error.apiResponse || error.message);
    return fail(error.status && error.status < 500 ? error.status : 502, {
      error: error.message || 'A publicação falhou na API do Instagram.',
      details: process.env.NODE_ENV === 'production' ? undefined : error.apiResponse,
    });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor disponível em http://localhost:${PORT}`);
    console.log(`Callback OAuth configurado como: ${process.env.REDIRECT_URI || '(não configurado)'}`);
  });
}

module.exports = app;
