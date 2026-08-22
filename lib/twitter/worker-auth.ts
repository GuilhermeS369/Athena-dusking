import { timingSafeEqual } from 'node:crypto';

export function isTwitterWorkerAuthorized(request: Request) {
  const expected = process.env.TWITTER_WORKER_SECRET;
  const supplied = request.headers.get('x-twitter-worker-secret');
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected); const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}
