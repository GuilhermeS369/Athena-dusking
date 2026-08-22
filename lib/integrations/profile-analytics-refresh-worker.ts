import { randomUUID } from 'node:crypto';

import { syncProfileAnalytics } from '@/lib/integrations/zernio-analytics';
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

type AnalyticsV2ShadowItem = {
  item_id: string;
  legacy_job_id: string | null;
  organization_id: string;
  profile_id: string;
  zernio_connection_id: string | null;
  connection_key: string;
  source_class: 'current' | 'daily' | 'posts' | 'inventory' | 'backfill';
  execution_mode: 'shadow';
  priority: number;
  estimated_requests: number;
  attempts: number;
  max_attempts: number;
  lease_token: string;
  lease_until: string;
};

type AnalyticsV2LiveItem = Omit<AnalyticsV2ShadowItem, 'execution_mode'> & {
  execution_mode: 'live';
};

export type ProfileAnalyticsV2LiveDispatchOptions = {
  workerId: string;
  organizationIds: string[];
  sourceClasses?: Array<'current' | 'daily' | 'posts'>;
  limit?: number;
  concurrency?: number;
  leaseSeconds?: number;
  maxConnectionLeases?: number;
};

type AnalyticsV2ShadowSummary = {
  enabled: boolean;
  enqueued: number;
  claimed: number;
  completed: number;
  failed: number;
  hasMore: boolean;
  sourceClasses: string[];
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
  | 'profile_lookup'
  | 'sync_run_create'
  | 'zernio_account_insights'
  | 'zernio_follower_history'
  | 'zernio_post_analytics'
  | 'zernio_current_posts'
  | 'zernio_daily_metrics'
  | 'payload_archive_persist'
  | 'current_state_persist'
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
};

export type ProfileAnalyticsRefreshDispatchOptions = {
  workerId?: string;
  limit?: number;
  concurrency?: number;
  leaseSeconds?: number;
  shadowEnabled?: boolean;
  shadowLimit?: number;
  shadowConcurrency?: number;
  shadowMaxConnectionLeases?: number;
  organizationIds?: string[];
  excludedOrganizationIds?: string[];
};

const ANALYTICS_V2_SOURCE_CLASSES = new Set(['current', 'daily', 'posts', 'inventory', 'backfill']);

function booleanEnv(name: string, fallback = false) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

function shadowSourceClasses() {
  const configured = (process.env.PROFILE_ANALYTICS_QUEUE_V2_SHADOW_SOURCE_CLASSES ?? 'current,daily,posts')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => ANALYTICS_V2_SOURCE_CLASSES.has(value));
  return [...new Set(configured.length > 0 ? configured : ['current', 'daily', 'posts'])];
}

function shadowOrganizationIds() {
  return new Set((process.env.PROFILE_ANALYTICS_QUEUE_V2_SHADOW_ORGANIZATION_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean));
}

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

async function enqueueShadowItems(legacyJobId: string, sourceClasses: string[]) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('enqueue_profile_analytics_refresh_v2_shadow_job', {
    p_legacy_job_id: legacyJobId,
    p_source_classes: sourceClasses,
  });
  if (error) throw error;
  return ((data ?? []) as Array<{ inserted_count: number; total_count: number }>)[0] ?? null;
}

async function claimShadowItem(workerId: string, leaseSeconds: number, maxConnectionLeases: number) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('claim_profile_analytics_refresh_v2_item', {
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
    p_max_connection_leases: maxConnectionLeases,
    p_execution_mode: 'shadow',
  });
  if (error) throw error;
  return ((data ?? []) as AnalyticsV2ShadowItem[])[0] ?? null;
}

