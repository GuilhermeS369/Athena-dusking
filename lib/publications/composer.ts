export type ComposerFormat = 'image' | 'reel' | 'story' | 'carousel';
/** Uma postagem com data fixa ou uma sequência distribuída nos horários recorrentes. */
export type ScheduleMode = 'one_time' | 'recurring';
export type CaptionMode = 'shared' | 'per_post';
export const MAX_PUBLICATION_CAPTION_LENGTH = 2200;
export const MIN_RECURRING_REPEAT_DAYS = 1;
export const MAX_RECURRING_REPEAT_DAYS = 365;
export const MIN_SEQUENCE_REPEAT_COUNT = 1;
export const MAX_SEQUENCE_REPEAT_COUNT = 1_000;
export type ScheduledSlotsByFormat = Record<ComposerFormat, string[]>;
export type ScheduledCountsByFormat = Record<ComposerFormat, Record<string, number>>;

export type ComposerMedia = { id: string; kind: 'image' | 'video' };

export type PublicationFormatCounts = Record<ComposerFormat, number> & { total: number };
export type ProfilePublicationMetrics = {
  scheduled: PublicationFormatCounts;
  published: PublicationFormatCounts;
};

type PublicationMetricItem = {
  profile_id: string;
  format: ComposerFormat;
  status: string;
  execute_at?: string | null;
};

const publicationFormats: ComposerFormat[] = ['reel', 'story', 'image', 'carousel'];

export function emptyScheduledSlotsByFormat(): ScheduledSlotsByFormat {
  return { reel: [], story: [], image: [], carousel: [] };
}

export function emptyScheduledCountsByFormat(): ScheduledCountsByFormat {
  return { reel: {}, story: {}, image: {}, carousel: {} };
}

export function emptyPublicationFormatCounts(): PublicationFormatCounts {
  return { reel: 0, story: 0, image: 0, carousel: 0, total: 0 };
}

export function emptyProfilePublicationMetrics(): ProfilePublicationMetrics {
  return { scheduled: emptyPublicationFormatCounts(), published: emptyPublicationFormatCounts() };
}

/** Agrega indicadores de publicação com a mesma regra para todas as telas. */
export function aggregateProfilePublicationMetrics(items: PublicationMetricItem[], now = new Date()) {
  const metricsByProfileId = new Map<string, ProfilePublicationMetrics>();
  for (const item of items) {
    if (!publicationFormats.includes(item.format)) continue;
    const metrics = metricsByProfileId.get(item.profile_id) ?? emptyProfilePublicationMetrics();
    const isScheduled = ['waiting', 'ready', 'preparing', 'publishing'].includes(item.status)
      && (!item.execute_at || new Date(item.execute_at).getTime() > now.getTime());
    const target = item.status === 'published' ? metrics.published : isScheduled ? metrics.scheduled : null;
    if (!target) continue;
    target[item.format] += 1;
    target.total += 1;
    metricsByProfileId.set(item.profile_id, metrics);
  }
  return metricsByProfileId;
}

export type ProfilePublicationPlan = {
  profileId: string;
  format: ComposerFormat;
  mediaIds: string[];
  captions: string[];
  captionMode: CaptionMode;
  scheduleMode: ScheduleMode;
  executeAt: string | null;
  executeAtByMedia: Record<string, string | null>;
  dailyTimes: string[];
  repeatEnabled: boolean;
  repeatDays: number;
  repeatExecuteAts: string[];
  /** Datas literais do modo de distribuição Repetir, alinhadas a `mediaIds`. */
  sequenceExecuteAts?: string[];
};

export type BulkDistributionMode = 'sequential' | 'random' | 'repeat';

export const ORGANIZATION_TIME_ZONE = 'America/Sao_Paulo';
export const DEFAULT_POSTING_TIMES = ['07:00', '12:00', '18:00', '20:00'];
export const DEFAULT_EXTENDED_POSTING_TIMES = ['07:30', '09:30', '11:00', '12:30', '14:00', '15:30', '17:00', '18:30', '20:30', '22:30'];
export const POSTING_TIME_SLOTS = Array.from({ length: 24 * 6 }, (_, index) => {
  const hour = Math.floor(index / 6);
  const minute = (index % 6) * 10;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
});
const saoPauloFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ORGANIZATION_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

