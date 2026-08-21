import { randomUUID } from 'node:crypto';

import { syncProfileAnalytics } from '@/lib/integrations/zernio-analytics';
import { refreshZernioConnectionBilling } from '@/lib/integrations/zernio-client';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

type ClaimedAnalyticsJob = {
  job_id: string;
  organization_id: string;
  total_count: number;
  processed_count: number;
};

type AnalyticsJobRow = {
  id: string;
  organization_id: string;
  status: string;
  total_count: number;
  processed_count: number;
};

type AnalyticsJobItem = {
  job_id: string;
  organization_id: string;
  profile_id: string;
  zernio_connection_id: string | null;
  attempts: number;
  max_attempts: number;
  lease_until: string;
};

type AnalyticsItemOutcome = 'synced' | 'partial' | 'no_data' | 'skipped' | 'error';

type AnalyticsErrorClassification = {
  errorClass: 'timeout' | 'rate_limit' | 'unavailable' | 'authentication' | 'account_missing' | 'invalid_data' | 'unknown';
  code: string;
  message: string;
  retryable: boolean;
};

type AnalyticsStep =
  | 'worker_cycle'
  | 'connection_billing'
  | 'profile_lookup'
  | 'sync_run_create'
  | 'zernio_account_insights'
  | 'zernio_accounts'
  | 'zernio_follower_history'
  | 'zernio_post_analytics'
  | 'zernio_current_posts'
  | 'zernio_daily_metrics'
  | 'snapshot_persist'
  | 'daily_metrics_persist'
  | 'follower_history_persist'
  | 'post_analytics_persist'
  | 'item_complete';

type AnalyticsStepTelemetry = {
  step: AnalyticsStep;
  outcome: 'success' | 'partial' | 'error' | 'skipped';
  durationMs: number;
  errorClass?: string;
  errorCode?: string;
};

type ConnectionState = {
  active: number;
  cooldownUntil: number;
  consecutiveIncidents: number;
  billing?: Promise<AnalyticsStepTelemetry>;
};

export type ProfileAnalyticsRefreshDispatchOptions = {
  workerId?: string;
  limit?: number;
  concurrency?: number;
  leaseSeconds?: number;
};

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'Falha desconhecida no worker de analytics.';
}

function errorCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') return String(code);
  }
  return 'analytics_refresh_failed';
}

function classifyAnalyticsError(error: unknown): AnalyticsErrorClassification {
  const code = errorCode(error);
  const message = errorMessage(error);
  const searchable = `${code} ${message} ${error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name ?? '') : ''}`.toLowerCase();
  const explicitRetryable = error && typeof error === 'object' && 'retryable' in error
    ? (error as { retryable?: unknown }).retryable === true
    : false;

  if (searchable.includes('timeout') || searchable.includes('timed out') || searchable.includes('aborterror') || searchable.includes('econnreset') || searchable.includes('fetch failed')) {
    return { errorClass: 'timeout', code, message, retryable: true };
  }
  if (code === '429' || searchable.includes('rate limit') || searchable.includes('too many requests')) {
    return { errorClass: 'rate_limit', code, message, retryable: true };
  }
  if (/^5\d\d$/.test(code) || explicitRetryable || searchable.includes('temporarily unavailable') || searchable.includes('service unavailable')) {
    return { errorClass: 'unavailable', code, message, retryable: true };
  }
  if (code === '401' || code === '403' || searchable.includes('unauthorized') || searchable.includes('forbidden') || searchable.includes('permission')) {
    return { errorClass: 'authentication', code, message, retryable: false };
  }
  if (code === '404' || searchable.includes('account not found') || searchable.includes('perfil não encontrado') || searchable.includes('social account')) {
    return { errorClass: 'account_missing', code, message, retryable: false };
  }
  if (code === '400' || code === '422' || searchable.includes('invalid') || searchable.includes('malformed')) {
    return { errorClass: 'invalid_data', code, message, retryable: false };
  }
  return { errorClass: 'unknown', code, message, retryable: false };
}

async function refreshJob(jobId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('refresh_profile_analytics_refresh_job_status', { p_job_id: jobId });
  if (error) throw error;
  return data as AnalyticsJobRow | null;
}

async function releaseJobLease(job: ClaimedAnalyticsJob, workerId: string, message?: string) {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from('profile_analytics_refresh_jobs')
    .update({
      status: 'pending',
      claimed_by: null,
      lease_until: null,
      ...(message ? { last_error_message: message.slice(0, 1200) } : {}),
    })
    .eq('id', job.job_id)
    .eq('status', 'processing')
    .eq('claimed_by', workerId);
  if (error) throw error;
}

