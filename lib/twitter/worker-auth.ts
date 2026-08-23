import { timingSafeEqual } from 'node:crypto';

export type TwitterWorkerRole = 'publication' | 'sync' | 'analytics' | 'reconcile';

const secretNameByRole: Record<TwitterWorkerRole, string> = {
  publication: 'TWITTER_PUBLICATION_WORKER_SECRET',
  sync: 'TWITTER_SYNC_WORKER_SECRET',
  analytics: 'TWITTER_ANALYTICS_WORKER_SECRET',
  reconcile: 'TWITTER_RECONCILE_WORKER_SECRET',
};

const roleByWorkerName: Record<string, TwitterWorkerRole> = {
  'athena-twitter-publication-worker': 'publication',
  'athena-twitter-zernio-sync-worker': 'sync',
  'athena-twitter-analytics-worker': 'analytics',
  'athena-twitter-webhook-reconcile-worker': 'reconcile',
};

function safeEqual(left: string, right: string) {
  const expected = Buffer.from(left);
  const supplied = Buffer.from(right);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function roleForInternalPath(request: Request): TwitterWorkerRole | null {
  const path = new URL(request.url).pathname;
  if (path.includes('/twitter-publication-')) return 'publication';
  if (path.includes('/twitter-sync-')) return 'sync';
  if (path.includes('/twitter-analytics-')) return 'analytics';
  if (path.endsWith('/twitter-reconcile')) return 'reconcile';
  return null;
}

export function isTwitterWorkerAuthorized(request: Request, role?: TwitterWorkerRole) {
  const resolvedRole = role ?? roleForInternalPath(request);
  if (!resolvedRole) return false;
  const expected = process.env[secretNameByRole[resolvedRole]];
  const supplied = request.headers.get('x-twitter-worker-secret');
  if (!expected || !supplied) return false;
  return safeEqual(expected, supplied);
}

export function isTwitterNamedWorkerAuthorized(request: Request, workerName: string) {
  const role = roleByWorkerName[workerName];
  return role ? isTwitterWorkerAuthorized(request, role) : false;
}
