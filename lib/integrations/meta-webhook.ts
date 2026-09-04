import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Comparação de strings em tempo constante. Buffers de tamanhos diferentes
 * fazem `timingSafeEqual` lançar, então o tamanho é conferido antes — a
 * diferença de tamanho já vaza pelo próprio comprimento da resposta.
 */
function safeEquals(supplied: string, expected: string) {
  const left = Buffer.from(supplied, 'utf8');
  const right = Buffer.from(expected, 'utf8');

  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Handshake de verificação da Meta: o painel chama a URL de callback com
 * `hub.verify_token` e espera o `hub.challenge` de volta. O token combinado é
 * o valor de `META_WEBHOOK_VERIFY_TOKEN`, colado no campo "Verificar token".
 */
export function verifyMetaWebhookToken(
  token: string | null,
  expected = process.env.META_WEBHOOK_VERIFY_TOKEN,
) {
  if (!expected || !token) return false;

  return safeEquals(token, expected);
}

export type MetaWebhookSigner = {
  appId: string;
  secret: string;
};

/**
 * A Meta assina o corpo bruto com o app secret do aplicativo dono da
 * inscrição, no header `X-Hub-Signature-256`. Como cada organização registra o
 * próprio app em `meta_apps`, a assinatura é testada contra os candidatos
 * ativos até uma bater — o retorno diz qual app enviou o evento.
 */
export function findMetaWebhookSigner(
  raw: string,
  header: string | null,
  candidates: MetaWebhookSigner[],
): MetaWebhookSigner | null {
  if (!header || candidates.length === 0) return null;

  const parsed = /^sha256=([a-f0-9]{64})$/i.exec(header.trim());

  if (!parsed) return null;

  const supplied = Buffer.from(parsed[1], 'hex');

  for (const candidate of candidates) {
    if (!candidate.secret) continue;

    const expected = createHmac('sha256', candidate.secret).update(raw, 'utf8').digest();

    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
      return candidate;
    }
  }

  return null;
}

export type MetaSignedRequest = {
  signer: MetaWebhookSigner;
  userId: string;
  issuedAt: number | null;
};

/**
 * `signed_request` é o formato que a Meta usa nos callbacks de desautorização e
 * de exclusão de dados: `<assinatura>.<payload>`, ambos em base64url, com a
 * assinatura sendo o HMAC-SHA256 do payload cru pelo app secret. A verificação
 * roda contra o payload **como veio na string** — decodificar e reserializar o
 * JSON muda os bytes e invalida a assinatura.
 */
export function parseMetaSignedRequest(
  signedRequest: string | null,
  candidates: MetaWebhookSigner[],
): MetaSignedRequest | null {
  if (!signedRequest) return null;

  const [encodedSignature, encodedPayload] = signedRequest.split('.');

  if (!encodedSignature || !encodedPayload) return null;

  let supplied: Buffer;

  try {
    supplied = Buffer.from(encodedSignature, 'base64url');
  } catch {
    return null;
  }

  const signer = candidates.find((candidate) => {
    if (!candidate.secret) return false;

    const expected = createHmac('sha256', candidate.secret).update(encodedPayload, 'utf8').digest();

    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });

  if (!signer) return null;

  let payload: Record<string, unknown>;

  try {
    const decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as unknown;

    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;

    payload = decoded as Record<string, unknown>;
  } catch {
    return null;
  }

  const userId = typeof payload.user_id === 'string' && payload.user_id.trim()
    ? payload.user_id.trim()
    : null;

  if (!userId) return null;

  return {
    signer,
    userId,
    issuedAt: typeof payload.issued_at === 'number' ? payload.issued_at : null,
  };
}

/**
 * Código que o usuário usa para acompanhar o pedido de exclusão. É derivado do
 * app secret e do identificador da conta, então o mesmo pedido sempre devolve o
 * mesmo código e o suporte consegue recalculá-lo sem guardar nada.
 */
export function dataDeletionConfirmationCode(signer: MetaWebhookSigner, userId: string) {
  return createHmac('sha256', signer.secret)
    .update(`data-deletion:${userId}`, 'utf8')
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
}

export type MetaWebhookSummary = {
  object: string | null;
  entries: number;
  fields: string[];
};

/**
 * Resumo do payload para log. O corpo do evento pode trazer conteúdo de
 * usuário (texto de comentário, por exemplo), então só o formato é registrado —
 * nunca o payload inteiro.
 */
export function summarizeMetaWebhook(raw: string): MetaWebhookSummary | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const body = parsed as Record<string, unknown>;
  const entries = Array.isArray(body.entry) ? body.entry : [];
  const fields = new Set<string>();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;

    const changes = (entry as Record<string, unknown>).changes;

    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      if (!change || typeof change !== 'object' || Array.isArray(change)) continue;

      const field = (change as Record<string, unknown>).field;

      if (typeof field === 'string') fields.add(field);
    }
  }

  return {
    object: typeof body.object === 'string' ? body.object : null,
    entries: entries.length,
    fields: [...fields].sort(),
  };
}