async function completeShadowItem(item: AnalyticsV2ShadowItem, workerId: string, durationMs: number) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('complete_profile_analytics_refresh_v2_item', {
    p_item_id: item.item_id,
    p_worker_id: workerId,
    p_lease_token: item.lease_token,
    p_outcome: 'shadow_observed',
    p_retryable: false,
    p_error_class: null,
    p_error_code: null,
    p_error_message: null,
    p_duration_ms: Math.min(Math.max(Math.round(durationMs), 0), 3_600_000),
    p_metadata: {
      shadowOnly: true,
      decision: 'would_execute',
      sourceClass: item.source_class,
      estimatedRequests: item.estimated_requests,
      connectionKey: item.connection_key,
    },
  });
  if (error) throw error;
  return ((data ?? []) as Array<{ status: string; idempotent: boolean }>)[0] ?? null;
}

async function claimLiveItem(workerId: string, organizationIds: string[], sourceClasses: Array<'current' | 'daily' | 'posts'>, leaseSeconds: number, maxConnectionLeases: number) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('claim_profile_analytics_refresh_v2_live_item', {
    p_worker_id: workerId,
    p_organization_ids: organizationIds,
    p_source_classes: sourceClasses,
    p_lease_seconds: leaseSeconds,
    p_max_connection_leases: maxConnectionLeases,
  });
  if (error) throw error;
  return ((data ?? []) as AnalyticsV2LiveItem[])[0] ?? null;
}

async function completeLiveItem(input: {
  item: AnalyticsV2LiveItem;
  workerId: string;
  outcome: 'succeeded' | 'skipped' | 'error';
  retryable?: boolean;
  classification?: AnalyticsErrorClassification;
  durationMs: number;
  metadata?: Record<string, unknown>;
}) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('complete_profile_analytics_refresh_v2_item', {
    p_item_id: input.item.item_id,
    p_worker_id: input.workerId,
    p_lease_token: input.item.lease_token,
    p_outcome: input.outcome,
    p_retryable: input.retryable ?? false,
    p_error_class: input.classification?.errorClass ?? null,
    p_error_code: input.classification?.code ?? null,
    p_error_message: input.classification?.message ?? null,
    p_duration_ms: Math.min(Math.max(Math.round(input.durationMs), 0), 3_600_000),
    p_metadata: input.metadata ?? {},
  });
  if (error) throw error;
  const { error: watermarkError } = await supabase.from('profile_analytics_source_watermarks')
    .update({
      metadata: {
        executionMode: 'live',
        sourceClasses: [input.item.source_class],
        ...(input.metadata ?? {}),
      },
    })
    .eq('organization_id', input.item.organization_id)
    .eq('profile_id', input.item.profile_id)
    .eq('source_class', input.item.source_class);
  if (watermarkError) console.warn('Falha não bloqueante ao normalizar metadata do watermark V2 live.', {
    itemId: input.item.item_id,
    error: watermarkError.message,
  });
  return ((data ?? []) as Array<{ status: string; idempotent: boolean }>)[0] ?? null;
}

