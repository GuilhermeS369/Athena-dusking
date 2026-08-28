export type BulkHorizonChunk = {
  status: string;
  slotStart: string | number;
  slotCount: string | number;
  nextSlotIndex: string | number;
  scheduleBaseAt: string | null;
  retryExhaustedAt?: string | null;
};

export type BulkOperationalStatus = {
  status: string;
  eligibleChunks: number;
  nextHorizonRefreshAt: string | null;
};

function integer(value: string | number) {
  try {
    return BigInt(value);
  } catch {
    return BigInt(0);
  }
}

export function deriveBulkOperationalStatus(input: {
  planStatus: string;
  intervalMinutes: string | number;
  chunks: BulkHorizonChunk[];
  now?: Date;
  horizonHours?: number;
}): BulkOperationalStatus {
  if (input.planStatus !== 'generating') {
    return { status: input.planStatus, eligibleChunks: 0, nextHorizonRefreshAt: null };
  }

  const now = input.now ?? new Date();
  const horizonHours = input.horizonHours ?? 48;
  const intervalMs = Number(input.intervalMinutes) * 60_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { status: input.planStatus, eligibleChunks: 0, nextHorizonRefreshAt: null };
  }

  let eligibleChunks = 0;
  let incompleteQueuedChunks = 0;
  let nextRefreshMs = Number.POSITIVE_INFINITY;
  for (const chunk of input.chunks) {
    if (!['queued', 'processing', 'failed'].includes(chunk.status) || chunk.retryExhaustedAt) continue;
    const nextSlotIndex = integer(chunk.nextSlotIndex);
    const slotEnd = integer(chunk.slotStart) + integer(chunk.slotCount);
    if (nextSlotIndex >= slotEnd || !chunk.scheduleBaseAt) continue;
    if (chunk.status !== 'queued') {
      eligibleChunks += 1;
      continue;
    }
    incompleteQueuedChunks += 1;
    const scheduleBaseMs = Date.parse(chunk.scheduleBaseAt);
    const nextExecuteMs = scheduleBaseMs + Number(nextSlotIndex + BigInt(1)) * intervalMs;
    if (!Number.isFinite(nextExecuteMs)) continue;
    const refreshMs = nextExecuteMs - horizonHours * 60 * 60_000;
    if (refreshMs <= now.getTime()) eligibleChunks += 1;
    else nextRefreshMs = Math.min(nextRefreshMs, refreshMs);
  }

  if (eligibleChunks > 0 || incompleteQueuedChunks === 0) {
    return { status: input.planStatus, eligibleChunks, nextHorizonRefreshAt: null };
  }
  return {
    status: 'horizon_ready',
    eligibleChunks: 0,
    nextHorizonRefreshAt: Number.isFinite(nextRefreshMs) ? new Date(nextRefreshMs).toISOString() : null,
  };
}
