export type NormalizedFollowerRow = {
  snapshot_date: string;
  followers_count: number;
  followers_gained: number;
  followers_lost: number;
  raw_payload: Record<string, unknown>;
};

type MetricBucket = { date?: unknown; value?: unknown };

export function numberValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
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

