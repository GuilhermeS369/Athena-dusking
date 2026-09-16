export const BULK_ROTATION_ALGORITHM_VERSION = 2 as const;
export const LEGACY_BULK_ROTATION_ALGORITHM_VERSION = 1 as const;
// Piso de 29 minutos entre publicações de um mesmo lote (modo intervalo).
// Protege os perfis (postar mais rápido derruba conta) e, desde a migration 328,
// é também o único freio de tamanho do plano — o horizonte móvel de 48h, que
// antes limitava a materialização, deixou de existir. Espelhado no banco pela
// constraint bulk_publication_plans_minimum_interval_check.
export const MIN_BULK_INTERVAL_MINUTES = 29;
export const MIN_BULK_DURATION_DAYS = BigInt(1);
// Teto de 7 dias por plano. Com o horizonte de 48h removido na migration 328, a
// duração passou a definir sozinha quanto é materializado de uma vez. Espelhado
// no banco pelo gatilho bulk_publication_plans_enforce_duration_cap (329).
export const MAX_BULK_DURATION_DAYS = 7;
// Esquema SEQUENCIAL (decisão do dono em 16/09/2026): o operador escolhe o
// intervalo e a quantidade de postagens por perfil, e opcionalmente o horário
// inicial. Ignora TODA limitação de minutos entre postagens do mesmo perfil — o
// piso de 29 minutos acima, o pulo de 10 minutos entre lotes da geração e o
// intervalo mínimo por formato da reserva de despacho (45 s; reel 1.500 s). O
// que continua valendo: rotação, dispersão de 10 minutos a partir do início,
// teto de 7 dias e o limite de 100 publicações por perfil em 24 horas, que é da
// própria Meta (acima dele o post é recusado e vence por atraso).
export const MIN_SEQUENTIAL_INTERVAL_MINUTES = 1;
export const MAX_PROFILE_PUBLICATIONS_PER_24H = 100;
// Janela de dispersão padrão dos planos (bulk_publication_plans.spread_window_seconds, migration 331).
export const BULK_SPREAD_WINDOW_SECONDS = 600;
const SAO_PAULO_TIME_ZONE = 'America/Sao_Paulo';

export type BulkRotationAlgorithmVersion = typeof LEGACY_BULK_ROTATION_ALGORITHM_VERSION | typeof BULK_ROTATION_ALGORITHM_VERSION;
export type BulkRotationOrderMode = 'same_order' | 'diversified';
export type BulkRotationFormat = 'image' | 'reel' | 'story';
export type BulkRotationScheduleMode = 'interval' | 'daily_time' | 'sequential';
export type BulkRotationInteger = bigint | number | string;

export type CompactBulkRotationPlan = {
  version: BulkRotationAlgorithmVersion;
  format: BulkRotationFormat;
  intervalMinutes: number;
  durationDays: bigint;
  slotsPerProfile: bigint;
  orderMode: BulkRotationOrderMode;
  rotationSeed: string;
  profileCount: bigint;
  mediaCount: bigint;
  expectedPublications: bigint;
};

export type ProfileScheduleBaseInput = {
  now: Date | string;
  lastActiveExecuteAt?: Date | string | null;
  lastReservedExecuteAt?: Date | string | null;
};

export type RotationResumeInput = {
  now: Date | string;
  intervalMinutes: number;
  originalBaseAt: Date | string;
  totalSlotCount: BulkRotationInteger;
  nextPendingSlotIndex: BulkRotationInteger;
  lastCompetingActiveExecuteAt?: Date | string | null;
  lastCompetingReservedExecuteAt?: Date | string | null;
};

export type RotationResumePlan = {
  resumedBaseAt: string;
  ignoredSlotCount: bigint;
  ignoredFromSlotIndex: bigint | null;
  ignoredThroughSlotIndex: bigint | null;
  nextPreservedSlotIndex: bigint;
  remainingSlotCount: bigint;
  firstResumedExecuteAt: string | null;
  lastResumedExecuteAt: string | null;
};