type SaoPauloParts = { year: number; month: number; day: number; hour: number; minute: number };

function saoPauloParts(date: Date): SaoPauloParts {
  const parts = saoPauloFormatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute') };
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

export function isTime(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return Boolean(match && Number(match[1]) <= 23 && Number(match[2]) <= 59);
}

export function isPostingTimeSlot(value: string) {
  return isTime(value) && POSTING_TIME_SLOTS.includes(value);
}

function saoPauloInstant(year: number, month: number, day: number, hour: number, minute: number) {
  // São Paulo uses UTC-03:00. Keeping this explicit prevents the runtime timezone
  // (browser, Vercel, or worker) from changing the intended local publication time.
  return new Date(Date.UTC(year, month - 1, day, hour + 3, minute, 0, 0));
}

export function parseSaoPauloDateTimeInput(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const date = saoPauloInstant(year, month, day, hour, minute);
  const parts = saoPauloParts(date);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59
    || parts.year !== year || parts.month !== month || parts.day !== day || parts.hour !== hour || parts.minute !== minute) return null;
  return date.toISOString();
}

export function parseSaoPauloDateAndTime(dateValue: string, timeValue: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) || !isTime(timeValue)) return null;
  return parseSaoPauloDateTimeInput(`${dateValue}T${timeValue}`);
}

export function formatSaoPauloDateTimeInput(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  const parts = saoPauloParts(date);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function formatSaoPauloTime(value: string | null | undefined) {
  return formatSaoPauloDateTimeInput(value).slice(-5);
}

/**
 * Normaliza um instante reservado para o horário-base de dez minutos exibido
 * pelo compositor. Ex.: 12:07 pertence à opção 12:00.
 * A reserva real continua no minuto original; isto serve somente à leitura.
 */
export function postingTimeWindow(value: string | null | undefined) {
  const time = formatSaoPauloTime(value);
  if (!isTime(time)) return null;
  const [hour, minute] = time.split(':').map(Number);
  return `${pad(hour)}:${pad(Math.floor(minute / 10) * 10)}`;
}

function recurringSlotKey(value: string | null | undefined) {
  const input = formatSaoPauloDateTimeInput(value);
  const window = postingTimeWindow(value);
  return input && window ? `${input.slice(0, 10)}T${window}` : null;
}

export function formatSaoPauloDateTime(value: string | null | undefined) {
  if (!value) return 'Publicação imediata';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return 'Horário inválido';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: ORGANIZATION_TIME_ZONE,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

export function normalizeDailyTimes(times: string[]) {
  return [...new Set(times.filter(isPostingTimeSlot))].sort();
}

export function normalizeRecurringRepeatDays(value: unknown) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : MIN_RECURRING_REPEAT_DAYS;
  if (!Number.isFinite(parsed)) return MIN_RECURRING_REPEAT_DAYS;
  return Math.min(MAX_RECURRING_REPEAT_DAYS, Math.max(MIN_RECURRING_REPEAT_DAYS, Math.trunc(parsed)));
}

/** Normaliza quantas vezes uma sequência completa de mídias será repetida. */
export function normalizeSequenceRepeatCount(value: unknown) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : MIN_SEQUENCE_REPEAT_COUNT;
  if (!Number.isFinite(parsed)) return MIN_SEQUENCE_REPEAT_COUNT;
  return Math.min(MAX_SEQUENCE_REPEAT_COUNT, Math.max(MIN_SEQUENCE_REPEAT_COUNT, Math.trunc(parsed)));
}

export function recurringPublicationSlotCount(times: string[], repeatDays: unknown) {
  return normalizeDailyTimes(times).length * normalizeRecurringRepeatDays(repeatDays);
}

export function distributeMediaBetweenProfiles<T>(media: T[], profileIds: string[], mode: BulkDistributionMode, random = Math.random) {
  const result = new Map<string, T[]>();
  profileIds.forEach((profileId) => result.set(profileId, []));
  if (!profileIds.length) return result;

  if (mode === 'repeat') {
    profileIds.forEach((profileId) => result.set(profileId, [...media]));
    return result;
  }

  const ordered = [...media];
  if (mode === 'random') {
    for (let index = ordered.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [ordered[index], ordered[swapIndex]] = [ordered[swapIndex], ordered[index]];
    }
  }

  ordered.forEach((mediaItem, index) => result.get(profileIds[index % profileIds.length])?.push(mediaItem));
  return result;
}