async function claimNextItem(job: ClaimedAnalyticsJob, workerId: string, leaseSeconds: number) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('claim_profile_analytics_refresh_job_item', {
    p_job_id: job.job_id,
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw error;
  return ((data ?? []) as AnalyticsJobItem[])[0] ?? null;
}

async function completeItem(input: {
  item: AnalyticsJobItem;
  workerId: string;
  outcome: AnalyticsItemOutcome;
  classification?: AnalyticsErrorClassification;
  metadata?: Record<string, unknown>;
}) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('complete_profile_analytics_refresh_job_item', {
    p_job_id: input.item.job_id,
    p_profile_id: input.item.profile_id,
    p_worker_id: input.workerId,
    p_outcome: input.outcome,
    p_error_class: input.classification?.errorClass ?? null,
    p_error_code: input.classification?.code ?? null,
    p_error_message: input.classification?.message ?? null,
    p_retryable: input.classification?.retryable ?? false,
    p_metadata: input.metadata ?? {},
  });
  if (error) throw error;
  return ((data ?? []) as Array<{ status: string; attempts: number; max_attempts: number; next_attempt_at: string | null; dead_lettered: boolean }>)[0] ?? null;
}

async function persistStepTelemetry(input: {
  job: ClaimedAnalyticsJob;
  profileId?: string;
  workerId: string;
  events: AnalyticsStepTelemetry[];
}) {
  if (input.events.length === 0) return;
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from('profile_analytics_refresh_step_events').insert(input.events.map((event) => ({
    job_id: input.job.job_id,
    organization_id: input.job.organization_id,
    profile_id: input.profileId ?? null,
    worker_id: input.workerId,
    step: event.step,
    outcome: event.outcome,
    duration_ms: Math.min(Math.max(Math.round(event.durationMs), 0), 3_600_000),
    error_class: event.errorClass ?? null,
    error_code: event.errorCode ?? null,
  })));
  if (error) console.warn('Falha não bloqueante ao gravar telemetria de analytics.', { jobId: input.job.job_id, profileId: input.profileId, error: error.message });
}

async function persistConnectionPressureEvent(input: {
  job: ClaimedAnalyticsJob;
  item: AnalyticsJobItem;
  workerId: string;
  connectionKey: string;
  classification: AnalyticsErrorClassification;
  globalConcurrency: number;
  connectionConcurrency: number;
  consecutiveIncidents: number;
  cooldownMs: number;
}) {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from('profile_analytics_refresh_connection_pressure_events').insert({
    job_id: input.job.job_id,
    organization_id: input.job.organization_id,
    zernio_connection_id: input.item.zernio_connection_id,
    connection_key: input.connectionKey,
    worker_id: input.workerId,
    error_class: input.classification.errorClass,
    error_code: input.classification.code.slice(0, 160),
    global_concurrency: input.globalConcurrency,
    connection_concurrency: input.connectionConcurrency,
    consecutive_incidents: input.consecutiveIncidents,
    cooldown_ms: input.cooldownMs,
  });
  if (error) console.warn('Falha não bloqueante ao gravar pressão da conexão Zernio.', { jobId: input.job.job_id, connectionKey: input.connectionKey, error: error.message });
}

class ZernioConnectionThrottle {
  private readonly states = new Map<string, ConnectionState>();

  constructor(
    private readonly job: ClaimedAnalyticsJob,
    private readonly workerId: string,
    private readonly globalConcurrency: number,
    private readonly maxConnectionConcurrency = 5,
  ) {}

  connectionKey(item: AnalyticsJobItem) {
    return item.zernio_connection_id ?? `${item.organization_id}:organization-default`;
  }

  private stateFor(item: AnalyticsJobItem) {
    const key = this.connectionKey(item);
    let state = this.states.get(key);
    if (!state) {
      state = { active: 0, cooldownUntil: 0, consecutiveIncidents: 0 };
      this.states.set(key, state);
    }
    return { key, state };
  }