export async function dispatchProfileAnalyticsV2LiveItems(options: ProfileAnalyticsV2LiveDispatchOptions) {
  const workerId = options.workerId.trim().slice(0, 120);
  const allowedOrganizations = new Set(options.organizationIds.map((value) => value.trim()).filter(Boolean));
  if (!workerId || allowedOrganizations.size === 0) throw new Error('Worker e organizações são obrigatórios para a fila V2 live.');
  const requestedSourceClasses: Array<'current' | 'daily' | 'posts'> = options.sourceClasses ?? ['current'];
  const sourceClasses: Array<'current' | 'daily' | 'posts'> = [...new Set(requestedSourceClasses)];
  if (sourceClasses.length === 0 || sourceClasses.some((sourceClass) => !['current', 'daily', 'posts'].includes(sourceClass))) {
    throw new Error('A fila V2 live aceita somente current, daily e posts.');
  }
  const limit = Number.isInteger(options.limit) ? Math.min(Math.max(options.limit!, 1), 10) : 1;
  const concurrency = Number.isInteger(options.concurrency) ? Math.min(Math.max(options.concurrency!, 1), 5) : 1;
  const leaseSeconds = Number.isInteger(options.leaseSeconds) ? Math.min(Math.max(options.leaseSeconds!, 30), 1800) : 300;
  const maxConnectionLeases = Number.isInteger(options.maxConnectionLeases) ? Math.min(Math.max(options.maxConnectionLeases!, 1), 5) : 1;
  let remaining = limit;
  let claimed = 0;
  let completed = 0;
  let failed = 0;

  async function consume() {
    while (remaining > 0) {
      remaining -= 1;
      const item = await claimLiveItem(workerId, [...allowedOrganizations], sourceClasses, leaseSeconds, maxConnectionLeases);
      if (!item) return;
      claimed += 1;
      const startedAt = performance.now();
      if (!allowedOrganizations.has(item.organization_id) || !sourceClasses.includes(item.source_class as 'current' | 'daily' | 'posts')) {
        const classification = classifyAnalyticsError({ code: 'live_canary_scope_violation', message: 'Item live fora do escopo de classe/organização do canário.' });
        await completeLiveItem({ item, workerId, outcome: 'error', classification, durationMs: performance.now() - startedAt });
        failed += 1;
        continue;
      }
      try {
        const telemetry: AnalyticsStepTelemetry[] = [];
        const result = await syncProfileAnalytics(item.profile_id, {
          organizationId: item.organization_id,
          force: true,
          sourceClasses: [item.source_class as 'current' | 'daily' | 'posts'],
          onStep: (event) => telemetry.push(event),
        });
        const classified = resultClassification(result);
        const metadata = {
          analyticsStatus: result.status,
          sourceClasses: [item.source_class],
          steps: telemetry.map((event) => event.step),
        };
        if (classified.outcome === 'error') {
          await completeLiveItem({ item, workerId, outcome: 'error', retryable: classified.classification?.retryable, classification: classified.classification, durationMs: performance.now() - startedAt, metadata });
          failed += 1;
        } else {
          await completeLiveItem({ item, workerId, outcome: classified.outcome === 'skipped' ? 'skipped' : 'succeeded', durationMs: performance.now() - startedAt, metadata });
          completed += 1;
        }
      } catch (error) {
        const classification = classifyAnalyticsError(error);
        await completeLiveItem({ item, workerId, outcome: 'error', retryable: classification.retryable, classification, durationMs: performance.now() - startedAt, metadata: { sourceClasses: [item.source_class] } });
        failed += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, limit) }, () => consume()));
  return { enabled: true, claimed, completed, failed, hasMore: claimed >= limit, sourceClasses };
}

