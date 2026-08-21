import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

function encryptionKey() {
  const encodedKey = process.env.TOKEN_ENCRYPTION_KEY;

  if (!encodedKey) {
    throw new Error('TOKEN_ENCRYPTION_KEY não está configurada.');
  }

  const key = Buffer.from(encodedKey, 'base64');

  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY deve conter exatamente 32 bytes em Base64.');
  }

  return key;
}

export function encryptToken(token: string) {
  if (!token) throw new Error('Token vazio não pode ser criptografado.');

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv, tag, encrypted]
    .map((part) => typeof part === 'string' ? part : part.toString('base64url'))
    .join('.');
}

export function decryptToken(payload: string) {
  const [version, ivValue, tagValue, encryptedValue] = payload.split('.');

  if (version !== VERSION || !ivValue || !tagValue || !encryptedValue) {
    throw new Error('Token criptografado inválido.');
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    encryptionKey(),
    Buffer.from(ivValue, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Identificador determinístico e não reversível para comparar segredos sem
 * persistir ou registrar o valor original. O domínio evita reutilizar o mesmo
 * digest caso a chave de criptografia também proteja outros tipos de token.
 */
export function tokenFingerprint(token: string, domain: string) {
  const normalizedToken = token.trim();
  const normalizedDomain = domain.trim();
  if (!normalizedToken) throw new Error('Token vazio não pode gerar fingerprint.');
  if (!normalizedDomain) throw new Error('Domínio vazio não pode gerar fingerprint.');

  return createHmac('sha256', encryptionKey())
    .update(`${normalizedDomain}\0`, 'utf8')
    .update(normalizedToken, 'utf8')
    .digest('hex');
}