  async acquire(item: AnalyticsJobItem) {
    const { key, state } = this.stateFor(item);
    for (;;) {
      const now = Date.now();
      const inCooldown = state.cooldownUntil > now;
      const allowedConcurrency = inCooldown ? 1 : this.maxConnectionConcurrency;
      // Após timeout, 429 ou 5xx, não inicia uma nova rajada nesta conexão.
      // Se ainda houver uma operação já em curso, ela é a única permitida até
      // expirar o cooldown; se não houver, a próxima aguarda o mesmo prazo.
      if (inCooldown && state.active === 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(state.cooldownUntil - now, 50), 1000)));
        continue;
      }
      if (state.active < allowedConcurrency) {
        state.active += 1;
        return () => {
          state.active = Math.max(0, state.active - 1);
        };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(state.cooldownUntil - now, 50), 1000)));
    }
  }

  async refreshBilling(item: AnalyticsJobItem) {
    if (!item.zernio_connection_id) return null;
    const { state } = this.stateFor(item);
    if (!state.billing) {
      state.billing = (async () => {
        const billingStartedAt = performance.now();
        try {
          await refreshZernioConnectionBilling(item.organization_id, item.zernio_connection_id!, { minAgeMs: 30 * 60 * 1000 });
          return { step: 'connection_billing', outcome: 'success', durationMs: performance.now() - billingStartedAt };
        } catch (error) {
          const classification = classifyAnalyticsError(error);
          return {
            step: 'connection_billing',
            outcome: 'error',
            durationMs: performance.now() - billingStartedAt,
            errorClass: classification.errorClass,
            errorCode: classification.code,
          };
        }
      })();
    }
    return state.billing;
  }

  async observe(item: AnalyticsJobItem, telemetry: AnalyticsStepTelemetry[], resultClassification?: AnalyticsErrorClassification) {
    const pressure = telemetry.find((event) => (
      (event.step === 'connection_billing' || event.step.startsWith('zernio_'))
      && event.outcome === 'error'
      && (event.errorClass === 'timeout' || event.errorClass === 'rate_limit' || event.errorClass === 'unavailable')
    ));
    const pressureErrorClass = pressure?.errorClass;
    const classification = pressureErrorClass === 'timeout' || pressureErrorClass === 'rate_limit' || pressureErrorClass === 'unavailable'
      ? { errorClass: pressureErrorClass, code: pressure?.errorCode ?? 'zernio_pressure', message: 'Pressão detectada na integração Zernio.', retryable: true } satisfies AnalyticsErrorClassification
      : resultClassification?.errorClass === 'timeout' || resultClassification?.errorClass === 'rate_limit' || resultClassification?.errorClass === 'unavailable'
        ? resultClassification
        : null;
    if (!classification) return;

    const { key, state } = this.stateFor(item);
    state.consecutiveIncidents += 1;
    const cooldownMs = Math.min(120_000, 15_000 * (2 ** Math.min(state.consecutiveIncidents - 1, 3)));
    state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + cooldownMs);
    await persistConnectionPressureEvent({
      job: this.job,
      item,
      workerId: this.workerId,
      connectionKey: key,
      classification,
      globalConcurrency: this.globalConcurrency,
      connectionConcurrency: 1,
      consecutiveIncidents: state.consecutiveIncidents,
      cooldownMs,
    });
  }

  recordSuccess(item: AnalyticsJobItem) {
    const { state } = this.stateFor(item);
    if (state.cooldownUntil <= Date.now()) state.consecutiveIncidents = 0;
  }
}

function resultClassification(result: Awaited<ReturnType<typeof syncProfileAnalytics>>): { outcome: AnalyticsItemOutcome; classification?: AnalyticsErrorClassification } {
  if (result.status === 'synced') return { outcome: 'synced' };
  if (result.status === 'partial') return { outcome: 'partial' };
  if (result.status === 'no_data') return { outcome: 'no_data' };
  if (result.skipped) return { outcome: 'skipped' };

  const classification = classifyAnalyticsError({
    code: 'code' in result ? result.code : result.status,
    message: result.message,
    retryable: 'retryable' in result ? result.retryable : result.status === 'rate_limited',
  });
  return { outcome: 'error', classification };
}

