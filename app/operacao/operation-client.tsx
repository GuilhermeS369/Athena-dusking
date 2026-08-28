'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { PUBLICATION_MAX_ATTEMPTS } from '@/lib/publications/attempts';

type Organization = { id: string; name: string; role: 'admin' | 'operator' | 'viewer' };
type Provider = 'meta_official' | 'zernio';

type Profile = {
  id: string;
  username: string;
  display_name: string | null;
  status: 'no_data' | 'online' | 'offline' | 'reauthorization_required' | string;
  provider: Provider;
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

type ZernioConnection = {
  id: string;
  label: string;
  status: string;
  balance_cents: number | null;
  balance_currency: string | null;
  instagram_profile_count: number | null;
  last_checked_at: string | null;
  last_sync_at: string | null;
  last_error_message: string | null;
};

type AttentionItem = {
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
  profile: Profile | null;
  publication_batches: { name: string | null } | { name: string | null }[] | null;
  publication_item_media?: Array<{ media_assets: { id: string; status: string; deleted_at: string | null } | Array<{ id: string; status: string; deleted_at: string | null }> | null }> | null;
};
type AttentionItemRow = Omit<AttentionItem, 'profile'>;
type AttentionCursor = { updatedAt: string; id: string };

type OperationEvent = {
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
  item: { profile_id: string; format: string; batch_id: string; publication_batches?: { name: string | null } | { name: string | null }[] | null } | null;
  profile: Profile | null;
};
type OperationEventRow = Omit<OperationEvent, 'item' | 'profile'> & {
  publication_items: OperationEvent['item'] | OperationEvent['item'][] | null;
};
type EventCursor = { createdAt: string; id: string };

type HealthRow = { status: string; total: number; expired_leases: number; due_retries: number };
type QueueDiagnostics = { checkedAt: string; activeItems: number; expiredLeases: number; dueRetries: number; overdue: number };
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
type AsyncJobSummaryRow = { job_kind: string; status: string; total: number; pending_units: number; failed_units: number; oldest_created_at: string | null; newest_updated_at: string | null; max_age_seconds: number };
type OperationalAlertRow = { severity: 'critical' | 'warning' | 'info' | string; alert_kind: string; title: string; detail: string; total: number };
type PublicationThroughputRow = { window_label: string; window_start: string; published_count: number; failed_count: number; attempted_count: number; unique_profiles: number; average_publish_lag_seconds: number; max_publish_lag_seconds: number };
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
type DispatchProviderTelemetry = {
  provider: Provider | string;
  published_count: number;
  failed_count: number;
  deferred_count: number;
  retry_requested_count: number;
  unique_profiles: number;
  publish_lag_p95_seconds: number;
  publish_lag_max_seconds: number;
};
type DispatchErrorTelemetry = { provider: Provider | string; error_code: string; total: number; first_seen_at: string; last_seen_at: string; latest_message: string };
type PublicationDispatchTelemetry = {
  generatedAt: string;
  windowHours: number;
  windowStart: string;
  providers: DispatchProviderTelemetry[];
  errors: DispatchErrorTelemetry[];
  cycles: { completed_cycles: number; failed_cycles: number; cycle_duration_p50_ms: number; cycle_duration_p95_ms: number; claimed_count: number; cycle_published_count: number; cycle_failed_count: number; rate_limited_count: number };
  queue: { active_items: number; expired_leases: number; due_retries: number; overdue: number; max_lag_seconds: number };
  alerts: Array<{ severity: 'critical' | 'warning' | string; kind: string; title: string; detail: string; total: number }>;
};

const statusLabels: Record<string, string> = {
  no_data: 'Sem dados',
  online: 'Operacional',
  offline: 'Offline',
  reauthorization_required: 'Reconectar',
  waiting: 'Agendado',
  ready: 'Pronto',
  preparing: 'Preparando',
  publishing: 'Publicando',
  published: 'Publicado',
  failed: 'Falhou',
  removed: 'Mídia apagada',
  cancelled: 'Cancelado',
  retry_requested: 'Retentativa solicitada',
  processing_started: 'Processamento iniciado',
  processing_deferred: 'Processamento adiado',
  queued: 'Adicionado à fila',
};

const formatLabels: Record<string, string> = { image: 'Imagem', reel: 'Reel', story: 'Story', carousel: 'Carrossel' };

function displayDate(value: string | null | undefined) {
  return value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
}

function statusLabel(value: string | null | undefined) {
  return value ? statusLabels[value] ?? value : '—';
}

function providerLabel(provider: Provider | null | undefined) {
  return provider === 'zernio' ? 'Zernio' : 'API Oficial';
}

function providerDetail(profile: Profile | null | undefined) {
  if (!profile) return 'Perfil não carregado';
  if (profile.provider === 'zernio') return profile.zernio_connection_label ? `Conta ${profile.zernio_connection_label}` : 'Conta Zernio vinculada';
  return 'Instagram Graph API oficial';
}

function workerKindLabel(value: string) {
  return {
    publication: 'Publicação',
    publication_planner: 'Geração',
    media_deletion: 'Mídia',
    media_processing: 'Processamento de mídia',
  }[value] ?? value;
}

function asyncJobKindLabel(value: string) {
  return {
    publication_generation: 'Geração de agendamentos',
    media_deletion: 'Exclusão de mídia',
    media_group_assignment: 'Organização em grupos',
  }[value] ?? value;
}

function throughputWindowLabel(value: string) {
  return { '15m': '15 min', '1h': '1 hora', '24h': '24 horas', custom: 'Janela' }[value] ?? value;
}

function compactDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function compactMilliseconds(value: number | null) {
  if (value === null) return 'em andamento';
  if (value < 1000) return `${value}ms`;
  return compactDuration(Math.round(value / 1000));
}

function normalizedSearchValue(value: string | null | undefined) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

function profileMatchesSearch(profile: Profile | null | undefined, query: string) {
  const normalizedQuery = normalizedSearchValue(query).replace(/^@/, '');
  if (!normalizedQuery) return true;
  return [profile?.username, profile?.display_name]
    .some((value) => normalizedSearchValue(value).includes(normalizedQuery));
}

function batchName(value: AttentionItem['publication_batches'] | OperationEvent['item'] extends infer T ? never : never) {
  return 'Lote';
}

function relatedBatchName(value: { name: string | null } | { name: string | null }[] | null | undefined) {
  const row = Array.isArray(value) ? value[0] : value;
  return row?.name || 'Publicação sem nome';
}

function itemHasDeletedMedia(item: AttentionItem) {
  return (item.publication_item_media ?? []).some((media) => {
    const asset = Array.isArray(media.media_assets) ? media.media_assets[0] : media.media_assets;
    return Boolean(asset?.deleted_at || asset?.status === 'deleted');
  });
}

function itemSeverity(item: AttentionItem): 'critical' | 'warning' | 'info' {
  if (item.status === 'failed' || item.status === 'removed' || itemHasDeletedMedia(item)) return 'critical';
  if (item.lease_until && Date.parse(item.lease_until) <= Date.now()) return 'critical';
  if (item.next_attempt_at && Date.parse(item.next_attempt_at) <= Date.now()) return 'warning';
  return 'info';
}

function eventTone(event: OperationEvent): 'critical' | 'warning' | 'success' | 'info' {
  if (event.event_type === 'failed' || event.error_message) return 'critical';
  if (event.event_type === 'processing_deferred' || event.event_type === 'retry_requested') return 'warning';
  if (event.event_type === 'published') return 'success';
  return 'info';
}

export default function OperationClient({
  activeOrganization,
  isSuperUser,
  profiles,
  zernioConnections,
  attentionItems,
  attentionPageInfo,
  events,
  eventPageInfo,
  healthRows,
  workerStatuses,
  asyncJobSummaries,
  operationalAlerts,
  publicationThroughput,
  slotRiskIncidents,
  workerCycles,
  dispatchTelemetry,
  dispatchTelemetryUnavailable,
  queueDiagnostics,
  initialClearActions,
}: {
  activeOrganization: Organization;
  isSuperUser: boolean;
  profiles: Profile[];
  zernioConnections: ZernioConnection[];
  attentionItems: AttentionItem[];
  attentionPageInfo: { hasMore: boolean; nextCursor: AttentionCursor | null };
  events: OperationEvent[];
  eventPageInfo: { hasMore: boolean; nextCursor: EventCursor | null };
  healthRows: HealthRow[];
  workerStatuses: WorkerStatusRow[];
  asyncJobSummaries: AsyncJobSummaryRow[];
  operationalAlerts: OperationalAlertRow[];
  publicationThroughput: PublicationThroughputRow[];
  slotRiskIncidents: SlotRiskIncidentRow[];
  workerCycles: WorkerCycleRow[];
  dispatchTelemetry: PublicationDispatchTelemetry | null;
  dispatchTelemetryUnavailable: boolean;
  queueDiagnostics: QueueDiagnostics;
  initialClearActions: { attention_items: string | null; publication_events: string | null };
}) {
  // A limpeza é apenas uma preferência de visualização pessoal: qualquer membro
  // pode ocultar os registros antigos sem afetar a fila ou o histórico da organização.
  const canManage = ['admin', 'operator'].includes(activeOrganization.role);
  const canClearLogs = true;
  const [items, setItems] = useState(attentionItems);
  const [itemCursor, setItemCursor] = useState(attentionPageInfo.nextCursor);
  const [itemHasMore, setItemHasMore] = useState(attentionPageInfo.hasMore);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [operationEvents, setOperationEvents] = useState(events);
  const [eventCursor, setEventCursor] = useState(eventPageInfo.nextCursor);
  const [eventHasMore, setEventHasMore] = useState(eventPageInfo.hasMore);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [actionId, setActionId] = useState<string | null>(null);
  const [clearActions, setClearActions] = useState(initialClearActions);
  const [zernioSearch, setZernioSearch] = useState('');
  const [eventProfileSearch, setEventProfileSearch] = useState('');

  const operationalProfiles = profiles.filter((profile) => profile.status === 'online').length;
  const reconnectProfiles = profiles.filter((profile) => profile.status === 'reauthorization_required' || profile.status === 'offline');
  const zernioProblems = zernioConnections.filter((connection) => connection.status !== 'online' || connection.last_error_message);
  const failedItems = items.filter((item) => item.status === 'failed' || item.status === 'removed' || itemHasDeletedMedia(item));
  const staleWorkers = workerStatuses.filter((worker) => worker.is_stale || worker.status === 'error');
  const activeWorkers = workerStatuses.filter((worker) => !worker.is_stale && !['stopped', 'error'].includes(worker.status));
  const asyncJobTotals = asyncJobSummaries.reduce((totals, row) => {
    totals.jobs += row.total;
    totals.pendingUnits += row.pending_units;
    totals.failedUnits += row.failed_units;
    return totals;
  }, { jobs: 0, pendingUnits: 0, failedUnits: 0 });
  const throughputLastHour = publicationThroughput.find((row) => row.window_label === '1h');
  const throughputLastDay = publicationThroughput.find((row) => row.window_label === '24h');
  const activeSlotRiskCount = slotRiskIncidents.filter((incident) => incident.state === 'at_risk').length;
  const dispatchErrorCount = dispatchTelemetry?.errors.reduce((total, error) => total + error.total, 0) ?? 0;
  const visibleItems = clearActions.attention_items
    ? items.filter((item) => Date.parse(item.updated_at) > Date.parse(clearActions.attention_items!))
    : items;
  const visibleOperationEvents = clearActions.publication_events
    ? operationEvents.filter((event) => Date.parse(event.created_at) > Date.parse(clearActions.publication_events!))
    : operationEvents;
  const filteredZernioConnections = useMemo(() => {
    const query = normalizedSearchValue(zernioSearch);
    return zernioConnections.filter((connection) => normalizedSearchValue(connection.label).includes(query));
  }, [zernioConnections, zernioSearch]);
  const displayedZernioConnections = filteredZernioConnections.slice(0, 10);
  const filteredOperationEvents = useMemo(() => (
    visibleOperationEvents.filter((event) => profileMatchesSearch(event.profile, eventProfileSearch))
  ), [eventProfileSearch, visibleOperationEvents]);

  const healthCounts = useMemo(() => Object.fromEntries(healthRows.map((row) => [row.status, row.total])), [healthRows]);
  const criticalAlertCount = operationalAlerts.filter((alert) => alert.severity === 'critical').reduce((total, alert) => total + alert.total, 0);
  const warningAlertCount = operationalAlerts.filter((alert) => alert.severity === 'warning').reduce((total, alert) => total + alert.total, 0);
  const criticalCount = failedItems.length + reconnectProfiles.length + zernioProblems.length + criticalAlertCount;

  function enrichAttentionItem(item: AttentionItemRow): AttentionItem {
    return { ...item, profile: profiles.find((profile) => profile.id === item.profile_id) ?? null };
  }

  function enrichEvent(event: OperationEventRow): OperationEvent {
    const item = Array.isArray(event.publication_items) ? event.publication_items[0] ?? null : event.publication_items;
    return {
      ...event,
      item,
      profile: profiles.find((profile) => profile.id === item?.profile_id) ?? null,
    };
  }

  async function loadMoreAttentionItems() {
    if (!itemHasMore || !itemCursor || itemsLoading) return;
    setItemsLoading(true);
    setMessage('');
    try {
      const params = new URLSearchParams({ limit: '80', cursorUpdatedAt: itemCursor.updatedAt, cursorId: itemCursor.id });
      const response = await fetch(`/api/operation-attention-items?${params.toString()}`, { cache: 'no-store' });
      const payload = await response.json() as { items?: AttentionItemRow[]; hasMore?: boolean; nextCursor?: AttentionCursor | null; error?: string };
      if (!response.ok || !payload.items) {
        setMessage(payload.error ?? 'Não foi possível carregar mais publicações com atenção.');
        return;
      }
      setItems((current) => [...current, ...payload.items!.map(enrichAttentionItem)]);
      setItemCursor(payload.nextCursor ?? null);
      setItemHasMore(Boolean(payload.hasMore));
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setItemsLoading(false);
    }
  }

  async function loadMoreEvents() {
    if (!eventHasMore || !eventCursor || eventsLoading) return;
    setEventsLoading(true);
    setMessage('');
    try {
      const params = new URLSearchParams({ limit: '80', cursorCreatedAt: eventCursor.createdAt, cursorId: eventCursor.id });
      const response = await fetch(`/api/operation-events?${params.toString()}`, { cache: 'no-store' });
      const payload = await response.json() as { events?: OperationEventRow[]; hasMore?: boolean; nextCursor?: EventCursor | null; error?: string };
      if (!response.ok || !payload.events) {
        setMessage(payload.error ?? 'Não foi possível carregar mais eventos.');
        return;
      }
      setOperationEvents((current) => [...current, ...payload.events!.map(enrichEvent)]);
      setEventCursor(payload.nextCursor ?? null);
      setEventHasMore(Boolean(payload.hasMore));
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setEventsLoading(false);
    }
  }

  async function handleItemAction(item: AttentionItem, action: 'retry' | 'cancel') {
    setMessage('');
    setActionId(`${item.id}:${action}`);
    try {
      const response = await fetch(`/api/publications/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json() as { item?: { status: string }; error?: string };
      if (!response.ok || !payload.item) {
        setMessage(payload.error ?? 'Não foi possível atualizar a publicação.');
        return;
      }
      setItems((current) => current.map((entry) => entry.id === item.id
        ? { ...entry, status: payload.item!.status, last_error_message: action === 'retry' ? null : entry.last_error_message }
        : entry));
      setMessage(action === 'retry' ? 'Publicação reenfileirada para reprocessamento.' : 'Publicação cancelada.');
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setActionId(null);
    }
  }

  async function changeLogVisibility(scope: 'attention_items' | 'publication_events', action: 'clear' | 'undo') {
    setMessage('');
    setActionId(`visibility:${scope}:${action}`);
    try {
      const response = await fetch('/api/operation-log-visibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, action }),
      });
      const payload = await response.json() as { cleared?: boolean; clearedAt?: string | null; error?: string };
      if (!response.ok) {
        setMessage(payload.error ?? 'Não foi possível alterar a visualização dos logs.');
        return;
      }
      setClearActions((current) => ({ ...current, [scope]: payload.cleared ? payload.clearedAt ?? new Date().toISOString() : null }));
      setMessage(action === 'clear'
        ? 'Itens ocultados somente desta visualização. O histórico original foi preservado.'
        : 'Visualização restaurada; o histórico original continua preservado.');
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setActionId(null);
    }
  }

  return <main className="standalone-page operation-page">
    <header className="standalone-header operation-hero">
      <div>
        <span className="section-kicker">{activeOrganization.name} · Status / Logs</span>
        <h1>Central operacional</h1>
        <p>Veja problemas reais da fila, integrações, perfis e eventos recentes em um único lugar.</p>
      </div>
      <div className="operation-header-actions">
          <Link className="button button-secondary" href="/queue">Abrir fila</Link>
          <Link className="button button-secondary" href="/operacao/adicoes-zernio">Histórico de adições</Link>
          <Link className="button button-secondary" href="/operacao/quedas-zernio">Quedas Zernio</Link>
        <Link className="button button-secondary" href="/perfis">Perfis</Link>
      </div>
    </header>

    {message && <p className="inline-message operation-notice" role="status">{message}</p>}

    <section className="operation-metrics operation-metrics-expanded">
      <article className={`metric-card ${criticalCount || activeSlotRiskCount ? 'operation-metric-danger' : ''}`}><span className="metric-label">Problemas críticos</span><strong>{criticalCount + activeSlotRiskCount}</strong><small className="metric-caption">Falhas, conexões e slots em risco</small></article>
      <article className="metric-card"><span className="metric-label">Perfis operacionais</span><strong>{operationalProfiles}/{profiles.length}</strong><small className="metric-caption">Meta oficial e Zernio</small></article>
      <article className="metric-card"><span className="metric-label">Fila ativa</span><strong>{queueDiagnostics.activeItems}</strong><small className="metric-caption">Atualizado {displayDate(queueDiagnostics.checkedAt)}</small></article>
      <article className={`metric-card ${queueDiagnostics.expiredLeases || queueDiagnostics.dueRetries ? 'operation-metric-warning' : ''}`}><span className="metric-label">Recuperações pendentes</span><strong>{queueDiagnostics.expiredLeases + queueDiagnostics.dueRetries + queueDiagnostics.overdue}</strong><small className="metric-caption">Leases, retries e atrasos</small></article>
      <article className="metric-card"><span className="metric-label">Zernio</span><strong>{zernioConnections.filter((connection) => connection.status === 'online').length}/{zernioConnections.length}</strong><small className="metric-caption">Contas API configuradas</small></article>
      {isSuperUser && <article className={`metric-card ${staleWorkers.length ? 'operation-metric-danger' : ''}`}><span className="metric-label">Workers ativos</span><strong>{activeWorkers.length}/{workerStatuses.length}</strong><small className="metric-caption">Heartbeats dedicados</small></article>}
      {isSuperUser && <article className={`metric-card ${operationalAlerts.length ? 'operation-metric-warning' : ''}`}><span className="metric-label">Alertas</span><strong>{operationalAlerts.length}</strong><small className="metric-caption">{criticalAlertCount} críticos · {warningAlertCount} avisos</small></article>}
      {isSuperUser && <article className="metric-card"><span className="metric-label">Vazão</span><strong>{throughputLastHour?.published_count ?? 0}/h</strong><small className="metric-caption">{throughputLastDay?.published_count ?? 0} publicadas em 24h</small></article>}
    </section>

    <section className="operation-health-grid">
      {isSuperUser && <article className="panel operation-health-card"><span className="section-kicker">Alertas automáticos</span><h2>Prioridade operacional</h2><div className="operation-list">{operationalAlerts.length === 0 ? <div className="operation-empty"><strong>Nenhum alerta ativo</strong><p>Workers, fila e jobs assíncronos estão dentro dos limites configurados.</p></div> : operationalAlerts.map((alert) => <article className={`operation-row ${alert.severity === 'critical' ? 'operation-row-warning' : 'operation-row-info'}`} key={alert.alert_kind}><span className={`status-dot status-dot-${alert.severity === 'critical' ? 'warning' : 'neutral'}`} /><div><strong>{alert.title}</strong><small>{alert.detail}</small><em>Total: {alert.total}</em></div></article>)}</div></article>}
      {isSuperUser && <article className="panel operation-health-card"><span className="section-kicker">Throughput</span><h2>Vazão real de publicação</h2><div className="operation-health-chips">{publicationThroughput.map((row) => <span className={`queue-status-chip ${row.failed_count ? 'queue-status-failed' : 'queue-status-published'}`} key={row.window_label}>{throughputWindowLabel(row.window_label)}: {row.published_count} publicadas · {row.failed_count} falhas</span>)}</div><dl className="operation-health-list"><div><dt>Perfis únicos em 24h</dt><dd>{throughputLastDay?.unique_profiles ?? 0}</dd></div><div><dt>Atraso médio em 24h</dt><dd>{compactDuration(throughputLastDay?.average_publish_lag_seconds ?? 0)}</dd></div><div><dt>Atraso máx. em 24h</dt><dd>{compactDuration(throughputLastDay?.max_publish_lag_seconds ?? 0)}</dd></div></dl></article>}
      <article className="panel operation-health-card"><span className="section-kicker">Saúde da fila</span><h2>Estados atuais</h2><div className="operation-health-chips">{['waiting', 'ready', 'preparing', 'publishing', 'failed'].map((status) => <span key={status} className={`queue-status-chip queue-status-${status}`}>{statusLabel(status)}: {healthCounts[status] ?? 0}</span>)}</div></article>
      <article className="panel operation-health-card"><span className="section-kicker">Sinais de travamento</span><h2>Fila que exige ação</h2><dl className="operation-health-list"><div><dt>Leases expirados</dt><dd>{queueDiagnostics.expiredLeases}</dd></div><div><dt>Retentativas vencidas</dt><dd>{queueDiagnostics.dueRetries}</dd></div><div><dt>Agendados atrasados</dt><dd>{queueDiagnostics.overdue}</dd></div></dl></article>
      {isSuperUser && <article className="panel operation-health-card"><span className="section-kicker">Workers dedicados</span><h2>Batimentos recentes</h2><div className="operation-list">{workerStatuses.length === 0 ? <div className="operation-empty"><strong>Nenhum worker registrado</strong><p>Os processos da VPS aparecerão aqui após enviarem heartbeat.</p></div> : workerStatuses.slice(0, 8).map((worker) => <article className={`operation-row ${worker.is_stale || worker.status === 'error' ? 'operation-row-warning' : 'operation-row-info'}`} key={worker.worker_id}><span className={`status-dot status-dot-${worker.is_stale || worker.status === 'error' ? 'warning' : 'positive'}`} /><div><strong>{workerKindLabel(worker.worker_kind)} · {worker.worker_id}</strong><small>{statusLabel(worker.status)}{worker.dry_run ? ' · dry-run' : ''} · visto há {compactDuration(worker.seconds_since_seen)}</small><small>{worker.hostname ?? 'host desconhecido'}{worker.process_id ? ` · PID ${worker.process_id}` : ''}</small>{worker.last_error_message && <em>{worker.last_error_message}</em>}</div></article>)}</div></article>}
      {isSuperUser && <article className="panel operation-health-card"><span className="section-kicker">Jobs assíncronos</span><h2>Backlog pesado</h2><dl className="operation-health-list"><div><dt>Jobs abertos</dt><dd>{asyncJobTotals.jobs}</dd></div><div><dt>Unidades pendentes</dt><dd>{asyncJobTotals.pendingUnits}</dd></div><div><dt>Falhas em jobs</dt><dd>{asyncJobTotals.failedUnits}</dd></div></dl><div className="operation-health-chips">{asyncJobSummaries.length === 0 ? <span className="queue-status-chip">Sem jobs pesados abertos</span> : asyncJobSummaries.map((row) => <span className={`queue-status-chip queue-status-${row.status}`} key={`${row.job_kind}:${row.status}`}>{asyncJobKindLabel(row.job_kind)} · {statusLabel(row.status)}: {row.total}</span>)}</div></article>}
      <article className="panel operation-health-card"><span className="section-kicker">Slots coletivos</span><h2>Recuperação segura</h2><div className="operation-list">{slotRiskIncidents.length === 0 ? <div className="operation-empty"><strong>Nenhum slot em risco</strong><p>Não há lotes coletivos aguardando decisão de recuperação.</p></div> : slotRiskIncidents.slice(0, 6).map((incident) => <article className={`operation-row ${incident.state === 'at_risk' ? 'operation-row-warning' : 'operation-row-info'}`} key={incident.id}><span className={`status-dot status-dot-${incident.state === 'at_risk' ? 'warning' : 'positive'}`} /><div><strong>{incident.batch_name}</strong><small>{incident.affected_item_count} publicação(ões) · atraso de {compactDuration(incident.overdue_seconds)}</small><small>Slot: {displayDate(incident.slot_execute_at)}{incident.next_slot_execute_at ? ` · próximo: ${displayDate(incident.next_slot_execute_at)}` : ''}</small><em>{incident.state === 'at_risk' ? 'Em risco — aguardando recuperação coordenada.' : incident.decision_reason}</em></div></article>)}</div></article>
       {isSuperUser && <article className="panel operation-health-card"><span className="section-kicker">Ciclos do worker</span><h2>Telemetria histórica</h2><div className="operation-list">{workerCycles.length === 0 ? <div className="operation-empty"><strong>Aguardando ciclos registrados</strong><p>Os novos ciclos aparecerão aqui após a instrumentação enviar eventos.</p></div> : workerCycles.slice(0, 8).map((cycle) => <article className={`operation-row ${cycle.phase === 'failed' ? 'operation-row-warning' : 'operation-row-info'}`} key={`${cycle.worker_id}:${cycle.created_at}:${cycle.phase}`}><span className={`status-dot status-dot-${cycle.phase === 'failed' ? 'warning' : cycle.phase === 'completed' ? 'positive' : 'neutral'}`} /><div><strong>{cycle.worker_id} · {cycle.phase === 'completed' ? 'concluído' : cycle.phase === 'failed' ? 'falhou' : 'iniciado'}</strong><small>{displayDate(cycle.started_at)} · {compactMilliseconds(cycle.duration_ms)}</small>{cycle.error_message && <em>{cycle.error_code ? `${cycle.error_code}: ` : ''}{cycle.error_message}</em>}</div></article>)}</div></article>}
      {isSuperUser && <article className="panel operation-health-card"><span className="section-kicker">Relatório agregado · 24 horas</span><h2>Capacidade, adiamentos e erros</h2>{!dispatchTelemetry ? <div className="operation-empty"><strong>{dispatchTelemetryUnavailable ? 'Telemetria temporariamente indisponível' : 'Telemetria aguardando migration'}</strong><p>{dispatchTelemetryUnavailable ? 'Os demais dados operacionais continuam disponíveis. Tente atualizar o relatório em alguns instantes.' : 'O relatório aparecerá após a migration operacional ser aplicada.'}</p></div> : <><dl className="operation-health-list"><div><dt>Claims em ciclos</dt><dd>{dispatchTelemetry.cycles.claimed_count}</dd></div><div><dt>Duração p95 de ciclo</dt><dd>{compactMilliseconds(dispatchTelemetry.cycles.cycle_duration_p95_ms)}</dd></div><div><dt>Adiadas por capacidade</dt><dd>{dispatchTelemetry.cycles.rate_limited_count}</dd></div><div><dt>Erros agrupados</dt><dd>{dispatchErrorCount}</dd></div></dl><div className="operation-health-chips">{dispatchTelemetry.providers.length === 0 ? <span className="queue-status-chip">Sem tentativas concluídas na janela</span> : dispatchTelemetry.providers.map((provider) => <span className={`queue-status-chip ${provider.failed_count ? 'queue-status-failed' : 'queue-status-published'}`} key={provider.provider}>{providerLabel(provider.provider as Provider)}: {provider.published_count} publicadas · {provider.failed_count} falhas · p95 {compactDuration(provider.publish_lag_p95_seconds)}</span>)}</div>{dispatchTelemetry.alerts.length > 0 && <div className="operation-list">{dispatchTelemetry.alerts.map((alert) => <article className={`operation-row ${alert.severity === 'critical' ? 'operation-row-warning' : 'operation-row-info'}`} key={alert.kind}><span className={`status-dot status-dot-${alert.severity === 'critical' ? 'warning' : 'neutral'}`} /><div><strong>{alert.title}</strong><small>{alert.detail}</small><em>Total: {alert.total}</em></div></article>)}</div>}</>}</article>}
      {isSuperUser && <article className="panel operation-health-card"><span className="section-kicker">Erros agrupados · 24 horas</span><h2>Sem log por publicação</h2><div className="operation-list">{!dispatchTelemetry || dispatchTelemetry.errors.length === 0 ? <div className="operation-empty"><strong>Nenhum erro agrupado na janela</strong><p>Falhas futuras serão consolidadas por provedor e código, sem criar telemetria detalhada por postagem.</p></div> : dispatchTelemetry.errors.slice(0, 8).map((error) => <article className="operation-row operation-row-warning" key={`${error.provider}:${error.error_code}`}><span className="status-dot status-dot-warning" /><div><strong>{providerLabel(error.provider as Provider)} · {error.error_code}</strong><small>{error.total} ocorrência(s) · última: {displayDate(error.last_seen_at)}</small><em>{error.latest_message}</em></div></article>)}</div></article>}
    </section>

    <section className="operation-problems-grid">
      <section className="panel operation-panel-large">
        <div className="panel-heading"><div><span className="section-kicker">Publicações com atenção</span><h2>Falhas, removidas e processamentos abertos</h2><p>Itens com erro, mídia apagada, lease vencido ou publicação em andamento.</p></div><div className="operation-row-actions">{canClearLogs && <button type="button" className="button button-ghost" onClick={() => void changeLogVisibility('attention_items', clearActions.attention_items ? 'undo' : 'clear')} disabled={actionId?.startsWith('visibility:attention_items:')}>{clearActions.attention_items ? 'Restaurar visualização' : 'Limpar logs'}</button>}<span className="queue-count">{visibleItems.length} item(ns){itemHasMore ? '+' : ''}</span></div></div>
        <div className="operation-list operation-issue-list">
          {visibleItems.length === 0 ? <div className="operation-empty"><strong>{clearActions.attention_items ? 'Itens anteriores ocultados' : 'Nenhuma publicação com atenção'}</strong><p>{clearActions.attention_items ? `Ocultados até ${displayDate(clearActions.attention_items)} apenas para você. Itens atualizados depois desse momento continuarão aparecendo; fila e histórico não foram alterados.` : 'Falhas, itens travados e mídia removida aparecerão aqui.'}</p></div> : visibleItems.map((item) => {
            const severity = itemSeverity(item);
            const canRetry = item.status === 'failed' && item.attempt_count < PUBLICATION_MAX_ATTEMPTS;
            const canCancel = ['waiting', 'ready', 'preparing', 'publishing', 'failed'].includes(item.status);
            return <article className={`operation-row operation-row-${severity}`} key={item.id}>
              <span className={`status-dot status-dot-${severity === 'critical' ? 'warning' : severity === 'warning' ? 'neutral' : 'positive'}`} />
              <div>
                <strong>{relatedBatchName(item.publication_batches)} · @{item.profile?.username ?? 'perfil'} · {formatLabels[item.format] ?? item.format}</strong>
                <div className="operation-row-meta"><span className={`queue-provider-badge queue-provider-${item.profile?.provider ?? 'meta_official'}`}>{providerLabel(item.profile?.provider)}</span><span>{providerDetail(item.profile)}</span></div>
                <small>Status: {statusLabel(item.status)} · Atualizado {displayDate(item.updated_at)} · Tentativa {item.attempt_count} de {PUBLICATION_MAX_ATTEMPTS}</small>
                {item.execute_at && <small>Execução: {displayDate(item.execute_at)}</small>}
                {item.lease_until && <small>Lease: {displayDate(item.lease_until)}{Date.parse(item.lease_until) <= Date.now() ? ' · vencido' : ''}</small>}
                {item.next_attempt_at && <small>Próxima tentativa: {displayDate(item.next_attempt_at)}</small>}
                {(item.last_error_message || itemHasDeletedMedia(item)) && <em>{item.last_error_code ? `${item.last_error_code}: ` : ''}{itemHasDeletedMedia(item) ? 'Mídia apagada vinculada ao item.' : item.last_error_message}</em>}
              </div>
              <div className="operation-row-actions">
                  <Link className="row-link" href="/queue">Abrir</Link>
                {canManage && canRetry && <button type="button" onClick={() => void handleItemAction(item, 'retry')} disabled={actionId === `${item.id}:retry`}>Reprocessar</button>}
                {canManage && canCancel && <button type="button" className="danger-action" onClick={() => void handleItemAction(item, 'cancel')} disabled={actionId === `${item.id}:cancel`}>Cancelar</button>}
              </div>
            </article>;
          })}
        </div>
        {itemHasMore && <div className="queue-load-more"><button type="button" className="button button-ghost" onClick={() => void loadMoreAttentionItems()} disabled={itemsLoading} aria-busy={itemsLoading}>{itemsLoading ? 'Carregando…' : 'Ver mais itens com atenção'}</button></div>}
      </section>

      <aside className="operation-side-stack">
        <section className="panel"><div className="panel-heading"><div><span className="section-kicker">Conexões</span><h2>Perfis que exigem atenção</h2></div><span className="queue-count">{reconnectProfiles.length}</span></div><div className="operation-list">{reconnectProfiles.length === 0 ? <div className="operation-empty"><strong>Perfis saudáveis</strong><p>Nenhuma reconexão pendente.</p></div> : reconnectProfiles.map((profile) => <article className="operation-row operation-row-warning" key={profile.id}><span className="status-dot status-dot-warning" /><div><strong>@{profile.username}</strong><div className="operation-row-meta"><span className={`queue-provider-badge queue-provider-${profile.provider}`}>{providerLabel(profile.provider)}</span><span>{providerDetail(profile)}</span></div><small>Última verificação: {displayDate(profile.last_checked_at)}</small>{profile.last_error_message && <em>{profile.last_error_code ? `${profile.last_error_code}: ` : ''}{profile.last_error_message}</em>}</div><Link className="row-link" href={profile.provider === 'zernio' ? `/api/integrations/zernio/start?returnTo=%2Fperfis${profile.zernio_connection_id ? `&connectionId=${encodeURIComponent(profile.zernio_connection_id)}` : ''}` : '/api/integrations/meta/start?returnTo=%2Fperfis'}>Reconectar</Link></article>)}</div></section>
        <section className="panel"><div className="panel-heading"><div><span className="section-kicker">Zernio</span><h2>Contas API</h2></div><Link className="row-link" href="/zernio">Abrir Zernio</Link></div>{zernioConnections.length > 0 && <><label className="operation-search"><span className="visually-hidden">Buscar conta API</span><input type="search" value={zernioSearch} onChange={(event) => setZernioSearch(event.target.value)} placeholder="Buscar conta API" aria-label="Buscar conta API" /></label><p className="operation-search-summary" aria-live="polite">Exibindo {displayedZernioConnections.length} de {filteredZernioConnections.length} conta(s){filteredZernioConnections.length > 10 ? ' encontradas' : ''}.</p></>}<div className="operation-list">{zernioConnections.length === 0 ? <div className="operation-empty"><strong>Nenhuma conta Zernio</strong><p>As contas aparecerão aqui quando configuradas.</p></div> : displayedZernioConnections.length === 0 ? <div className="operation-empty"><strong>Nenhuma conta encontrada</strong><p>Tente buscar por outro nome de conta API.</p></div> : displayedZernioConnections.map((connection) => <article className={`operation-row ${connection.status === 'online' && !connection.last_error_message ? 'operation-row-info' : 'operation-row-warning'}`} key={connection.id}><span className={`status-dot status-dot-${connection.status === 'online' ? 'positive' : 'warning'}`} /><div><strong>{connection.label}</strong><small>{statusLabel(connection.status)} · {connection.instagram_profile_count ?? 0} perfil(is) · Saldo {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: connection.balance_currency ?? 'USD' }).format((connection.balance_cents ?? 0) / 100)}</small><small>Sync: {displayDate(connection.last_sync_at)} · Health: {displayDate(connection.last_checked_at)}</small>{connection.last_error_message && <em>{connection.last_error_message}</em>}</div><Link className="row-link" href="/zernio">Ver</Link></article>)}</div></section>
      </aside>
    </section>

    <section className="panel operation-events-panel">
      <div className="panel-heading"><div><span className="section-kicker">Logs recentes</span><h2>Eventos de publicação</h2><p>Histórico real registrado pela fila: falhas, retries, publicação, cancelamento e adiamentos.</p></div><div className="operation-row-actions">{canClearLogs && <button type="button" className="button button-ghost" onClick={() => void changeLogVisibility('publication_events', clearActions.publication_events ? 'undo' : 'clear')} disabled={actionId?.startsWith('visibility:publication_events:')}>{clearActions.publication_events ? 'Restaurar visualização' : 'Limpar logs'}</button>}<span className="queue-count">{filteredOperationEvents.length} eventos{eventHasMore ? '+' : ''}</span></div></div>
      <label className="operation-search operation-event-search"><span className="visually-hidden">Buscar eventos por perfil</span><input type="search" value={eventProfileSearch} onChange={(event) => setEventProfileSearch(event.target.value)} placeholder="Buscar eventos por @usuário ou nome do perfil" aria-label="Buscar eventos por perfil" /></label>
      <div className="operation-event-list">{filteredOperationEvents.length === 0 ? <div className="operation-empty"><strong>{eventProfileSearch ? 'Nenhum evento para o perfil buscado' : clearActions.publication_events ? 'Eventos anteriores ocultados' : 'Nenhum evento recente'}</strong><p>{eventProfileSearch ? 'A busca é atualizada enquanto você digita e considera o usuário e o nome do perfil.' : clearActions.publication_events ? `Ocultados até ${displayDate(clearActions.publication_events)} apenas para você. Eventos novos continuarão aparecendo; o histórico original foi preservado.` : 'Quando a fila processar publicações, os eventos aparecerão aqui.'}</p></div> : filteredOperationEvents.map((event) => <article className={`operation-event operation-event-${eventTone(event)}`} key={event.id}><div><span className={`timeline-event timeline-${event.event_type}`}>{statusLabel(event.event_type)}</span><strong>{relatedBatchName(event.item?.publication_batches)} · @{event.profile?.username ?? 'perfil'} · {formatLabels[event.item?.format ?? ''] ?? event.item?.format ?? 'Formato'}</strong><div className="operation-row-meta"><span className={`queue-provider-badge queue-provider-${event.profile?.provider ?? 'meta_official'}`}>{providerLabel(event.profile?.provider)}</span><span>{event.actor_label ? `Por ${event.actor_label}` : providerDetail(event.profile)}</span></div>{(event.error_code || event.error_message) && <em>{event.error_code ? `${event.error_code}: ` : ''}{event.error_message}</em>}</div><time dateTime={event.created_at}>{displayDate(event.created_at)}</time></article>)}</div>
      {eventHasMore && <div className="queue-load-more"><button type="button" className="button button-ghost" onClick={() => void loadMoreEvents()} disabled={eventsLoading} aria-busy={eventsLoading}>{eventsLoading ? 'Carregando…' : 'Ver mais eventos'}</button></div>}
    </section>
  </main>;
}
