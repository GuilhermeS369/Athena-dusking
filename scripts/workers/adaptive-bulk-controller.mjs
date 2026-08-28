export function createAdaptiveBulkController(config = {}) {
  const minimumStep = Math.min(config.minimumStep ?? 25, config.initialStep ?? 50);
  const maximumStep = Math.max(config.maximumStep ?? 100, config.initialStep ?? 50);
  const fastThresholdMs = config.fastThresholdMs ?? 250;
  const slowThresholdMs = config.slowThresholdMs ?? 750;
  const fastPerItemThresholdMs = config.fastPerItemThresholdMs ?? 25;
  const maxStableDurationMs = config.maxStableDurationMs ?? 3000;
  const stableSlicesRequired = config.stableSlicesRequired ?? 5;
  const timeoutCooldownMs = config.timeoutCooldownMs ?? 120000;
  const idleCooldownMs = config.idleCooldownMs ?? 30000;
  const random = config.random ?? Math.random;
  let currentStep = Math.min(Math.max(config.initialStep ?? 50, minimumStep), maximumStep);
  let consecutiveFastSlices = 0;
  let nextHeavyWorkAt = 0;
  let lastDurationMs = null;
  let lastCooldownMs = 0;
  let lastReason = 'initial_50';
  let lastProcessedItems = 0;
  let lastDurationPerItemMs = null;

  function snapshot(now = Date.now()) {
    return {
      currentStep,
      minimumStep,
      maximumStep,
      consecutiveFastSlices,
      nextHeavyWorkAt: nextHeavyWorkAt > 0 ? new Date(nextHeavyWorkAt).toISOString() : null,
      waitingForCooldown: now < nextHeavyWorkAt,
      remainingCooldownMs: Math.max(nextHeavyWorkAt - now, 0),
      lastDurationMs,
      lastCooldownMs,
      lastReason,
      lastProcessedItems,
      lastDurationPerItemMs,
    };
  }

  function applyCooldown(durationMs, criticalDelay, now) {
    const normalCooldown = Math.min(Math.max(250, Math.round(durationMs * 2)), 5000);
    const criticalCooldown = 5000 + Math.round(random() * 10000);
    lastCooldownMs = criticalDelay ? criticalCooldown : normalCooldown;
    nextHeavyWorkAt = now + lastCooldownMs;
  }

  return {
    canRun(now = Date.now()) {
      return now >= nextHeavyWorkAt;
    },
    markCriticalDelay(now = Date.now()) {
      currentStep = minimumStep;
      consecutiveFastSlices = 0;
      lastReason = 'critical_publication_delay';
      applyCooldown(slowThresholdMs, true, now);
      return snapshot(now);
    },
    markIdle(now = Date.now()) {
      lastReason = 'no_compact_chunk';
      lastCooldownMs = idleCooldownMs;
      nextHeavyWorkAt = now + idleCooldownMs;
      return snapshot(now);
    },
    observe({ durationMs, ok, message = '', processedItems = 0, criticalDelay = false, now = Date.now() }) {
      lastDurationMs = Math.max(Math.round(durationMs || 0), 0);
      lastProcessedItems = Number(processedItems || 0);
      lastDurationPerItemMs = lastProcessedItems > 0
        ? Math.round((lastDurationMs / lastProcessedItems) * 100) / 100
        : null;
      const normalizedMessage = String(message).toLowerCase();
      const timeout = /statement timeout|canceling statement|pgrst00[23]|fetch failed|timed?\s*out|timeout/.test(normalizedMessage);

      if (!ok && timeout) {
        currentStep = minimumStep;
        consecutiveFastSlices = 0;
        lastReason = 'database_timeout';
        lastCooldownMs = timeoutCooldownMs;
        nextHeavyWorkAt = now + timeoutCooldownMs;
        return snapshot(now);
      }

      if (criticalDelay) {
        return this.markCriticalDelay(now);
      }

      const inefficientSlowSlice = lastDurationMs > slowThresholdMs
        && (lastDurationPerItemMs === null || lastDurationPerItemMs > fastPerItemThresholdMs * 1.5);
      const stableThroughput = lastDurationPerItemMs === null
        ? lastDurationMs < fastThresholdMs
        : lastDurationMs <= maxStableDurationMs && lastDurationPerItemMs <= fastPerItemThresholdMs;

      if (!ok || inefficientSlowSlice || lastDurationMs > maxStableDurationMs) {
        currentStep = minimumStep;
        consecutiveFastSlices = 0;
        lastReason = ok ? 'slow_database_slice' : 'database_slice_error';
      } else if (stableThroughput) {
        consecutiveFastSlices += 1;
        lastReason = 'stable_throughput_slice';
        if (consecutiveFastSlices >= stableSlicesRequired) {
          currentStep = currentStep <= minimumStep ? Math.min(50, maximumStep) : maximumStep;
          consecutiveFastSlices = 0;
          lastReason = currentStep === maximumStep ? 'stable_raise_to_maximum' : 'stable_raise_to_normal';
        }
      } else {
        consecutiveFastSlices = 0;
        lastReason = 'normal_database_slice';
      }

      applyCooldown(lastDurationMs, false, now);
      return snapshot(now);
    },
    snapshot,
  };
}
