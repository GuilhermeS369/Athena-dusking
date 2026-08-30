export type NormalizedFollowerRow = {
  snapshot_date: string;
  followers_count: number;
  followers_gained: number;
  followers_lost: number;
  raw_payload: Record<string, unknown>;
};

export type AnalyticsSourceClass = 'current' | 'daily' | 'posts';

const ALL_ANALYTICS_SOURCE_CLASSES: AnalyticsSourceClass[] = ['current', 'daily', 'posts'];

type MetricBucket = { date?: unknown; value?: unknown };

export function numberValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return 0;
}

// Converte a resposta de /v1/analytics/daily-metrics nas linhas de
// profile_analytics_daily_metrics. Vive aqui, sem dependência de banco ou de
// rede, para poder ser reaproveitada por scripts de reparo e coberta por teste.
export function normalizedDailyMetrics(
  payload: unknown,
  profile: { id: string; organization_id: string; provider: string },
  coverageStatus: 'complete' | 'partial',
) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const dailyData = (payload as { dailyData?: unknown }).dailyData;
  if (!Array.isArray(dailyData)) return [];
  const rows = new Map<string, Record<string, unknown>>();
  for (const raw of dailyData) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const date = typeof row.date === 'string' ? row.date.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const metrics = row.metrics && typeof row.metrics === 'object' && !Array.isArray(row.metrics) ? row.metrics as Record<string, unknown> : {};
    const likes = numberValue(metrics.likes);
    const comments = numberValue(metrics.comments);
    const shares = numberValue(metrics.shares);
    const saves = numberValue(metrics.saves);
    rows.set(date, {
      organization_id: profile.organization_id,
      profile_id: profile.id,
      provider: profile.provider,
      metric_date: date,
      posts: numberValue(row.postCount),
      impressions: numberValue(metrics.impressions),
      reach: numberValue(metrics.reach),
      views: numberValue(metrics.views),
      likes,
      comments,
      shares,
      saves,
      interactions: likes + comments + shares + saves,
      coverage_status: coverageStatus,
      source_payload: raw,
      normalized_at: new Date().toISOString(),
    });
  }
  return Array.from(rows.values());
}

// A Zernio agrega as métricas diárias de forma assíncrona: a nossa chamada é o
// gatilho da coleta dela no Instagram, e a resposta dessa mesma chamada traz o
// agregado anterior — vazio para uma conta ainda não agregada. Sem distinguir
// esse vazio de "conta sem nada publicado", o ciclo grava o vazio como sucesso
// e o perfil fica sem linha diária até o refresh seguinte.
export function shouldRetryDailyAggregation(input: {
  collectDaily: boolean;
  payloadReceived: boolean;
  dailyRowCount: number;
  expectsDailyMetrics: boolean;
}) {
  // Sem a classe `daily` no ciclo, ou sem resposta da Zernio (falha já tratada
  // como fonte parcial), não há o que reagendar aqui.
  if (!input.collectDaily || !input.payloadReceived) return false;
  // Veio dado: nada pendente.
  if (input.dailyRowCount > 0) return false;
  // Conta que não publicou nada na janela realmente não tem o que agregar;
  // repetir só queimaria tentativa.
  return input.expectsDailyMetrics;
}

export function normalizeAnalyticsSourceClasses(sourceClasses?: AnalyticsSourceClass[]) {
  const requested = sourceClasses?.length ? sourceClasses : ALL_ANALYTICS_SOURCE_CLASSES;
  return ALL_ANALYTICS_SOURCE_CLASSES.filter((sourceClass) => requested.includes(sourceClass));
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)) : [];
}

