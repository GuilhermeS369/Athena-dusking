import fs from 'node:fs';

const inputPath = process.argv[2] ?? '.vercel-analytics-dispatch-24h-2026-08-21.jsonl';
const outputPath = process.argv[3] ?? '.vercel-analytics-dispatch-summary-2026-08-21.json';

const lines = fs
  .readFileSync(inputPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean);

const jobs = new Map();
const workers = new Map();
const globalStatuses = {};
let malformedLines = 0;
let duplicateLines = 0;
let dispatcherCycles = 0;
let cyclesWithItems = 0;
let cyclesWithoutItems = 0;
let claimedCount = 0;
let minimumTimestamp = Number.POSITIVE_INFINITY;
let maximumTimestamp = Number.NEGATIVE_INFINITY;
const seenRecords = new Set();

function increment(target, key, amount = 1) {
  target[key] = (target[key] ?? 0) + amount;
}

for (const line of lines) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    malformedLines += 1;
    continue;
  }

  const message = String(record.message ?? '');
  if (!message.startsWith('Dispatcher de analytics concluído.')) continue;

  // A exportação da Vercel pode repetir o mesmo evento (mesmo id/timestamp)
  // várias vezes. Sem deduplicação, jobs e perfis ficam supercontados.
  const recordKey = String(record.id ?? `${record.timestamp}|${message}`);
  if (seenRecords.has(recordKey)) {
    duplicateLines += 1;
    continue;
  }
  seenRecords.add(recordKey);

  dispatcherCycles += 1;
  const timestamp = Number(record.timestamp);
  if (Number.isFinite(timestamp)) {
    minimumTimestamp = Math.min(minimumTimestamp, timestamp);
    maximumTimestamp = Math.max(maximumTimestamp, timestamp);
  }

  const workerId = message.match(/workerId:\s*'([^']+)'/)?.[1] ?? 'unknown';
  const concurrency = Number(message.match(/concurrency:\s*(\d+)/)?.[1] ?? 0);
  const cycleClaimedCount = Number(message.match(/claimedCount:\s*(\d+)/)?.[1] ?? 0);
  const hasMore = message.match(/hasMore:\s*(true|false)/)?.[1] === 'true';
  claimedCount += cycleClaimedCount;

  const worker = workers.get(workerId) ?? {
    workerId,
    cycles: 0,
    claimedCount: 0,
    concurrencyValues: new Set(),
    firstSeenAt: Number.POSITIVE_INFINITY,
    lastSeenAt: Number.NEGATIVE_INFINITY,
  };
  worker.cycles += 1;
  worker.claimedCount += cycleClaimedCount;
  if (concurrency > 0) worker.concurrencyValues.add(concurrency);
  if (Number.isFinite(timestamp)) {
    worker.firstSeenAt = Math.min(worker.firstSeenAt, timestamp);
    worker.lastSeenAt = Math.max(worker.lastSeenAt, timestamp);
  }
  workers.set(workerId, worker);

  const itemPattern = /{\s*jobId:\s*'([^']+)',\s*profileId:\s*'([^']+)',\s*processed:\s*(\d+),\s*status:\s*'([^']+)'\s*}/g;
  const cycleJobIds = new Set();
  let cycleItems = 0;
  for (const match of message.matchAll(itemPattern)) {
    const [, jobId, profileId, processedValue, status] = match;
    const processed = Number(processedValue);
    cycleItems += processed;
    cycleJobIds.add(jobId);
    increment(globalStatuses, status, processed);

    const job = jobs.get(jobId) ?? {
      jobId,
      cycleTimestamps: [],
      processed: 0,
      statuses: {},
      profileIds: new Set(),
      workers: new Set(),
      concurrencyValues: new Set(),
      terminalCycleObserved: false,
    };
    job.processed += processed;
    increment(job.statuses, status, processed);
    job.profileIds.add(profileId);
    job.workers.add(workerId);
    if (concurrency > 0) job.concurrencyValues.add(concurrency);
    if (!hasMore) job.terminalCycleObserved = true;
    jobs.set(jobId, job);
  }

  for (const jobId of cycleJobIds) {
    const job = jobs.get(jobId);
    if (Number.isFinite(timestamp)) job.cycleTimestamps.push(timestamp);
  }

  if (cycleItems > 0) cyclesWithItems += 1;
  else cyclesWithoutItems += 1;
}

function iso(timestamp) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

const summarizedJobs = [...jobs.values()]
  .map((job) => {
    const sortedTimestamps = [...job.cycleTimestamps].sort((a, b) => a - b);
    const firstTimestamp = sortedTimestamps[0];
    const lastTimestamp = sortedTimestamps.at(-1);
    const observedDurationMs = Math.max(0, (lastTimestamp ?? 0) - (firstTimestamp ?? 0));
    return {
      jobId: job.jobId,
      cycles: sortedTimestamps.length,
      firstCycleAt: iso(firstTimestamp),
      lastCycleAt: iso(lastTimestamp),
      observedDurationMs,
      observedDurationSeconds: Math.round(observedDurationMs / 1000),
      processed: job.processed,
      uniqueProfiles: job.profileIds.size,
      statuses: job.statuses,
      successRate:
        job.processed > 0
          ? Number((((job.statuses.synced ?? 0) / job.processed) * 100).toFixed(2))
          : null,
      observedProfilesPerMinute:
        observedDurationMs > 0
          ? Number(((job.processed / observedDurationMs) * 60_000).toFixed(2))
          : null,
      workers: [...job.workers],
      concurrencyValues: [...job.concurrencyValues].sort((a, b) => a - b),
      terminalCycleObserved: job.terminalCycleObserved,
      completeWithinLogWindow:
        job.terminalCycleObserved && sortedTimestamps.length > 1,
    };
  })
  .sort((a, b) => b.processed - a.processed || b.cycles - a.cycles);

const report = {
  generatedAt: new Date().toISOString(),
  inputPath,
  source: {
    lines: lines.length,
    malformedLines,
    duplicateLines,
    uniqueDispatcherEvents: seenRecords.size,
    firstLogAt: iso(minimumTimestamp),
    lastLogAt: iso(maximumTimestamp),
    windowSeconds:
      Number.isFinite(minimumTimestamp) && Number.isFinite(maximumTimestamp)
        ? Math.round((maximumTimestamp - minimumTimestamp) / 1000)
        : null,
  },
  totals: {
    dispatcherCycles,
    cyclesWithItems,
    cyclesWithoutItems,
    claimedCount,
    parsedProcessedItems: Object.values(globalStatuses).reduce(
      (sum, value) => sum + value,
      0,
    ),
    statuses: globalStatuses,
    jobs: summarizedJobs.length,
    completeJobsWithinLogWindow: summarizedJobs.filter(
      (job) => job.completeWithinLogWindow,
    ).length,
  },
  workers: [...workers.values()]
    .map((worker) => ({
      workerId: worker.workerId,
      cycles: worker.cycles,
      claimedCount: worker.claimedCount,
      concurrencyValues: [...worker.concurrencyValues].sort((a, b) => a - b),
      firstSeenAt: iso(worker.firstSeenAt),
      lastSeenAt: iso(worker.lastSeenAt),
    }))
    .sort((a, b) => b.claimedCount - a.claimedCount),
  jobs: summarizedJobs,
};

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