export function mediaIsCompatible(format: ComposerFormat, kind: ComposerMedia['kind']) {
  if (format === 'image') return kind === 'image';
  if (format === 'reel') return kind === 'video';
  return true;
}

export function validateMediaForFormat(format: ComposerFormat, media: ComposerMedia[]) {
  if (!media.length) return 'Adicione pelo menos uma mídia.';
  if (format === 'carousel' && (media.length < 2 || media.length > 10)) return 'Carrossel exige de 2 a 10 mídias.';
  if (format !== 'carousel' && media.length !== 1) return 'Imagem, Reel e Story usam exatamente uma mídia por publicação.';
  if (media.some((item) => !mediaIsCompatible(format, item.kind))) {
    return format === 'image' ? 'Imagem aceita somente arquivos de imagem.' : format === 'reel' ? 'Reel aceita somente arquivos de vídeo.' : 'Mídia incompatível com o formato selecionado.';
  }
  return null;
}

export function captionForIndex(captions: string[], index: number, mode: CaptionMode = 'per_post') {
  const usable = captions.map((caption) => caption.trim()).filter(Boolean);
  if (!usable.length) return null;
  return mode === 'shared' ? usable[0] : usable[index % usable.length];
}

/**
 * No modo compartilhado, quebras de linha pertencem à própria legenda e nunca
 * devem criar uma segunda legenda. No modo por postagem, cada linha continua
 * representando uma legenda independente.
 */
export function captionsFromInput(value: string, mode: CaptionMode) {
  return mode === 'shared' ? [value] : value.split('\n');
}

export function captionExceedsMaximumLength(value: string | null | undefined) {
  return Boolean(value && value.length > MAX_PUBLICATION_CAPTION_LENGTH);
}

export function buildAutomaticSchedule(count: number, now = new Date(), times = DEFAULT_POSTING_TIMES) {
  return buildDailySchedule(count, now, times);
}

export function buildDailySchedule(count: number, now = new Date(), times: string[]) {
  return buildRecurringSchedule(count, now, times);
}

/**
 * Resolve os próximos slots em ordem cronológica. Horários ocupados — inclusive
 * os já escolhidos para outra mídia do mesmo plano — são pulados para o próximo
 * dia disponível. O limite evita uma busca infinita em uma agenda impossível.
 */
export function buildRecurringSchedule(
  count: number,
  now: Date,
  times: string[],
  occupied: Iterable<string> = [],
  maxDays = 365,
) {
  const result: string[] = [];
  const dailyTimes = normalizeDailyTimes(times);
  if (!dailyTimes.length || count <= 0) return result;

  const reserved = new Set(
    [...occupied]
      .map(recurringSlotKey)
      .filter((key): key is string => Boolean(key)),
  );
  const base = saoPauloParts(now);
  const startOfTodayUtc = Date.UTC(base.year, base.month - 1, base.day);
  let dayOffset = 0;
  while (result.length < count && dayOffset <= maxDays) {
    const calendar = new Date(startOfTodayUtc + dayOffset * 86_400_000);
    for (const time of dailyTimes) {
      const [hour, minute] = time.split(':').map(Number);
      const candidate = saoPauloInstant(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate(), hour, minute);
      const iso = candidate.toISOString();
      const key = recurringSlotKey(iso);
      if (candidate <= now || !key || reserved.has(key)) continue;
      result.push(iso);
      reserved.add(key);
      if (result.length === count) break;
    }
    dayOffset += 1;
  }
  return result;
}

export function buildRepeatedPublicationSchedule<T>(
  mediaItems: T[],
  now: Date,
  times: string[],
  repeatDays: unknown,
  occupied: Iterable<string> = [],
) {
  if (!mediaItems.length) return [] as Array<{ media: T; executeAt: string }>;
  const schedule = buildRecurringSchedule(
    recurringPublicationSlotCount(times, repeatDays),
    now,
    times,
    occupied,
    MAX_RECURRING_REPEAT_DAYS,
  );
  return schedule.map((executeAt, index) => ({ media: mediaItems[index % mediaItems.length], executeAt }));
}

