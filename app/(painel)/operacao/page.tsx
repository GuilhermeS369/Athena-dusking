import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import PageLoadingSkeleton from '@/app/components/page-loading-skeleton';
import OperationClient from '@/app/operacao/operation-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { isSystemSuperUser } from '@/lib/security/super-user';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

type ZernioConnection = { id: string; label: string };
type OperationalProfile = {
  id: string;
  username: string;
  display_name: string | null;
  status: string;
  provider: 'meta_official' | 'zernio';
  zernio_account_id: string | null;
  zernio_connection_id: string | null;
  zernio_connection_label?: string | null;
  token_expires_at: string | null;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
};

type AttentionItemRow = {
  id: string;
  batch_id: string;
  format: string;
  status: string;
  profile_id: string;
  execute_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  attempt_count: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  claimed_by: string | null;
  updated_at: string;
  created_at: string;
  publication_batches: { name: string | null } | { name: string | null }[] | null;
  publication_item_media?: Array<{ media_assets: { id: string; status: string; deleted_at: string | null } | Array<{ id: string; status: string; deleted_at: string | null }> | null }> | null;
};

type OperationEventRow = {
  id: string;
  publication_item_id: string;
  event_type: string;
  previous_status: string | null;
  status: string;
  actor_label: string | null;
  error_code: string | null;
  error_message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  publication_items: { profile_id: string; format: string; batch_id: string; publication_batches?: { name: string | null } | { name: string | null }[] | null } | Array<{ profile_id: string; format: string; batch_id: string; publication_batches?: { name: string | null } | { name: string | null }[] | null }> | null;
};

type QueueSummaryRow = {
  organization_id: string;
  status: string;
  total: number;
  expired_leases: number;
  due_retries: number;
  overdue: number;
  oldest_execute_at: string | null;
  max_lag_seconds: number;
};

type WorkerStatusRow = {
  worker_id: string;
  worker_kind: string;
  status: string;
  dry_run: boolean;
  version: string | null;
  hostname: string | null;
  process_id: number | null;
  started_at: string;
  last_seen_at: string;
  seconds_since_seen: number;
  is_stale: boolean;
  last_error_message: string | null;
  metadata: Record<string, unknown> | null;
};

type AsyncJobSummaryRow = {
  job_kind: string;
  status: string;
  total: number;
  pending_units: number;
  failed_units: number;
  oldest_created_at: string | null;
  newest_updated_at: string | null;
  max_age_seconds: number;
};

type OperationalAlertRow = {
  severity: 'critical' | 'warning' | 'info' | string;
  alert_kind: string;
  title: string;
  detail: string;
  total: number;
};

type PublicationThroughputRow = {
  window_label: string;
  window_start: string;
  published_count: number;
  failed_count: number;
  attempted_count: number;
  unique_profiles: number;
  average_publish_lag_seconds: number;
  max_publish_lag_seconds: number;
};

type SlotRiskIncidentRow = {
  id: string;
  batch_id: string;
  batch_name: string;
  state: 'at_risk' | 'recovered' | 'ignored' | string;
  slot_execute_at: string;
  affected_item_count: number;
  overdue_seconds: number;
  next_slot_execute_at: string | null;
  decision_reason: string;
  created_at: string;
  updated_at: string;
};

type WorkerCycleRow = {
  worker_id: string;
  phase: 'started' | 'completed' | 'failed' | string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
};

type PublicationDispatchTelemetry = {
  generatedAt: string;
  windowHours: number;
  windowStart: string;
  providers: Array<{
    provider: 'meta_official' | 'zernio' | string;
    published_count: number;
    failed_count: number;
    deferred_count: number;
    retry_requested_count: number;
    unique_profiles: number;
    publish_lag_p95_seconds: number;
    publish_lag_max_seconds: number;
  }>;
  errors: Array<{
    provider: 'meta_official' | 'zernio' | string;
    error_code: string;
    total: number;
    first_seen_at: string;
    last_seen_at: string;
    latest_message: string;
  }>;
  cycles: {
    completed_cycles: number;
    failed_cycles: number;
    cycle_duration_p50_ms: number;
    cycle_duration_p95_ms: number;
    claimed_count: number;
    cycle_published_count: number;
    cycle_failed_count: number;
    rate_limited_count: number;
  };
  queue: { active_items: number; expired_leases: number; due_retries: number; overdue: number; max_lag_seconds: number };
  alerts: Array<{ severity: 'critical' | 'warning' | string; kind: string; title: string; detail: string; total: number }>;
};

const operationPageSize = 40;

export default function OperationPage() {
  return (
    <Suspense fallback={<PageLoadingSkeleton variant="logs" />}>
      <OperationPageContent />
    </Suspense>
  );
}

