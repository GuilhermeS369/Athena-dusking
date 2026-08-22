import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function twitterReviewDigest(value: unknown) { return createHash('sha256').update(stable(value)).digest('hex'); }

function secret() {
  const value = process.env.TWITTER_REVIEW_TOKEN_SECRET;
  if (!value || value.length < 32) throw new Error('TWITTER_REVIEW_TOKEN_SECRET não está configurado com segurança.');
  return value;
}

export function signTwitterReviewToken(payload: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyTwitterReviewToken(token: string) {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) throw new Error('Token de revisão inválido.');
  const expected = createHmac('sha256', secret()).update(encoded).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error('Token de revisão inválido.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
  if (typeof payload.expiresAt !== 'number' || payload.expiresAt < Date.now()) throw new Error('A revisão expirou. Revise novamente.');
  return payload;
}
