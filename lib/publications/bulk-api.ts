import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { MAX_BULK_DURATION_DAYS, MIN_BULK_INTERVAL_MINUTES } from './bulk-rotation.ts';
import type { BulkRotationFormat, BulkRotationOrderMode, BulkRotationScheduleMode } from './bulk-rotation';

export type BulkMediaOrigin = { type: 'group'; groupId: string } | { type: 'ungrouped'; groupId: null };

export type BulkReelCover = {
  enabled: true;
  origin: BulkMediaOrigin;
  mediaAssetId: string;
} | {
  enabled: false;
};

export type BulkRotationRequest = {
  name: string;
  profileIds: string[];
  origin: BulkMediaOrigin;
  format: BulkRotationFormat;
  scheduleMode: BulkRotationScheduleMode;
  intervalMinutes: number;
  durationDays: string;
  dailyTime: string | null;
  caption: string | null;
  orderMode: BulkRotationOrderMode;
  rotationSeed: string;
  reelCover: BulkReelCover;
};

export type BulkReviewTokenPayload = {
  organizationId: string;
  fingerprint: string;
  expiresAt: number;
};

export type BulkDatabaseError = {
  code?: string | null;
  message?: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAILY_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function reviewSecret() {
  const secret = process.env.BULK_REVIEW_SECRET ?? process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('BULK_REVIEW_SECRET ou SESSION_SECRET precisa ter ao menos 32 caracteres.');
  return secret;
}

export function parseBulkRotationRequest(value: unknown): BulkRotationRequest {
  if (!value || typeof value !== 'object') throw new RangeError('Corpo da requisição inválido.');
  const input = value as Record<string, unknown>;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const profileIds = Array.isArray(input.profileIds) ? [...new Set(input.profileIds)] : [];
  const originInput = input.origin && typeof input.origin === 'object' ? input.origin as Record<string, unknown> : {};
  const format = input.format;
  const scheduleMode = input.scheduleMode ?? 'interval';
  const intervalMinutes = input.intervalMinutes;
  const durationDays = typeof input.durationDays === 'number' ? String(input.durationDays) : input.durationDays;
  const dailyTime = input.dailyTime === undefined || input.dailyTime === null ? null : input.dailyTime;
  const caption = input.caption === null || input.caption === undefined || input.caption === '' ? null : input.caption;
  const orderMode = input.orderMode;
  const rotationSeed = typeof input.rotationSeed === 'string' ? input.rotationSeed.trim() : '';
  const coverInput = input.reelCover && typeof input.reelCover === 'object'
    ? input.reelCover as Record<string, unknown>
    : { enabled: false };

  if (!name || name.length > 160) throw new RangeError('Nome do lote deve ter entre 1 e 160 caracteres.');
  if (!profileIds.length || !profileIds.every((id) => typeof id === 'string' && UUID_PATTERN.test(id))) throw new RangeError('Perfis inválidos.');
  if (!['image', 'reel', 'story'].includes(String(format))) throw new RangeError('Formato inválido.');
  if (!['interval', 'daily_time'].includes(String(scheduleMode))) throw new RangeError('Esquema de horário inválido.');
  if (scheduleMode === 'interval' && !Number.isSafeInteger(intervalMinutes)) throw new RangeError('Intervalo inválido.');
  if (scheduleMode === 'interval' && Number(intervalMinutes) < MIN_BULK_INTERVAL_MINUTES) {
    throw new RangeError(`O intervalo mínimo entre publicações é de ${MIN_BULK_INTERVAL_MINUTES} minutos.`);
  }
  if (typeof durationDays !== 'string' || !/^[1-9]\d*$/.test(durationDays)) throw new RangeError('Duração inválida.');
  if (Number(durationDays) > MAX_BULK_DURATION_DAYS) {
    throw new RangeError(`A duração máxima de uma programação em massa é de ${MAX_BULK_DURATION_DAYS} dias.`);
  }
  if (scheduleMode === 'daily_time' && (typeof dailyTime !== 'string' || !DAILY_TIME_PATTERN.test(dailyTime))) throw new RangeError('Horário diário inválido.');
  if (caption !== null && (typeof caption !== 'string' || caption.length > 2200)) throw new RangeError('Legenda inválida.');
  if (!['same_order', 'diversified'].includes(String(orderMode))) throw new RangeError('Modo de ordem inválido.');
  if (!rotationSeed || rotationSeed.length > 240) throw new RangeError('Semente de rotação inválida.');

  const type = originInput.type;
  const groupId = originInput.groupId;
  if (type !== 'group' && type !== 'ungrouped') throw new RangeError('Origem inválida.');
  if (type === 'group' && (typeof groupId !== 'string' || !UUID_PATTERN.test(groupId))) throw new RangeError('Grupo de origem inválido.');
  if (type === 'ungrouped' && groupId !== null && groupId !== undefined) throw new RangeError('Origem sem grupo inválida.');

  const coverEnabled = coverInput.enabled === true;
  let reelCover: BulkReelCover = { enabled: false };
  if (coverEnabled) {
    if (format !== 'reel') throw new RangeError('Capa personalizada só pode ser usada em Reel.');
    const coverOrigin = coverInput.origin && typeof coverInput.origin === 'object'
      ? coverInput.origin as Record<string, unknown>
      : {};
    const coverOriginType = coverOrigin.type;
    const coverGroupId = coverOrigin.groupId;
    const mediaAssetId = coverInput.mediaAssetId;
    if (coverOriginType !== 'group' && coverOriginType !== 'ungrouped') throw new RangeError('Origem da capa inválida.');
    if (coverOriginType === 'group' && (typeof coverGroupId !== 'string' || !UUID_PATTERN.test(coverGroupId))) throw new RangeError('Grupo de capas inválido.');
    if (coverOriginType === 'ungrouped' && coverGroupId !== null && coverGroupId !== undefined) throw new RangeError('Origem de capas sem grupo inválida.');
    if (typeof mediaAssetId !== 'string' || !UUID_PATTERN.test(mediaAssetId)) throw new RangeError('Imagem de capa inválida.');
    reelCover = {
      enabled: true,
      origin: coverOriginType === 'group'
        ? { type: 'group', groupId: coverGroupId as string }
        : { type: 'ungrouped', groupId: null },
      mediaAssetId,
    };
  } else if (coverInput.enabled !== false && input.reelCover !== undefined) {
    throw new RangeError('Configuração de capa inválida.');
  }

  return {
    name,
    profileIds: profileIds as string[],
    origin: type === 'group' ? { type, groupId: groupId as string } : { type, groupId: null },
    format: format as BulkRotationFormat,
    scheduleMode: scheduleMode as BulkRotationScheduleMode,
    intervalMinutes: scheduleMode === 'interval' ? Number(intervalMinutes) : 1440,
    durationDays,
    dailyTime: scheduleMode === 'daily_time' ? dailyTime as string : null,
    caption: caption as string | null,
    orderMode: orderMode as BulkRotationOrderMode,
    rotationSeed,
    reelCover,
  };
}

export function bulkRotationFingerprint(request: BulkRotationRequest) {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

export function createBulkReviewToken(payload: BulkReviewTokenPayload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', reviewSecret()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyBulkReviewToken(token: string, organizationId: string, request: BulkRotationRequest, now = Date.now()) {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return false;
  const expected = createHmac('sha256', reviewSecret()).update(encoded).digest();
  const received = Buffer.from(signature, 'base64url');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as BulkReviewTokenPayload;
    return payload.organizationId === organizationId
      && payload.fingerprint === bulkRotationFingerprint(request)
      && Number.isSafeInteger(payload.expiresAt)
      && payload.expiresAt >= now;
  } catch {
    return false;
  }
}

export function encodeBulkMediaCursor(value: { createdAt: string; id: string }) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeBulkMediaCursor(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt)) || typeof parsed.id !== 'string' || !UUID_PATTERN.test(parsed.id)) return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export function hasBulkManageRole(role: string | undefined) {
  return role === 'admin' || role === 'operator';
}

export function parseBulkIdempotencyKey(value: unknown) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (key.length < 16 || key.length > 240) throw new RangeError('Chave de idempotência inválida.');
  return key;
}

export function bulkDatabaseErrorResponse(error: BulkDatabaseError) {
  const message = error.message?.trim() || 'Não foi possível processar a programação em massa.';
  if (error.code === '42501') return { status: 403, message };
  if (error.code === '23505') return { status: 409, message };
  if (error.code === 'P0001' || error.code === '23514' || error.code?.startsWith('22')) return { status: 400, message };
  return { status: 500, message: 'Não foi possível processar a programação em massa.' };
}