/**
 * Repete uma sequência inteira sem depender de dias ou horários. Cada ciclo
 * preserva a ordem original, inclusive quando os valores se repetem.
 */
export function repeatMediaSequence<T>(mediaItems: T[], repeatCount: unknown) {
  const cycles = normalizeSequenceRepeatCount(repeatCount);
  return Array.from({ length: cycles }, () => mediaItems).flat();
}

export type ExactSequenceProjection<T> = {
  media: T[];
  executeAts: string[];
  firstExecuteAt: string | null;
  lastExecuteAt: string | null;
};

/** Cria uma única projeção imutável para exibição e envio da sequência exata. */
export function projectExactDailySequence<T>(input: {
  media: T[];
  repeatCount: unknown;
  now: Date;
  time: string;
  occupied?: Iterable<string>;
}) : ExactSequenceProjection<T> {
  const media = repeatMediaSequence(input.media, input.repeatCount);
  const executeAts = buildExactDailySchedule(media.length, input.now, input.time, input.occupied);
  return {
    media,
    executeAts,
    firstExecuteAt: executeAts[0] ?? null,
    lastExecuteAt: executeAts.at(-1) ?? null,
  };
}

/**
 * Gera instantes literais no mesmo horário local de São Paulo, um por dia.
 * Diferentemente da recorrência tradicional, não há janela de 10 minutos nem
 * sorteio: "09:00" resulta sempre exatamente em 09:00:00.
 */
export function buildExactDailySchedule(
  count: number,
  now: Date,
  time: string,
  occupied: Iterable<string> = [],
  maxDays = 60_000,
) {
  if (!Number.isSafeInteger(count) || count <= 0 || !isPostingTimeSlot(time)) return [];
  const occupiedMinutes = new Set(
    [...occupied]
      .map((value) => formatSaoPauloDateTimeInput(value))
      .filter(Boolean),
  );
  const result: string[] = [];
  const base = saoPauloParts(now);
  const startOfTodayUtc = Date.UTC(base.year, base.month - 1, base.day);
  const [hour, minute] = time.split(':').map(Number);
  let dayOffset = 0;

  while (result.length < count && dayOffset <= maxDays) {
    const calendar = new Date(startOfTodayUtc + dayOffset * 86_400_000);
    const candidate = saoPauloInstant(
      calendar.getUTCFullYear(),
      calendar.getUTCMonth() + 1,
      calendar.getUTCDate(),
      hour,
      minute,
    );
    const iso = candidate.toISOString();
    const candidateMinute = formatSaoPauloDateTimeInput(iso);
    if (candidate > now && !occupiedMinutes.has(candidateMinute)) {
      result.push(iso);
      occupiedMinutes.add(candidateMinute);
    }
    dayOffset += 1;
  }
  return result;
}

export function nextUnusedPostingTime(times: string[]) {
  const used = new Set(normalizeDailyTimes(times));
  // Um novo horário deve entrar no fim do dia para não deslocar a sequência
  // que a pessoa já configurou. Como os horários são normalizados em ordem
  // crescente, ele também será exibido como o último item, à direita.
  return [...POSTING_TIME_SLOTS].reverse().find((time) => !used.has(time)) ?? null;
}

/**
 * Produz datas futuras para um único horário diário, ignorando slots já reservados.
 * `occupied` deve conter instantes ISO em UTC para o perfil em questão.
 */
export function buildNextAvailableSlotSchedule(count: number, time: string, occupied: Iterable<string>, now = new Date()) {
  if (!isPostingTimeSlot(time) || count <= 0) return [];
  const reserved = new Set(
    [...occupied]
      .map(recurringSlotKey)
      .filter((key): key is string => Boolean(key)),
  );
  const result: string[] = [];
  const base = saoPauloParts(now);
  const startOfTodayUtc = Date.UTC(base.year, base.month - 1, base.day);
  const [hour, minute] = time.split(':').map(Number);
  let dayOffset = 0;

  while (result.length < count) {
    const calendar = new Date(startOfTodayUtc + dayOffset * 86_400_000);
    const candidate = saoPauloInstant(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate(), hour, minute);
    const iso = candidate.toISOString();
    const key = recurringSlotKey(iso);
    if (candidate > now && key && !reserved.has(key)) {
      result.push(iso);
      reserved.add(key);
    }
    dayOffset += 1;
  }
  return result;
}