async function dispatchProfileAnalyticsV2ShadowItems(input: {
  workerId: string;
  legacyJobId?: string;
  sourceClasses: string[];
  limit: number;
  concurrency: number;
  leaseSeconds: number;
  maxConnectionLeases: number;
}): Promise<AnalyticsV2ShadowSummary> {
  let enqueued = 0;
  if (input.legacyJobId) {
    const result = await enqueueShadowItems(input.legacyJobId, input.sourceClasses);
    enqueued = result?.inserted_count ?? 0;
  }

  let remainingClaims = input.limit;
  let claimed = 0;
  let completed = 0;
  let failed = 0;

  async function consumeShadowSlot() {
    while (remainingClaims > 0) {
      remainingClaims -= 1;
      const startedAt = performance.now();
      try {
        const item = await claimShadowItem(input.workerId, input.leaseSeconds, input.maxConnectionLeases);
        if (!item) return;
        claimed += 1;
        // Shadow mode termina aqui de propósito: não chama Zernio, não executa
        // syncProfileAnalytics e não persiste snapshots, métricas ou posts.
        await completeShadowItem(item, input.workerId, performance.now() - startedAt);
        completed += 1;
      } catch (error) {
        failed += 1;
        console.warn('Falha não bloqueante na fila V2 shadow de analytics.', {
          workerId: input.workerId,
          error: errorMessage(error),
        });
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(input.concurrency, input.limit) },
    () => consumeShadowSlot(),
  ));

  return {
    enabled: true,
    enqueued,
    claimed,
    completed,
    failed,
    hasMore: claimed >= input.limit,
    sourceClasses: input.sourceClasses,
  };
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

  async observe(item: AnalyticsJobItem, telemetry: AnalyticsStepTelemetry[], resultClassification?: AnalyticsErrorClassification) {
    const pressure = telemetry.find((event) => (
      event.step.startsWith('zernio_')
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
    // Billing é uma responsabilidade da sincronização/saúde da conexão. Fazer
    // essa consulta em cada item de analytics repetia leitura, descriptografia
    // e eventualmente uma chamada remota sem contribuir com as métricas.
    // Respostas 402 dos próprios endpoints continuam sendo classificadas pelo
    // fluxo abaixo sem bloquear os demais perfis.
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
  const shadowEnabled = options.shadowEnabled === true || booleanEnv('PROFILE_ANALYTICS_QUEUE_V2_SHADOW_ENABLED');
  const shadowLimit = Number.isInteger(options.shadowLimit) ? Math.min(Math.max(options.shadowLimit!, 1), 50) : 20;
  const shadowConcurrency = Number.isInteger(options.shadowConcurrency) ? Math.min(Math.max(options.shadowConcurrency!, 1), 10) : 5;
  const shadowMaxConnectionLeases = Number.isInteger(options.shadowMaxConnectionLeases) ? Math.min(Math.max(options.shadowMaxConnectionLeases!, 1), 10) : 2;
  const sourceClasses = shadowSourceClasses();
  const allowedShadowOrganizations = shadowOrganizationIds();
  const organizationIds = [...new Set((options.organizationIds ?? [])
    .map((value) => value.trim())
    .filter(Boolean))];
  const excludedOrganizationIds = [...new Set((options.excludedOrganizationIds ?? [])
    .map((value) => value.trim())
    .filter(Boolean))];
  const supabase = createSupabaseAdminClient();
  const processed: Array<Record<string, unknown>> = [];

  const cycleStartedAt = performance.now();
  const { data: claimed, error: claimError } = await supabase.rpc('claim_profile_analytics_refresh_job', {
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
    p_organization_ids: organizationIds.length > 0 ? organizationIds : null,
    p_excluded_organization_ids: excludedOrganizationIds.length > 0 ? excludedOrganizationIds : null,
  });
  if (claimError) throw claimError;
  const job = ((claimed ?? []) as ClaimedAnalyticsJob[])[0];
  let shadow: AnalyticsV2ShadowSummary = {
    enabled: shadowEnabled,
    enqueued: 0,
    claimed: 0,
    completed: 0,
    failed: 0,
    hasMore: false,
    sourceClasses,
  };

  const shadowAllowedForJob = !job
    || allowedShadowOrganizations.size === 0
    || allowedShadowOrganizations.has(job.organization_id);

  if (shadowEnabled && shadowAllowedForJob) {
    try {
      shadow = await dispatchProfileAnalyticsV2ShadowItems({
        workerId,
        legacyJobId: job?.job_id,
        sourceClasses,
        limit: shadowLimit,
        concurrency: shadowConcurrency,
        leaseSeconds,
        maxConnectionLeases: shadowMaxConnectionLeases,
      });
    } catch (error) {
      shadow.failed += 1;
      console.warn('Fila V2 shadow indisponível; fila legada continuará sem alteração.', {
        workerId,
        legacyJobId: job?.job_id,
        error: errorMessage(error),
      });
    }
  } else if (shadowEnabled && job) {
    console.info('Fila V2 shadow ignorada para organização fora do canário.', {
      workerId,
      legacyJobId: job.job_id,
      organizationId: job.organization_id,
    });
  }

  if (!job) return { workerId, chunks: 0, processed, concurrency, shadow, hasMore: shadow.hasMore };

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
  const hasMore = shadow.hasMore || (claimedCount >= limit && (refreshed?.status === 'pending' || refreshed?.status === 'processing'));
  console.info('Dispatcher de analytics concluído.', { workerId, chunks: processed.length, claimedCount, concurrency, shadow, hasMore, processed });
  return { workerId, chunks: processed.length, claimedCount, processed, concurrency, shadow, hasMore };
}