async function processOneItem(job: ClaimedAnalyticsJob, workerId: string, leaseSeconds: number, throttle: ZernioConnectionThrottle) {
  const item = await claimNextItem(job, workerId, leaseSeconds);
  if (!item) {
    await refreshJob(job.job_id);
    return { jobId: job.job_id, processed: 0 };
  }

  const itemStartedAt = performance.now();
  const telemetry: AnalyticsStepTelemetry[] = [];
  const releaseConnection = await throttle.acquire(item);
  try {
    const billingTelemetry = await throttle.refreshBilling(item);
    if (billingTelemetry) telemetry.push(billingTelemetry);
    const result = await syncProfileAnalytics(item.profile_id, {
      organizationId: item.organization_id,
      force: true,
      onStep: (event) => telemetry.push(event),
    });
    const classified = resultClassification(result);
    await throttle.observe(item, telemetry, classified.classification);
    if (!classified.classification) throttle.recordSuccess(item);
    const completeStartedAt = performance.now();
    const completed = await completeItem({
      item,
      workerId,
      ...classified,
      metadata: { analyticsStatus: result.status },
    });
    telemetry.push({ step: 'item_complete', outcome: classified.outcome === 'error' ? 'error' : classified.outcome === 'partial' ? 'partial' : classified.outcome === 'skipped' ? 'skipped' : 'success', durationMs: performance.now() - completeStartedAt, errorClass: classified.classification?.errorClass, errorCode: classified.classification?.code });
    await persistStepTelemetry({ job, profileId: item.profile_id, workerId, events: telemetry });
    return { jobId: job.job_id, profileId: item.profile_id, processed: 1, status: completed?.status ?? classified.outcome };
  } catch (error) {
    const classification = classifyAnalyticsError(error);
    telemetry.push({ step: 'item_complete', outcome: 'error', durationMs: performance.now() - itemStartedAt, errorClass: classification.errorClass, errorCode: classification.code });
    await throttle.observe(item, telemetry, classification);
    const completed = await completeItem({ item, workerId, outcome: 'error', classification });
    await persistStepTelemetry({ job, profileId: item.profile_id, workerId, events: telemetry });
    return {
      jobId: job.job_id,
      profileId: item.profile_id,
      processed: 1,
      status: completed?.status ?? 'dead_letter',
      error: classification.message,
    };
  } finally {
    releaseConnection();
  }
}

export async function dispatchProfileAnalyticsRefreshJobs(options: ProfileAnalyticsRefreshDispatchOptions = {}) {
  const workerId = options.workerId?.trim().slice(0, 120) || `profile-analytics-${randomUUID()}`;
  const limit = Number.isInteger(options.limit) ? Math.min(Math.max(options.limit!, 1), 50) : 20;
  // Dez slots globais drenam o backlog rapidamente. A proteção por conexão
  // abaixo mantém no máximo cinco perfis da mesma credencial em paralelo.
  const concurrency = Number.isInteger(options.concurrency) ? Math.min(Math.max(options.concurrency!, 1), 10) : 10;
  const leaseSeconds = Number.isInteger(options.leaseSeconds) ? Math.min(Math.max(options.leaseSeconds!, 30), 1800) : 300;
  const supabase = createSupabaseAdminClient();
  const processed: Array<Record<string, unknown>> = [];

  const cycleStartedAt = performance.now();
  const { data: claimed, error: claimError } = await supabase.rpc('claim_profile_analytics_refresh_job', {
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
  });
  if (claimError) throw claimError;
  const job = ((claimed ?? []) as ClaimedAnalyticsJob[])[0];
  if (!job) return { workerId, chunks: 0, processed, concurrency };

  const throttle = new ZernioConnectionThrottle(job, workerId, concurrency);
  let remainingClaims = limit;
  let claimedCount = 0;
  async function consumeOneSlot() {
    while (remainingClaims > 0) {
      remainingClaims -= 1;
    try {
      const result = await processOneItem(job, workerId, leaseSeconds, throttle);
      if (result.processed === 0) return;
      claimedCount += result.processed;
      if (result.processed > 0) processed.push(result);
    } catch (error) {
      const message = errorMessage(error);
      console.error('Falha isolada no worker de analytics.', { jobId: job.job_id, error: message, details: error });
      processed.push({ jobId: job.job_id, processed: 0, status: 'error', error: message });
    }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, limit) }, () => consumeOneSlot()));

  const refreshed = await refreshJob(job.job_id);
  if (refreshed?.status === 'processing') await releaseJobLease(job, workerId);

  await persistStepTelemetry({
    job,
    workerId,
    events: [{ step: 'worker_cycle', outcome: 'success', durationMs: performance.now() - cycleStartedAt }],
  });
  const hasMore = claimedCount >= limit && (refreshed?.status === 'pending' || refreshed?.status === 'processing');
  console.info('Dispatcher de analytics concluído.', { workerId, chunks: processed.length, claimedCount, concurrency, hasMore, processed });
  return { workerId, chunks: processed.length, claimedCount, processed, concurrency, hasMore };
}
