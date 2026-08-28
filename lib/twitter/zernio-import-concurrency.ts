export function twitterZernioImportConcurrency(value = process.env.TWITTER_ZERNIO_IMPORT_CONCURRENCY) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 8) : 4;
}

export async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
) {
  if (items.length === 0) return;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  let nextIndex = 0;

  async function consume() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => consume()));
}
