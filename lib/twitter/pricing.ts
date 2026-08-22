export const TWITTER_INITIAL_GRANT_MICROS = 12_000_000;
export const TWITTER_ANALYTICS_FLOOR_MICROS = 5_000_000;

export const TWITTER_RATE_MICROS = {
  postRead: 5_000,
  userReadFollowArticle: 10_000,
  postOrDmCreate: 15_000,
  postCreateWithUrl: 200_000,
} as const;

export type TwitterPriceCategory =
  | 'post_read'
  | 'user_read_follow_article'
  | 'post_dm_create'
  | 'post_create_url';

const URL_PATTERN = /https?:\/\/[^\s]+/giu;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

function countPlainTextUnits(value: string) {
  const segmenter = new Intl.Segmenter('pt-BR', { granularity: 'grapheme' });
  let units = 0;

  for (const { segment } of segmenter.segment(value)) {
    units += EMOJI_PATTERN.test(segment) ? 2 : Array.from(segment).length;
  }

  return units;
}

export function countTwitterWeightedCharacters(content: string) {
  let total = 0;
  let cursor = 0;

  for (const match of content.matchAll(URL_PATTERN)) {
    const index = match.index ?? cursor;
    total += countPlainTextUnits(content.slice(cursor, index));
    total += 23;
    cursor = index + match[0].length;
  }

  return total + countPlainTextUnits(content.slice(cursor));
}

export function containsHttpUrl(content: string) {
  URL_PATTERN.lastIndex = 0;
  return URL_PATTERN.test(content);
}

export function getTwitterCreatePrice(content: string): {
  category: TwitterPriceCategory;
  amountMicros: number;
} {
  return containsHttpUrl(content)
    ? { category: 'post_create_url', amountMicros: TWITTER_RATE_MICROS.postCreateWithUrl }
    : { category: 'post_dm_create', amountMicros: TWITTER_RATE_MICROS.postOrDmCreate };
}

export function getTwitterCharacterLimit(capability: 'free' | 'premium' | 'unknown') {
  return capability === 'premium' ? 25_000 : 280;
}

export function validateTwitterContent(content: string, capability: 'free' | 'premium' | 'unknown') {
  const weightedCharacters = countTwitterWeightedCharacters(content);
  const limit = getTwitterCharacterLimit(capability);
  return {
    weightedCharacters,
    limit,
    valid: content.trim().length > 0 && weightedCharacters <= limit,
  };
}

export function assertMicros(value: number, field = 'value') {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} precisa ser um inteiro seguro não negativo em micros.`);
  }
  return value;
}

export function formatUsdMicros(value: number) {
  assertMicros(value);
  return `US$ ${(value / 1_000_000).toFixed(3).replace('.', ',')}`;
}