const MINUTE_MS = 60_000;
const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const MINUTES_PER_DAY = BigInt(1_440);
const MAX_DATE_MS = 8_640_000_000_000_000;

function requireDate(value: Date | string, field: string) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`${field} precisa ser uma data válida.`);
  return date;
}

function optionalDate(value: Date | string | null | undefined, field: string) {
  return value === null || value === undefined ? null : requireDate(value, field);
}

function requirePositiveSafeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} precisa ser um inteiro positivo seguro.`);
  }
  return value;
}

function requireNonNegativeBigInt(value: BulkRotationInteger, field: string) {
  let parsed: bigint;
  try {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError();
    if (typeof value === 'string' && !/^\d+$/.test(value)) throw new RangeError();
    parsed = BigInt(value);
  } catch {
    throw new RangeError(`${field} precisa ser um inteiro válido.`);
  }
  if (parsed < BIGINT_ZERO) throw new RangeError(`${field} não pode ser negativo.`);
  return parsed;
}

function requirePositiveBigInt(value: BulkRotationInteger, field: string) {
  const parsed = requireNonNegativeBigInt(value, field);
  if (parsed < BIGINT_ONE) throw new RangeError(`${field} precisa ser maior que zero.`);
  return parsed;
}

function millisecondsForIntervals(intervalMinutes: number, intervalCount: bigint) {
  const interval = requirePositiveSafeInteger(intervalMinutes, 'intervalMinutes');
  const milliseconds = BigInt(interval) * BigInt(MINUTE_MS) * intervalCount;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('O deslocamento solicitado excede a precisão segura de datas do runtime.');
  }
  return Number(milliseconds);
}

function addIntervals(base: Date, intervalMinutes: number, intervalCount: bigint) {
  const timestamp = base.getTime() + millisecondsForIntervals(intervalMinutes, intervalCount);
  if (!Number.isSafeInteger(timestamp) || Math.abs(timestamp) > MAX_DATE_MS) {
    throw new RangeError('O agendamento solicitado excede o intervalo de datas suportado.');
  }
  return new Date(timestamp);
}

function stableSeedOffset(seed: string, modulo: number) {
  if (modulo <= 1) return 0;
  let hash = 2_166_136_261;
  for (const character of seed.normalize('NFC')) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % modulo;
}

function greatestCommonDivisor(left: number, right: number) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function coprimeSteps(mediaCount: number) {
  const result: number[] = [];
  for (let candidate = 1; candidate < mediaCount; candidate += 1) {
    if (greatestCommonDivisor(candidate, mediaCount) === 1) result.push(candidate);
  }
  return result.length > 0 ? result : [1];
}

export function bulkRotationSlotCount(durationDays: BulkRotationInteger, intervalMinutes: number) {
  const days = requirePositiveBigInt(durationDays, 'durationDays');
  const interval = requirePositiveSafeInteger(intervalMinutes, 'intervalMinutes');
  return (days * MINUTES_PER_DAY) / BigInt(interval);
}

export function bulkRotationExpectedPublications(profileCount: BulkRotationInteger, slotsPerProfile: BulkRotationInteger) {
  const profiles = requireNonNegativeBigInt(profileCount, 'profileCount');
  const slots = requireNonNegativeBigInt(slotsPerProfile, 'slotsPerProfile');
  return profiles * slots;
}

export function isBulkRotationDailyTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function bulkRotationDailySlotCount(repeatDays: BulkRotationInteger) {
  return requirePositiveBigInt(repeatDays, 'repeatDays');
}

/**
 * Maior número de postagens de UM perfil que cabem em qualquer janela de 24 h
 * numa sequência. A reserva de despacho conta `published_at >= agora - 24 h`
 * (inclusivo), por isso o `+ 1`: com intervalo de 15 min cabem 97, não 96.
 */
export function bulkSequentialPostsInAnyDay(intervalMinutes: number, postCount: BulkRotationInteger) {
  const interval = requirePositiveSafeInteger(intervalMinutes, 'intervalMinutes');
  const count = requirePositiveBigInt(postCount, 'postCount');
  const perDay = BigInt(Math.floor(1440 / interval) + 1);
  return count < perDay ? count : perDay;
}

/** Dias corridos (arredondados para cima) que a sequência ocupa; nunca menos que 1. */
export function bulkSequentialDurationDays(intervalMinutes: number, postCount: BulkRotationInteger) {
  const interval = requirePositiveSafeInteger(intervalMinutes, 'intervalMinutes');
  const count = requirePositiveBigInt(postCount, 'postCount');
  const totalMinutes = count * BigInt(interval);
  const days = (totalMinutes + MINUTES_PER_DAY - BIGINT_ONE) / MINUTES_PER_DAY;
  return days < BIGINT_ONE ? BIGINT_ONE : days;
}

function saoPauloWallClockMs(instantMs: number) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SAO_PAULO_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instantMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
}

/**
 * Converte o valor de um `<input type="datetime-local">` ("2026-09-16T21:00")
 * lido como horário de SÃO PAULO — não o fuso do navegador — para ISO em UTC.
 * Devolve null para texto que não seja uma data e hora reais.
 */
export function saoPauloLocalDateTimeToIso(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wanted);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
    || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) return null;
  let instant = wanted - (saoPauloWallClockMs(wanted) - wanted);
  instant -= saoPauloWallClockMs(instant) - wanted;
  if (saoPauloWallClockMs(instant) !== wanted) return null;
  return new Date(instant).toISOString();
}

/** Inverso de saoPauloLocalDateTimeToIso, para preencher o campo a partir de um instante. */
export function isoToSaoPauloLocalDateTime(value: Date | string) {
  const instant = requireDate(value, 'value').getTime();
  return new Date(saoPauloWallClockMs(instant)).toISOString().slice(0, 16);
}

export function makeCompactBulkRotationPlan(input: {
  format: BulkRotationFormat;
  intervalMinutes: number;
  durationDays: BulkRotationInteger;
  orderMode: BulkRotationOrderMode;
  rotationSeed: string;
  profileCount: BulkRotationInteger;
  mediaCount: BulkRotationInteger;
}): CompactBulkRotationPlan {
  const intervalMinutes = requirePositiveSafeInteger(input.intervalMinutes, 'intervalMinutes');
  const durationDays = requirePositiveBigInt(input.durationDays, 'durationDays');
  const profileCount = requirePositiveBigInt(input.profileCount, 'profileCount');
  const mediaCount = requirePositiveBigInt(input.mediaCount, 'mediaCount');
  const rotationSeed = input.rotationSeed.trim();
  if (!rotationSeed) throw new RangeError('rotationSeed não pode ficar vazia.');
  if (!['image', 'reel', 'story'].includes(input.format)) throw new RangeError('format não é suportado pela rotação em massa.');
  if (!['same_order', 'diversified'].includes(input.orderMode)) throw new RangeError('orderMode é inválido.');
  const slotsPerProfile = bulkRotationSlotCount(durationDays, intervalMinutes);
  if (slotsPerProfile < BIGINT_ONE) throw new RangeError('A duração e o intervalo informados não produzem nenhum slot.');

  return {
    version: BULK_ROTATION_ALGORITHM_VERSION,
    format: input.format,
    intervalMinutes,
    durationDays,
    slotsPerProfile,
    orderMode: input.orderMode,
    rotationSeed,
    profileCount,
    mediaCount,
    expectedPublications: bulkRotationExpectedPublications(profileCount, slotsPerProfile),
  };
}

export function resolveProfileScheduleBase(input: ProfileScheduleBaseInput) {
  const candidates = [
    requireDate(input.now, 'now'),
    optionalDate(input.lastActiveExecuteAt, 'lastActiveExecuteAt'),
    optionalDate(input.lastReservedExecuteAt, 'lastReservedExecuteAt'),
  ].filter((date): date is Date => Boolean(date));
  return new Date(Math.max(...candidates.map((date) => date.getTime()))).toISOString();
}

export function bulkRotationExecuteAt(baseAt: Date | string, intervalMinutes: number, slotIndex: BulkRotationInteger) {
  const base = requireDate(baseAt, 'baseAt');
  const index = requireNonNegativeBigInt(slotIndex, 'slotIndex');
  return addIntervals(base, intervalMinutes, index + BIGINT_ONE).toISOString();
}

export function bulkRotationLastExecuteAt(baseAt: Date | string, intervalMinutes: number, slotCount: BulkRotationInteger) {
  const count = requireNonNegativeBigInt(slotCount, 'slotCount');
  if (count === BIGINT_ZERO) return null;
  return bulkRotationExecuteAt(baseAt, intervalMinutes, count - BIGINT_ONE);
}

export function bulkRotationProfileOffset(input: {
  orderMode: BulkRotationOrderMode;
  profileOrdinal: BulkRotationInteger;
  mediaCount: number;
  rotationSeed: string;
  algorithmVersion?: BulkRotationAlgorithmVersion;
}) {
  const mediaCount = requirePositiveSafeInteger(input.mediaCount, 'mediaCount');
  const profileOrdinal = requireNonNegativeBigInt(input.profileOrdinal, 'profileOrdinal');
  if (input.orderMode === 'same_order') return 0;
  if (input.orderMode !== 'diversified') throw new RangeError('orderMode é inválido.');
  const algorithmVersion = input.algorithmVersion ?? BULK_ROTATION_ALGORITHM_VERSION;
  if (algorithmVersion === LEGACY_BULK_ROTATION_ALGORITHM_VERSION) {
    const seedOffset = stableSeedOffset(input.rotationSeed, mediaCount);
    return (seedOffset + Number(profileOrdinal % BigInt(mediaCount))) % mediaCount;
  }
  if (algorithmVersion !== BULK_ROTATION_ALGORITHM_VERSION) throw new RangeError('algorithmVersion não é suportada.');
  const seedOffset = stableSeedOffset(input.rotationSeed, mediaCount);
  return (seedOffset + Number(profileOrdinal % BigInt(mediaCount))) % mediaCount;
}

export function bulkRotationProfileStep(input: {
  orderMode: BulkRotationOrderMode;
  profileOrdinal: BulkRotationInteger;
  mediaCount: number;
  rotationSeed: string;
  algorithmVersion?: BulkRotationAlgorithmVersion;
}) {
  const mediaCount = requirePositiveSafeInteger(input.mediaCount, 'mediaCount');
  const profileOrdinal = requireNonNegativeBigInt(input.profileOrdinal, 'profileOrdinal');
  const algorithmVersion = input.algorithmVersion ?? BULK_ROTATION_ALGORITHM_VERSION;
  if (input.orderMode === 'same_order' || algorithmVersion === LEGACY_BULK_ROTATION_ALGORITHM_VERSION || mediaCount === 1) return 1;
  if (input.orderMode !== 'diversified') throw new RangeError('orderMode é inválido.');
  if (algorithmVersion !== BULK_ROTATION_ALGORITHM_VERSION) throw new RangeError('algorithmVersion não é suportada.');
  const candidates = coprimeSteps(mediaCount);
  const seedStepOffset = stableSeedOffset(`${input.rotationSeed}:step`, candidates.length);
  return candidates[(seedStepOffset + Number(profileOrdinal % BigInt(candidates.length))) % candidates.length];
}

export function bulkRotationMediaIndex(input: {
  slotIndex: BulkRotationInteger;
  profileOffset?: number;
  profileStep?: number;
  mediaCount: number;
}) {
  const mediaCount = requirePositiveSafeInteger(input.mediaCount, 'mediaCount');
  const slotIndex = requireNonNegativeBigInt(input.slotIndex, 'slotIndex');
  const profileOffset = input.profileOffset ?? 0;
  if (!Number.isSafeInteger(profileOffset) || profileOffset < 0 || profileOffset >= mediaCount) {
    throw new RangeError('profileOffset precisa apontar para uma mídia existente.');
  }
  const profileStep = input.profileStep ?? 1;
  if (!Number.isSafeInteger(profileStep) || profileStep < 1 || profileStep > mediaCount || greatestCommonDivisor(profileStep, mediaCount) !== 1) {
    throw new RangeError('profileStep precisa ser positivo e coprimo com mediaCount.');
  }
  return (Number(slotIndex % BigInt(mediaCount)) * profileStep + profileOffset) % mediaCount;
}

export function buildRotationResumePlan(input: RotationResumeInput): RotationResumePlan {
  const now = requireDate(input.now, 'now');
  const originalBase = requireDate(input.originalBaseAt, 'originalBaseAt');
  const totalSlotCount = requireNonNegativeBigInt(input.totalSlotCount, 'totalSlotCount');
  const nextPendingSlotIndex = requireNonNegativeBigInt(input.nextPendingSlotIndex, 'nextPendingSlotIndex');
  if (nextPendingSlotIndex > totalSlotCount) {
    throw new RangeError('nextPendingSlotIndex não pode ultrapassar totalSlotCount.');
  }
  const intervalMinutes = requirePositiveSafeInteger(input.intervalMinutes, 'intervalMinutes');
  const intervalMs = intervalMinutes * MINUTE_MS;
  const elapsedMs = now.getTime() - originalBase.getTime();
  const elapsedIntervals = elapsedMs < intervalMs ? BIGINT_ZERO : BigInt(Math.floor(elapsedMs / intervalMs));
  const firstFutureSlotIndex = elapsedIntervals > totalSlotCount ? totalSlotCount : elapsedIntervals;
  const nextPreservedSlotIndex = firstFutureSlotIndex > nextPendingSlotIndex
    ? firstFutureSlotIndex
    : nextPendingSlotIndex;
  const ignoredSlotCount = nextPreservedSlotIndex - nextPendingSlotIndex;
  const remainingSlotCount = totalSlotCount - nextPreservedSlotIndex;
  const resumedBaseAt = resolveProfileScheduleBase({
    now,
    lastActiveExecuteAt: input.lastCompetingActiveExecuteAt,
    lastReservedExecuteAt: input.lastCompetingReservedExecuteAt,
  });

  return {
    resumedBaseAt,
    ignoredSlotCount,
    ignoredFromSlotIndex: ignoredSlotCount > BIGINT_ZERO ? nextPendingSlotIndex : null,
    ignoredThroughSlotIndex: ignoredSlotCount > BIGINT_ZERO ? nextPreservedSlotIndex - BIGINT_ONE : null,
    nextPreservedSlotIndex,
    remainingSlotCount,
    firstResumedExecuteAt: remainingSlotCount > BIGINT_ZERO
      ? bulkRotationExecuteAt(resumedBaseAt, intervalMinutes, BIGINT_ZERO)
      : null,
    lastResumedExecuteAt: bulkRotationLastExecuteAt(resumedBaseAt, intervalMinutes, remainingSlotCount),
  };
}

export function resumedBulkRotationExecuteAt(
  resumePlan: RotationResumePlan,
  intervalMinutes: number,
  resumedOrdinal: BulkRotationInteger,
) {
  const ordinal = requireNonNegativeBigInt(resumedOrdinal, 'resumedOrdinal');
  if (ordinal >= resumePlan.remainingSlotCount) {
    throw new RangeError('resumedOrdinal não pertence aos slots restantes.');
  }
  return bulkRotationExecuteAt(resumePlan.resumedBaseAt, intervalMinutes, ordinal);
}

export function resumedBulkRotationOriginalSlotIndex(resumePlan: RotationResumePlan, resumedOrdinal: BulkRotationInteger) {
  const ordinal = requireNonNegativeBigInt(resumedOrdinal, 'resumedOrdinal');
  if (ordinal >= resumePlan.remainingSlotCount) {
    throw new RangeError('resumedOrdinal não pertence aos slots restantes.');
  }
  return resumePlan.nextPreservedSlotIndex + ordinal;
}