async function OperationPageContent() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  const organizationId = context.activeOrganization.id;
  const isSuperUser = isSystemSuperUser(context.user.email);
  const supabase = await createSupabaseServerClient();
  const nowIso = new Date().toISOString();
  const { data: visibilityRows, error: visibilityError } = await supabase
    .from('operational_log_clear_actions')
    .select('scope_key, cleared_at, undone_at')
    .eq('organization_id', organizationId)
    .eq('actor_user_id', context.user.id)
    .is('undone_at', null);
  if (visibilityError) throw new Error('Não foi possível carregar a preferência de visualização operacional.');
  const visibilityByScope = new Map((visibilityRows ?? []).map((action) => [action.scope_key, action.cleared_at]));
  const attentionClearedAt = visibilityByScope.get('attention_items') ?? null;
  const eventsClearedAt = visibilityByScope.get('publication_events') ?? null;
  const attentionSelect = isSuperUser
    ? 'id, batch_id, format, status, profile_id, execute_at, last_error_code, last_error_message, attempt_count, next_attempt_at, lease_until, claimed_by, updated_at, created_at, publication_batches(name), publication_item_media(media_assets(id, status, deleted_at))'
    : 'id, batch_id, format, status, profile_id, execute_at, last_error_code, last_error_message, attempt_count, next_attempt_at, lease_until, updated_at, created_at, publication_batches(name), publication_item_media(media_assets(id, status, deleted_at))';
  const eventSelect = isSuperUser
    ? 'id, publication_item_id, event_type, previous_status, status, actor_label, error_code, error_message, metadata, created_at, publication_items(profile_id, format, batch_id, publication_batches(name))'
    : 'id, publication_item_id, event_type, previous_status, status, actor_label, error_code, error_message, created_at, publication_items(profile_id, format, batch_id, publication_batches(name))';
  let attentionQuery = supabase
    .from('publication_items')
    .select(attentionSelect)
    .eq('organization_id', organizationId)
    .in('status', ['failed', 'preparing', 'publishing', 'removed'])
    .or('last_error_code.is.null,last_error_code.neq.zernio_account_disconnected')
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(operationPageSize + 1);
  if (attentionClearedAt) attentionQuery = attentionQuery.gt('updated_at', attentionClearedAt);
  let eventsQuery = supabase
    .from('publication_item_events')
    .select(eventSelect)
    .eq('organization_id', organizationId)
    .or('error_code.is.null,error_code.neq.zernio_account_disconnected')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(operationPageSize + 1);
  if (eventsClearedAt) eventsQuery = eventsQuery.gt('created_at', eventsClearedAt);
  const [profilesResult, zernioResult, attentionResult, eventsResult, healthResult, queueResult, slotRisksResult] = await Promise.all([
    supabase
      .from('instagram_profiles_safe')
      .select('id, username, display_name, status, provider, zernio_account_id, zernio_connection_id, token_expires_at, last_checked_at, last_success_at, last_failure_at, last_error_code, last_error_message')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false }),
    supabase
      .from('zernio_connections_safe')
      .select('id, label, status, balance_cents, balance_currency, instagram_profile_count, last_checked_at, last_sync_at, last_error_message')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false }),
    attentionQuery,
    eventsQuery,
    supabase.rpc('get_publication_health_summary', { p_organization_id: organizationId }),
    supabase.rpc('get_publication_queue_operational_summary', { p_organization_id: organizationId }),
    supabase.rpc('get_publication_slot_risk_incidents', { p_organization_id: organizationId, p_limit: 20 }),
  ]);

  const [workersResult, asyncJobsResult, alertsResult, throughputResult, workerCyclesResult, dispatchTelemetryResult] = isSuperUser
    ? await Promise.all([
      supabase.rpc('get_worker_operational_status', { p_organization_id: organizationId, p_stale_after_seconds: 120 }),
      supabase.rpc('get_async_job_operational_summary', { p_organization_id: organizationId }),
      supabase.rpc('get_operational_alerts', { p_organization_id: organizationId, p_stale_after_seconds: 120, p_queue_lag_warning_seconds: 300, p_async_job_age_warning_seconds: 1800 }),
      supabase.rpc('get_publication_throughput_summary', { p_organization_id: organizationId, p_hours: 24 }),
      supabase.rpc('get_publication_worker_cycle_observability', { p_limit: 20 }),
      supabase.rpc('get_publication_dispatch_telemetry', { p_organization_id: organizationId, p_hours: 24 }),
    ])
    : [
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: null, error: null },
    ];

  if (profilesResult.error || zernioResult.error || attentionResult.error || eventsResult.error || healthResult.error || queueResult.error || slotRisksResult.error || workersResult.error || asyncJobsResult.error || alertsResult.error || throughputResult.error || workerCyclesResult.error || dispatchTelemetryResult.error) {
    console.error('Falha ao carregar Status / Logs.', {
      profiles: profilesResult.error?.message,
      zernio: zernioResult.error?.message,
      attention: attentionResult.error?.message,
      events: eventsResult.error?.message,
      health: healthResult.error?.message,
      queue: queueResult.error?.message,
      slotRisks: slotRisksResult.error?.message,
      workers: workersResult.error?.message,
      asyncJobs: asyncJobsResult.error?.message,
      alerts: alertsResult.error?.message,
      throughput: throughputResult.error?.message,
      workerCycles: workerCyclesResult.error?.message,
      dispatchTelemetry: dispatchTelemetryResult.error?.message,
    });
    throw new Error('Não foi possível carregar o status operacional.');
  }

  const zernioLabelById = new Map((zernioResult.data ?? []).map((connection: ZernioConnection) => [connection.id, connection.label]));
  const profiles = (profilesResult.data ?? []).map((profile: OperationalProfile) => ({
    ...profile,
    zernio_connection_label: profile.zernio_connection_id ? zernioLabelById.get(profile.zernio_connection_id) ?? null : null,
  }));
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const enrichItem = (item: AttentionItemRow) => ({
    ...item,
    profile: profileById.get(item.profile_id) ?? null,
  });
  const queueRows = (queueResult.data ?? []) as QueueSummaryRow[];
  const activeItemCount = queueRows.reduce((total, item) => total + item.total, 0);
  const expiredLeaseCount = queueRows.reduce((total, item) => total + item.expired_leases, 0);
  const dueRetryCount = queueRows.reduce((total, item) => total + item.due_retries, 0);
  const overdueCount = queueRows.reduce((total, item) => total + item.overdue, 0);
  const attentionRows = ((attentionResult.data ?? []) as unknown as AttentionItemRow[])
    .map((item) => (isSuperUser ? item : { ...item, claimed_by: null }))
    .slice(0, operationPageSize);
  const eventRows = ((eventsResult.data ?? []) as unknown as OperationEventRow[])
    .map((event) => (isSuperUser ? event : { ...event, actor_label: null, metadata: null }))
    .slice(0, operationPageSize);
  const lastAttentionRow = attentionRows.at(-1);
  const lastEventRow = eventRows.at(-1);

  return (
    <OperationClient
      activeOrganization={context.activeOrganization}
      isSuperUser={isSuperUser}
      profiles={profiles}
      zernioConnections={zernioResult.data ?? []}
      attentionItems={attentionRows.map(enrichItem)}
      attentionPageInfo={{
        hasMore: (attentionResult.data?.length ?? 0) > operationPageSize,
        nextCursor: lastAttentionRow ? { updatedAt: lastAttentionRow.updated_at, id: lastAttentionRow.id } : null,
      }}
      events={eventRows.map((event) => ({
        ...event,
        item: Array.isArray(event.publication_items) ? event.publication_items[0] ?? null : event.publication_items,
        profile: profileById.get(String((Array.isArray(event.publication_items) ? event.publication_items[0] : event.publication_items)?.profile_id ?? '')) ?? null,
      }))}
      eventPageInfo={{
        hasMore: (eventsResult.data?.length ?? 0) > operationPageSize,
        nextCursor: lastEventRow ? { createdAt: lastEventRow.created_at, id: lastEventRow.id } : null,
      }}
      healthRows={healthResult.data ?? []}
      workerStatuses={(workersResult.data ?? []) as WorkerStatusRow[]}
      asyncJobSummaries={(asyncJobsResult.data ?? []) as AsyncJobSummaryRow[]}
      operationalAlerts={(alertsResult.data ?? []) as OperationalAlertRow[]}
      publicationThroughput={(throughputResult.data ?? []) as PublicationThroughputRow[]}
      slotRiskIncidents={(slotRisksResult.data ?? []) as SlotRiskIncidentRow[]}
      workerCycles={(workerCyclesResult.data ?? []) as WorkerCycleRow[]}
      dispatchTelemetry={dispatchTelemetryResult.data as PublicationDispatchTelemetry | null}
      queueDiagnostics={{
        checkedAt: nowIso,
        activeItems: activeItemCount,
        expiredLeases: expiredLeaseCount,
        dueRetries: dueRetryCount,
        overdue: overdueCount,
      }}
      initialClearActions={{
        attention_items: attentionClearedAt,
        publication_events: eventsClearedAt,
      }}
    />
  );
}