function dateValue(value: unknown) {
  const date = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function rowDate(row: Record<string, unknown>) {
  return dateValue(row.date ?? row.snapshotDate ?? row.snapshot_date ?? row.day ?? row.timestamp ?? row.createdAt);
}

function metricValues(payload: Record<string, unknown>, metricName: string) {
  const metrics = objectValue(payload.metrics);
  const metric = objectValue(metrics[metricName]);
  return arrayValue(metric.values) as MetricBucket[];
}

function metricTotal(payload: Record<string, unknown>, metricName: string) {
  const metrics = objectValue(payload.metrics);
  const metric = objectValue(metrics[metricName]);
  return numberValue(metric.total);
}

function rowsFromDocumentedMetricEnvelope(payload: Record<string, unknown>) {
  const counts = metricValues(payload, 'follower_count');
  if (counts.length === 0) return [];

  const gainedByDate = new Map(metricValues(payload, 'followers_gained').flatMap((bucket) => {
    const date = dateValue(bucket.date);
    return date ? [[date, numberValue(bucket.value)] as const] : [];
  }));
  const lostByDate = new Map(metricValues(payload, 'followers_lost').flatMap((bucket) => {
    const date = dateValue(bucket.date);
    return date ? [[date, numberValue(bucket.value)] as const] : [];
  }));

  return counts.flatMap((bucket) => {
    const date = dateValue(bucket.date);
    if (!date) return [];
    return [{
      snapshot_date: date,
      followers_count: numberValue(bucket.value),
      followers_gained: gainedByDate.get(date) ?? 0,
      followers_lost: lostByDate.get(date) ?? 0,
      raw_payload: { source: 'metrics.follower_count.values', bucket },
    } satisfies NormalizedFollowerRow];
  });
}

function rowsFromLegacyArrays(payload: Record<string, unknown>) {
  const candidates = [payload.followers, payload.history, payload.dailyData, payload.data].find(Array.isArray) ?? [];
  return arrayValue(candidates).flatMap((row) => {
    const date = rowDate(row);
    if (!date) return [];
    const followers = numberValue(row.followers_count ?? row.followersCount ?? row.follower_count ?? row.count ?? row.followers);
    return [{
      snapshot_date: date,
      followers_count: followers,
      followers_gained: numberValue(row.followers_gained ?? row.followersGained ?? row.gained),
      followers_lost: numberValue(row.followers_lost ?? row.followersLost ?? row.lost),
      raw_payload: row,
    } satisfies NormalizedFollowerRow];
  });
}

function rowFromTotalValueEnvelope(payload: Record<string, unknown>) {
  const total = metricTotal(payload, 'follower_count');
  if (total <= 0) return [];
  const dateRange = objectValue(payload.dateRange);
  const date = dateValue(dateRange.until ?? payload.until ?? payload.toDate);
  if (!date) return [];
  return [{
    snapshot_date: date,
    followers_count: total,
    followers_gained: metricTotal(payload, 'followers_gained'),
    followers_lost: metricTotal(payload, 'followers_lost'),
    raw_payload: { source: 'metrics.total_value', metrics: payload.metrics ?? null, dateRange },
  } satisfies NormalizedFollowerRow];
}

function dedupeSortedRows(rows: NormalizedFollowerRow[]) {
  const byDate = new Map<string, NormalizedFollowerRow>();
  for (const row of rows) byDate.set(row.snapshot_date, row);
  return Array.from(byDate.values()).sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
}

export function normalizeFollowerRows(payload: unknown) {
  const typed = objectValue(payload);
  return dedupeSortedRows([
    ...rowsFromDocumentedMetricEnvelope(typed),
    ...rowsFromLegacyArrays(typed),
    ...rowFromTotalValueEnvelope(typed),
  ]);
}

export function latestFollowerRow(rows: NormalizedFollowerRow[]) {
  return dedupeSortedRows(rows).at(-1) ?? null;
}

function firstPositiveNumber(values: unknown[]) {
  for (const value of values) {
    const number = numberValue(value);
    if (number > 0) return number;
  }
  return null;
}

function nestedCandidate(source: Record<string, unknown>, path: string[]) {
  let current: unknown = source;
  for (const key of path) current = objectValue(current)[key];
  return current;
}

export function currentFollowersFromAccount(account: unknown) {
  const typed = objectValue(account);
  const profileData = objectValue(typed.profileData);
  const extraData = objectValue(profileData.extraData);
  const metadata = objectValue(typed.metadata);
  const analytics = objectValue(typed.analytics);
  return firstPositiveNumber([
    typed.followersCount,
    typed.followerCount,
    typed.followers_count,
    typed.follower_count,
    typed.followers,
    profileData.followersCount,
    profileData.followerCount,
    profileData.followers_count,
    profileData.follower_count,
    extraData.followersCount,
    extraData.followerCount,
    metadata.followersCount,
    metadata.followerCount,
    analytics.followersCount,
    analytics.followerCount,
    nestedCandidate(typed, ['stats', 'followersCount']),
    nestedCandidate(typed, ['stats', 'followerCount']),
  ]);
}

export function currentFollowersFromFollowerStats(payload: unknown, accountId?: string | null) {
  const typed = objectValue(payload);
  const accounts = arrayValue(typed.accounts);
  const matchingAccount = accounts.find((account) => {
    if (!accountId) return false;
    return [account._id, account.id, account.accountId].some((value) => String(value ?? '') === accountId);
  }) ?? accounts[0];
  return currentFollowersFromAccount(matchingAccount);
}

