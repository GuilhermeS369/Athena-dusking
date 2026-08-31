'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import styles from './profiles-catalog.module.css';
import { buildBulkZernioRows, resolveZernioBulkTarget, sortZernioConnectionsByProfileCount } from '@/lib/integrations/zernio-bulk';
import {
  EMPTY_PROFILE_SELECTION,
  MAX_BULK_PROFILE_DELETE,
  MAX_FILTER_PROFILE_DELETE,
  buildBulkDeleteRequest,
  clearProfileSelection,
  describeRemovalResult,
  isBulkDeleteConfirmed,
  isProfileSelected,
  profileSelectionCount,
  selectAllMatchingFilter,
  toggleProfileSelection,
  toggleVisibleProfiles,
  visibleSelectionState,
  type ProfileRemovalPreview,
  type ProfileSelectionState,
} from '@/lib/profiles/bulk-removal';
import type {
  InstagramProfileAnalyticsSummary,
  InstagramProfileCatalogItem,
  InstagramProfileSort,
  InstagramProfilesCatalogPage,
} from '@/lib/profiles/catalog';
import { ProfilePublicationMetrics, emptyPublicationFormatCounts } from '@/lib/publications/composer';

type Organization = {
  id: string;
  name: string;
  role: 'admin' | 'operator' | 'viewer';
};

type Profile = InstagramProfileCatalogItem;
type ProfileAnalyticsSummary = InstagramProfileAnalyticsSummary;

type Group = {
  id: string;
  name: string;
};

type ConnectionResult = {
  connected?: string;
  error?: string;
  diagnostic?: string;
  synced?: string;
  analyticsJobId?: string;
  analyticsJobTotal?: string;
  groupAssignment?: string;
  groupName?: string;
  groupAssignmentError?: string;
  zernioFallbackConnection?: string;
  zernioConnectionId?: string;
  zernioHttpStatus?: string;
  zernioErrorCode?: string;
  zernioErrorReason?: string;
};

type ZernioSyncPayload = {
  error?: string;
  synced?: number;
  refreshJob?: RefreshJobSummary | null;
};
type ZernioOrganizationSyncPayload = {
  error?: string;
  status?: 'queued' | 'already_running';
  batchId?: string;
  totalConnections?: number;
};
type ZernioOrganizationSyncProgress = {
  id: string;
  status: 'processing' | 'completed' | 'completed_with_errors' | 'failed';
  totalConnections: number;
  processedConnections: number;
  processingConnections: number;
  synced: number;
  conflicts: number;
  failures: number;
  completedAt: string | null;
};

type RemovalProgress = {
  pending: number;
  done: number;
  failed: number;
  total: number;
  failures: Array<{ id: string; username_snapshot: string; connection_label_snapshot: string | null; error_message: string | null }>;
};

type RefreshJobSummary = { job_id: string; status: string; total_count: number; reused: boolean; reason: string };
type RefreshJobStatus = { id: string; status: string; total_count: number; processed_count: number; synced_count: number; partial_count: number; no_data_count: number; skipped_count: number; failed_count: number; retry_pending_count: number; dead_letter_count: number; last_error_message: string | null };

type ZernioConnection = {
  id: string;
  label: string;
  status: 'no_data' | 'online' | 'offline' | 'reauthorization_required' | null;
  balance_cents: number | null;
  balance_currency: string | null;
  instagram_profile_count: number | null;
  instagram_slot_limit: number | null;
  remote_instagram_account_count: number | null;
  remote_inventory_checked_at: string | null;
  remote_inventory_error_code: string | null;
  remote_inventory_error_message: string | null;
  active_slot_reservation_count: number | null;
  last_checked_at: string | null;
  last_sync_at: string | null;
  last_error_message: string | null;
  created_at: string;
};

type AuthMirrorLinkState = {
  active: boolean;
  activatedAt: string | null;
  createdByEmail: string | null;
  lastUsedAt: string | null;
  useCount: number;
};

const PROFILES_VIEW_STORAGE_KEY = 'athena:perfis:view';

const profileStatusLabels: Record<Profile['status'], string> = {
  online: 'Online',
  offline: 'Offline',
  reauthorization_required: 'Reautorizar',
  no_data: 'Sem dados',
};

const connectionErrorMessage: Record<string, string> = {
  configuration: 'A conexão não está configurada corretamente no servidor.',
  forbidden: 'Seu perfil não tem permissão para conectar contas.',
  invalid_state: 'A conexão expirou ou foi aberta em outra sessão. Tente novamente.',
  oauth_denied: 'A autorização no Instagram foi cancelada ou negada.',
  oauth_callback_failed: 'O Instagram retornou, mas não foi possível concluir a conexão.',
  organization_forbidden: 'Você não tem mais acesso à organização usada na conexão.',
  profile_lookup_failed: 'Não foi possível identificar o perfil profissional autorizado no Instagram.',
  profile_save_failed: 'O perfil foi identificado, mas não pôde ser salvo. Tente novamente ou contate o suporte.',
  session_changed: 'Sua sessão mudou durante a conexão. Entre novamente e tente conectar o perfil.',
  token_exchange_failed: 'Não foi possível validar a autorização recebida do Instagram.',
  zernio_callback_failed: 'A autorização voltou da Zernio, mas esta solicitação não pôde ser validada. Gere uma nova linha no Bulk Zernio e tente novamente neste aparelho.',
  zernio_connect_failed: 'Não foi possível iniciar o fluxo de conexão da Zernio.',
  zernio_connection_required: 'Selecione uma conta Zernio salva antes de conectar ou sincronizar perfis.',
  zernio_group_not_found: 'O grupo selecionado não existe mais. Gere novamente a lista no Bulk Zernio.',
  zernio_not_configured: 'Configure a chave Zernio desta conta antes de conectar perfis por esse provedor.',
  zernio_plan_limit: 'A Zernio recusou uma nova conexão porque a chave exige capacidade de cobrança ou forma de pagamento adicional.',
  zernio_no_available_slot: 'Nenhuma chave Zernio possui slot livre agora. Aguarde a outra conexão terminar ou adicione capacidade em uma chave Zernio.',
  zernio_intent_in_progress: 'Esta solicitação específica já está aberta. Cada outra linha do Bulk Zernio continua independente.',
  zernio_intent_failed: 'Esta solicitação específica terminou com falha. Gere uma nova linha no Bulk Zernio para tentar novamente.',
};

function formatDate(value: string | null) {
  if (!value) return 'Ainda não verificado';

  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatRelativeTime(value: string | null | undefined) {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '—';

  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 90) return 'agora';
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}min`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 60) return `${diffDays}d`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths}m`;
}

function formatConnectedAgo(value: string | null | undefined) {
  const relative = formatRelativeTime(value);
  return relative === '—' ? '—' : relative;
}

function formatBulkRefreshTime(value: string | null) {
  if (!value) return '';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '';

  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function formatExpiration(value: string | null | undefined) {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '—';
  const diffDays = Math.ceil((timestamp - Date.now()) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return 'expirou';
  if (diffDays === 0) return 'hoje';
  return `${diffDays}d`;
}

function formatCompactNumber(value: number | null | undefined) {
  return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(value ?? 0);
}

function instagramProfileUrl(username: string) {
  const normalizedUsername = username.replace(/^@+/, '');
  return `https://www.instagram.com/${encodeURIComponent(normalizedUsername)}/`;
}

function formatZernioSyncMessage(payload: ZernioSyncPayload) {
  const refreshJob = payload.refreshJob;
  const base = `Sincronização concluída: ${payload.synced ?? 0} conta(s) Instagram.`;
  if (!refreshJob) return base;
  if (refreshJob.reason === 'active_job') return `${base} Atualização de métricas já estava em andamento (${refreshJob.total_count} perfil(is)).`;
  if (refreshJob.reason === 'nothing_stale') return `${base} Métricas já estão dentro do cache.`;
  return `${base} Atualização de métricas enfileirada para ${refreshJob.total_count} perfil(is).`;
}

function publicationMetricsFromSummary(summary: ProfileAnalyticsSummary | undefined): ProfilePublicationMetrics {
  if (!summary) return { scheduled: emptyPublicationFormatCounts(), published: emptyPublicationFormatCounts() };
  return {
    scheduled: {
      total: summary.scheduled_total ?? 0,
      reel: summary.scheduled_reel ?? 0,
      story: summary.scheduled_story ?? 0,
      image: summary.scheduled_image ?? 0,
      carousel: summary.scheduled_carousel ?? 0,
    },
    published: {
      total: summary.published_total ?? 0,
      reel: summary.published_reel ?? 0,
      story: summary.published_story ?? 0,
      image: summary.published_image ?? 0,
      carousel: summary.published_carousel ?? 0,
    },
  };
}

function ProfileAvatar({ profile }: { profile: Profile }) {
  const [failed, setFailed] = useState(false);
  const initial = profile.username.trim().charAt(0).toUpperCase() || '@';

  if (profile.profile_picture_url && !failed) {
    return (
      <span className={`profile-avatar-frame profile-avatar-frame-${profile.status}`}>
        <Image
          className="profile-avatar"
          src={profile.profile_picture_url}
          alt={`Foto de @${profile.username}`}
          width={52}
          height={52}
          sizes="52px"
          loading="lazy"
          onError={() => setFailed(true)}
        />
        <span className="profile-avatar-online-dot" aria-hidden="true" />
      </span>
    );
  }

  return (
    <span className={`profile-avatar-frame profile-avatar-frame-${profile.status}`}>
      <span className="profile-avatar profile-avatar-fallback" aria-hidden="true">{initial}</span>
      <span className="profile-avatar-online-dot" aria-hidden="true" />
    </span>
  );
}

function SyncIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M16.4 7.2A6.6 6.6 0 0 0 4.1 5.6L2.6 7.1" />
      <path d="M2.6 3.5v3.6h3.6" />
      <path d="M3.6 12.8a6.6 6.6 0 0 0 12.3 1.6l1.5-1.5" />
      <path d="M17.4 16.5v-3.6h-3.6" />
    </svg>
  );
}

function TrashIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M3.8 5.6h12.4" />
      <path d="M8 5.6V4.2c0-.7.5-1.2 1.2-1.2h1.6c.7 0 1.2.5 1.2 1.2v1.4" />
      <path d="M5.7 5.6l.6 10c.1.8.7 1.4 1.5 1.4h4.4c.8 0 1.5-.6 1.5-1.4l.6-10" />
      <path d="M8.6 8.8v5" />
      <path d="M11.4 8.8v5" />
    </svg>
  );
}

function formatDiagnostic(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

const publicationFormatLabels: Array<{
  key: Exclude<keyof ProfilePublicationMetrics['scheduled'], 'total'>;
  label: string;
  shortLabel: string;
}> = [
  { key: 'reel', label: 'Reels', shortLabel: 'R' },
  { key: 'story', label: 'Stories', shortLabel: 'S' },
  { key: 'image', label: 'Imagens', shortLabel: 'I' },
  { key: 'carousel', label: 'Carrosséis', shortLabel: 'C' },
];

function PublicationMetricBreakdown({
  title,
  metrics,
  tone,
}: {
  title: string;
  metrics: ProfilePublicationMetrics['scheduled'];
  tone: 'scheduled' | 'published';
}) {
  return (
    <section className={`profile-publication-metric profile-publication-metric-${tone}`} aria-label={`${title}: ${metrics.total} no total`}>
      <div className="profile-publication-metric-heading">
        <span>{title}</span>
        <strong>{metrics.total}</strong>
      </div>
      <ul className="profile-publication-format-list">
        {publicationFormatLabels.map((format) => (
          <li key={format.key} title={format.label}>
            <span aria-hidden="true">{format.shortLabel}</span>
            <span className="profile-publication-format-label">{format.label}</span>
            <strong>{metrics[format.key]}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function ProfilesClient({
  activeOrganization,
  initialCatalog,
  groups,
  zernioConnections: initialZernioConnections,
  authMirrorLink: initialAuthMirrorLink,
  connectionResult,
}: {
  activeOrganization: Organization;
  initialCatalog: InstagramProfilesCatalogPage;
  groups: Group[];
  zernioConnections: ZernioConnection[];
  authMirrorLink: AuthMirrorLinkState;
  connectionResult: ConnectionResult;
}) {
  const canManage = ['admin', 'operator'].includes(activeOrganization.role);
  const [catalog, setCatalog] = useState(initialCatalog);
  const profiles = catalog.items;
  const [checkingProfileId, setCheckingProfileId] = useState<string | null>(null);
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);
  const [deleteChoiceProfile, setDeleteChoiceProfile] = useState<Profile | null>(null);
  const [syncingZernio, setSyncingZernio] = useState(false);
  const [activeZernioSyncBatchId, setActiveZernioSyncBatchId] = useState<string | null>(null);
  const [zernioSyncBatchProgress, setZernioSyncBatchProgress] = useState<ZernioOrganizationSyncProgress | null>(null);
  const [activeRefreshJobId, setActiveRefreshJobId] = useState<string | null>(connectionResult.analyticsJobId ?? null);
  const [zernioConnections, setZernioConnections] = useState(() => sortZernioConnectionsByProfileCount(initialZernioConnections));
  const [selectedZernioConnectionId, setSelectedZernioConnectionId] = useState(() => sortZernioConnectionsByProfileCount(initialZernioConnections)[0]?.id ?? '');
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [bulkZernioModalOpen, setBulkZernioModalOpen] = useState(false);
  const [pastedZernioLabel, setPastedZernioLabel] = useState('');
  const [pastedZernioIntentKey, setPastedZernioIntentKey] = useState('');
  const [manualZernioIntentKey, setManualZernioIntentKey] = useState('');
  const [bulkZernioQuantity, setBulkZernioQuantity] = useState(10);
  const [bulkZernioGroupId, setBulkZernioGroupId] = useState('none');
  const [bulkZernioCopyMessage, setBulkZernioCopyMessage] = useState('');
  const [bulkZernioRefreshing, setBulkZernioRefreshing] = useState(false);
  const [bulkZernioLastRefreshAt, setBulkZernioLastRefreshAt] = useState<string | null>(null);
  const [bulkZernioRefreshMessage, setBulkZernioRefreshMessage] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState('all');
  const [selectedStatus, setSelectedStatus] = useState<'all' | Profile['status']>('all');
  const [selectedSituation, setSelectedSituation] = useState<'all' | 'online' | 'error' | 'paused'>('all');
  const [selectedPublicationView, setSelectedPublicationView] = useState<'all' | 'posted'>('all');
  const [selection, setSelection] = useState<ProfileSelectionState>(EMPTY_PROFILE_SELECTION);
  const [selectedSort, setSelectedSort] = useState<InstagramProfileSort>('recent');
  // Lista e o padrao: e o modo que aguenta operar centenas de perfis. Cards fica
  // como alternativa para quem quer ver as metricas de cada conta lado a lado.
  const [viewMode, setViewMode] = useState<'cards' | 'list'>('list');
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeletePreview, setBulkDeletePreview] = useState<ProfileRemovalPreview | null>(null);
  const [bulkDeleteConfirmation, setBulkDeleteConfirmation] = useState('');
  const [bulkDeleteBusy, setBulkDeleteBusy] = useState<'preview' | 'deleting' | ''>('');
  const [bulkDeleteError, setBulkDeleteError] = useState('');
  const [removalProgress, setRemovalProgress] = useState<RemovalProgress | null>(null);
  const [pollingRemovals, setPollingRemovals] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [catalogCursor, setCatalogCursor] = useState<string | null>(null);
  const [catalogCursorHistory, setCatalogCursorHistory] = useState<Array<string | null>>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [catalogReloadKey, setCatalogReloadKey] = useState(0);
  const skippedInitialCatalogRequest = useRef(false);
  const [message, setMessage] = useState('');
  const [authMirrorLink, setAuthMirrorLink] = useState(initialAuthMirrorLink);
  const [authMirrorUrl, setAuthMirrorUrl] = useState('');
  const [authMirrorBusy, setAuthMirrorBusy] = useState(false);
  const [authMirrorMessage, setAuthMirrorMessage] = useState('');
  const profileCounters = catalog.summary;
  const visibleProfileIds = catalog.items.map((profile) => profile.id);
  const visibleSelection = visibleSelectionState(selection, visibleProfileIds);
  const selectionCount = profileSelectionCount(selection, profileCounters.filteredTotal);
  const overSelectionCap = !selection.allFilterSelected && selectionCount > MAX_BULK_PROFILE_DELETE;
  const currentCatalogFilters = {
    query: debouncedSearch,
    groupId: selectedGroupId === 'all' ? null : selectedGroupId,
    status: selectedStatus,
    situation: selectedSituation,
    publication: selectedPublicationView,
    sort: selectedSort,
  };
  const groupAssignmentSuffix = connectionResult.groupAssignment === 'assigned'
    ? ` Perfil(is) adicionado(s) ao grupo “${connectionResult.groupName ?? 'selecionado'}”.`
    : connectionResult.groupAssignment === 'failed'
      ? ` O perfil foi adicionado, mas ficou sem grupo: ${connectionResult.groupAssignmentError ?? 'não foi possível concluir a associação.'}`
      : '';
  const connectionMessage = connectionResult.connected
    ? connectionResult.connected === 'zernio'
      ? `Conta(s) Instagram da Zernio sincronizada(s) com sucesso${connectionResult.synced ? `: ${connectionResult.synced}` : ''}.${connectionResult.zernioFallbackConnection ? ` A chave selecionada estava sem slot; a conexão foi direcionada automaticamente para “${connectionResult.zernioFallbackConnection}”.` : ''}${groupAssignmentSuffix} ${connectionResult.analyticsJobId ? `Métricas enfileiradas: ${connectionResult.analyticsJobTotal ?? '0'} perfil(is).` : 'Métricas seguem cacheadas e serão atualizadas em segundo plano quando necessário.'}`
      : connectionResult.connected === 'zernio_submitted'
        ? 'Solicitação de adição enviada. Você já pode fechar este celular; a VPS concluirá a verificação e o resultado aparecerá no histórico abaixo.'
      : connectionResult.connected === 'zernio_empty'
        ? 'A conexão Zernio retornou, mas nenhuma conta Instagram foi encontrada para sincronizar.'
        : connectionResult.connected === 'updated'
      ? 'Perfil reconectado e token atualizado com sucesso.'
      : 'Perfil conectado e salvo com sucesso.'
    : connectionResult.error
      ? connectionErrorMessage[connectionResult.error] ?? 'Não foi possível concluir a conexão do perfil.'
      : null;
  const connectionDiagnostic = connectionResult.error && connectionResult.diagnostic
    ? connectionResult.diagnostic
    : null;
  const selectedZernioConnection = zernioConnections.find((connection) => connection.id === selectedZernioConnectionId) ?? zernioConnections[0] ?? null;
  const resultZernioConnection = zernioConnections.find((connection) => connection.id === connectionResult.zernioConnectionId) ?? null;
  const planLimitMessage = connectionResult.error === 'zernio_plan_limit'
    ? resultZernioConnection
      ? `A chave “${resultZernioConnection.label}” possui ${resultZernioConnection.remote_instagram_account_count ?? resultZernioConnection.instagram_profile_count ?? 0} conta(s) remota(s) de ${resultZernioConnection.instagram_slot_limit ?? '—'} slot(s) configurado(s). A Zernio respondeu ${connectionResult.zernioErrorCode || connectionResult.zernioHttpStatus || 'PAYMENT_REQUIRED'} e exige capacidade de cobrança ou forma de pagamento para outra conexão.`
      : connectionMessage
    : null;
  const selectedConnectionId = selectedZernioConnection?.id ?? '';
  const selectedConnectionConnectUrl = selectedConnectionId
    && manualZernioIntentKey
    ? `/api/integrations/zernio/start?returnTo=%2Fperfis&connectionId=${encodeURIComponent(selectedConnectionId)}&intentKey=${encodeURIComponent(manualZernioIntentKey)}`
    : '';
  const pastedZernioMatch = useMemo(() => resolveZernioBulkTarget(zernioConnections, groups, pastedZernioLabel), [groups, pastedZernioLabel, zernioConnections]);
  const pastedZernioConnectUrl = pastedZernioMatch.valid && pastedZernioMatch.connection
    && pastedZernioIntentKey
    ? `/api/integrations/zernio/start?returnTo=%2Fperfis&connectionId=${encodeURIComponent(pastedZernioMatch.connection.id)}${pastedZernioMatch.group ? `&groupId=${encodeURIComponent(pastedZernioMatch.group.id)}` : ''}&intentKey=${encodeURIComponent(pastedZernioIntentKey)}`
    : '';
  const bulkZernioGroup = groups.find((group) => group.id === bulkZernioGroupId) ?? null;
  const bulkZernioPlan = useMemo(
    () => buildBulkZernioRows(zernioConnections, bulkZernioQuantity, bulkZernioGroup?.name ?? null),
    [bulkZernioGroup?.name, bulkZernioQuantity, zernioConnections],
  );
  const bulkZernioPreviewRows = bulkZernioPlan.rows.slice(0, 50);
  const bulkZernioLastRefreshLabel = formatBulkRefreshTime(bulkZernioLastRefreshAt);

  useEffect(() => {
    setCatalog(initialCatalog);
  }, [initialCatalog]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setCatalogCursor(null);
      setCatalogCursorHistory([]);
      setSelection(clearProfileSelection());
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    if (!skippedInitialCatalogRequest.current) {
      skippedInitialCatalogRequest.current = true;
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: String(initialCatalog.limit) });
    if (catalogCursor) params.set('cursor', catalogCursor);
    if (debouncedSearch) params.set('query', debouncedSearch);
    if (selectedGroupId !== 'all') params.set('groupId', selectedGroupId);
    if (selectedStatus !== 'all') params.set('status', selectedStatus);
    if (selectedSituation !== 'all') params.set('situation', selectedSituation);
    if (selectedPublicationView !== 'all') params.set('publication', selectedPublicationView);
    if (selectedSort !== 'recent') params.set('sort', selectedSort);

    setCatalogLoading(true);
    setCatalogError('');
    void fetch(`/api/profiles?${params.toString()}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as InstagramProfilesCatalogPage & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? 'Não foi possível carregar os perfis.');
        setCatalog(payload);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setCatalogError(error instanceof Error ? error.message : 'Não foi possível carregar os perfis.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });
    return () => controller.abort();
  }, [catalogCursor, catalogReloadKey, debouncedSearch, initialCatalog.limit, selectedGroupId, selectedPublicationView, selectedSituation, selectedSort, selectedStatus]);

  useEffect(() => {
    if (connectionResult.connected || connectionResult.error) setConnectModalOpen(true);
  }, [connectionResult.connected, connectionResult.error]);

  // Trocar de filtro invalida a seleção: "todos deste filtro" passaria a
  // significar outro conjunto sem a pessoa ter pedido. Paginar, não — a seleção
  // atravessa as páginas de propósito.
  function resetCatalogPagination() {
    setCatalogCursor(null);
    setCatalogCursorHistory([]);
    setSelection(clearProfileSelection());
  }

  function loadNextCatalogPage() {
    if (!catalog.nextCursor || catalogLoading) return;
    setCatalogCursorHistory((current) => [...current, catalogCursor]);
    setCatalogCursor(catalog.nextCursor);
  }

  function loadPreviousCatalogPage() {
    if (!catalogCursorHistory.length || catalogLoading) return;
    const previous = catalogCursorHistory[catalogCursorHistory.length - 1] ?? null;
    setCatalogCursorHistory((current) => current.slice(0, -1));
    setCatalogCursor(previous);
  }

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PROFILES_VIEW_STORAGE_KEY);
      if (stored === 'list' || stored === 'cards') setViewMode(stored);
    } catch {
      // Navegador em modo privado ou com dados de site bloqueados: fica no padrão.
    }
  }, []);

  // O worker de publicação drena até 20 remoções por ciclo, então uma seleção
  // grande leva vários ciclos. O painel acompanha até a fila zerar e só então
  // recarrega o catálogo, para os perfis sumirem da tela quando de fato saíram.
  useEffect(() => {
    if (!pollingRemovals) return;
    let cancelled = false;
    async function readProgress() {
      try {
        const response = await fetch('/api/profiles/removal-progress', { cache: 'no-store' });
        const payload = await response.json() as RemovalProgress & { error?: string };
        if (cancelled || !response.ok) return;
        setRemovalProgress(payload);
        if (payload.pending === 0) {
          setPollingRemovals(false);
          setCatalogReloadKey((current) => current + 1);
        }
      } catch {
        // Uma leitura perdida não interrompe o acompanhamento.
      }
    }
    void readProgress();
    const interval = window.setInterval(() => void readProgress(), 4000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [pollingRemovals]);

  function changeViewMode(next: 'cards' | 'list') {
    setViewMode(next);
    try {
      window.localStorage.setItem(PROFILES_VIEW_STORAGE_KEY, next);
    } catch {
      // Preferência não persistida; a sessão atual continua no modo escolhido.
    }
  }

  async function openBulkDelete() {
    if (!selectionCount || bulkDeleteBusy) return;
    setBulkDeleteOpen(true);
    setBulkDeletePreview(null);
    setBulkDeleteConfirmation('');
    setBulkDeleteError('');
    setBulkDeleteBusy('preview');
    try {
      const response = await fetch('/api/profiles/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBulkDeleteRequest(selection, currentCatalogFilters, { dryRun: true })),
      });
      const payload = await response.json() as { summary?: ProfileRemovalPreview; error?: string };
      if (!response.ok || !payload.summary) throw new Error(payload.error ?? 'Não foi possível resumir a exclusão.');
      setBulkDeletePreview(payload.summary);
    } catch (error) {
      setBulkDeleteError(error instanceof Error ? error.message : 'Não foi possível resumir a exclusão.');
    } finally {
      setBulkDeleteBusy('');
    }
  }

  async function confirmBulkDelete() {
    if (!isBulkDeleteConfirmed(bulkDeleteConfirmation) || bulkDeleteBusy) return;
    setBulkDeleteBusy('deleting');
    setBulkDeleteError('');
    try {
      const response = await fetch('/api/profiles/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBulkDeleteRequest(selection, currentCatalogFilters, { confirmation: bulkDeleteConfirmation })),
      });
      const payload = await response.json() as {
        queued?: number; alreadyQueued?: number; deletedLocal?: number; skipped?: number;
        removedNowIds?: string[]; error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? 'Não foi possível excluir os perfis selecionados.');

      // Só os perfis sem contrapartida remota já saíram do banco. Os Zernio
      // continuam visíveis até o worker confirmar o DELETE na Zernio — some-los
      // antes daria a impressão de que a vaga já foi liberada.
      const removedNow = new Set(payload.removedNowIds ?? []);
      if (removedNow.size) {
        setCatalog((current) => ({
          ...current,
          items: current.items.filter((item) => !removedNow.has(item.id)),
          summary: {
            ...current.summary,
            total: Math.max(0, current.summary.total - removedNow.size),
            filteredTotal: Math.max(0, current.summary.filteredTotal - removedNow.size),
          },
        }));
      }

      setMessage(describeRemovalResult({
        queued: payload.queued ?? 0,
        alreadyQueued: payload.alreadyQueued ?? 0,
        deletedLocal: payload.deletedLocal ?? 0,
        skipped: payload.skipped ?? 0,
        removedNowIds: payload.removedNowIds ?? [],
      }));
      setSelection(clearProfileSelection());
      setBulkDeleteOpen(false);
      setBulkDeleteConfirmation('');
      if ((payload.queued ?? 0) + (payload.alreadyQueued ?? 0) > 0) setPollingRemovals(true);
      else setCatalogReloadKey((current) => current + 1);
    } catch (error) {
      setBulkDeleteError(error instanceof Error ? error.message : 'Não foi possível excluir os perfis selecionados.');
    } finally {
      setBulkDeleteBusy('');
    }
  }

  function zernioReconnectUrl(profile: Profile) {
    const connectionId = profile.zernio_connection_id ?? selectedConnectionId;
    return connectionId
      ? `/api/integrations/zernio/start?returnTo=%2Fperfis&connectionId=${encodeURIComponent(connectionId)}`
      : '/perfis?error=zernio_connection_required';
  }

  async function requestMetricsRefresh(trigger: 'page_view' | 'manual', profileIds?: string[]) {
    try {
      const response = await fetch('/api/profile-analytics/refresh-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger, profileIds, force: trigger === 'manual' }),
      });
      const payload = await response.json() as { job?: RefreshJobSummary | null; error?: string };
      if (!response.ok) {
        if (trigger === 'manual') setMessage(payload.error ?? 'Não foi possível agendar a atualização de métricas.');
        return;
      }
      if (payload.job?.job_id) {
        setActiveRefreshJobId(payload.job.job_id);
        if (trigger === 'manual') {
          if (payload.job.reason === 'active_job' || payload.job.reason === 'manual_cooldown') setMessage('Atualização de métricas já está em andamento ou em cooldown anti-spam.');
          else if (payload.job.reason === 'nothing_stale') setMessage('Nada pendente para sincronizar agora.');
          else setMessage(`Sincronização enfileirada para ${payload.job.total_count} perfil(is).`);
        }
      }
    } catch {
      if (trigger === 'manual') setMessage('Não foi possível conectar ao servidor.');
    }
  }

  useEffect(() => {
    if (!activeRefreshJobId) return;
    let cancelled = false;
    async function poll() {
      const response = await fetch(`/api/profile-analytics/refresh-jobs/${activeRefreshJobId}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({})) as { job?: RefreshJobStatus };
      if (!cancelled && response.ok && payload.job) {
        if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(payload.job.status)) {
          setActiveRefreshJobId(null);
          if (['completed', 'completed_with_errors'].includes(payload.job.status) && payload.job.processed_count > 0) {
            setCatalogReloadKey((current) => current + 1);
          }
        }
      }
    }
    void poll();
    const interval = window.setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeRefreshJobId]);

  useEffect(() => {
    let cancelled = false;

    async function restoreActiveZernioSyncBatch() {
      const response = await fetch('/api/integrations/zernio/sync-batches/active', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({})) as { batchId?: string | null };
      if (cancelled || !response.ok || !payload.batchId) return;
      setActiveZernioSyncBatchId(payload.batchId);
      setSyncingZernio(true);
      setMessage('Uma sincronia Zernio em andamento foi recuperada.');
    }

    void restoreActiveZernioSyncBatch();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!activeZernioSyncBatchId) return;
    let cancelled = false;

    async function poll() {
      const response = await fetch(`/api/integrations/zernio/sync-batches/${activeZernioSyncBatchId}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({})) as { batch?: ZernioOrganizationSyncProgress };
      if (cancelled || !response.ok || !payload.batch) return;

      setZernioSyncBatchProgress(payload.batch);
      if (payload.batch.status === 'processing') return;

      setActiveZernioSyncBatchId(null);
      setSyncingZernio(false);
      void refreshBulkZernioConnections();
      const summary = `${payload.batch.synced} perfil(is) reconciliado(s); ${payload.batch.conflicts} conflito(s); ${payload.batch.failures} falha(s).`;
      setMessage(`Sincronia de contas finalizada: ${summary}`);
    }

    void poll();
    const interval = window.setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeZernioSyncBatchId]);

  useEffect(() => {
    if (!bulkZernioModalOpen) return;
    void refreshBulkZernioConnections();
  }, [bulkZernioModalOpen]);

  useEffect(() => {
    if (!connectModalOpen) return;
    setPastedZernioIntentKey(crypto.randomUUID());
    setManualZernioIntentKey(crypto.randomUUID());
  }, [connectModalOpen]);

  async function syncProfile(profileId: string) {
    setCheckingProfileId(profileId);
    setMessage('');

    try {
      const response = await fetch(`/api/integrations/meta/profiles/${profileId}/health`, {
        method: 'POST',
      });
      const payload = await response.json() as { error?: string };

      if (!response.ok) {
        setMessage(payload.error ?? 'Não foi possível checar o perfil.');
        return;
      }

      await requestMetricsRefresh('manual', [profileId]);
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setCheckingProfileId(null);
    }
  }

  function requestDeleteProfile(profile: Profile) {
    if (profile.provider === 'zernio') {
      setDeleteChoiceProfile(profile);
      return;
    }

    if (!window.confirm(`Excluir o perfil @${profile.username}? Ele será removido dos grupos e não poderá mais receber publicações.`)) return;
    if (!window.confirm(`Confirma novamente a exclusão local do perfil @${profile.username}?`)) return;
    void deleteProfile(profile, false);
  }

  async function deleteProfile(profile: Profile, disconnectZernio: boolean) {
    if (profile.provider === 'zernio') {
      const action = disconnectZernio ? 'desconectar na Zernio e remover do Atena' : 'remover somente do Atena';
      if (!window.confirm(`Você escolheu ${action} para @${profile.username}. Deseja continuar?`)) return;
      if (!window.confirm(`Confirma novamente: ${action} para @${profile.username}?`)) return;
    }

    setDeleteChoiceProfile(null);

    setDeletingProfileId(profile.id);
    setMessage('');

    try {
      const response = await fetch(`/api/integrations/meta/profiles/${profile.id}${disconnectZernio ? '?disconnectZernio=true' : ''}`, { method: 'DELETE' });
      const payload = await response.json() as { error?: string };

      if (!response.ok) {
        setMessage(payload.error ?? 'Não foi possível excluir o perfil.');
        return;
      }

      setCatalog((current) => ({
        ...current,
        items: current.items.filter((item) => item.id !== profile.id),
        summary: {
          ...current.summary,
          total: Math.max(0, current.summary.total - 1),
          filteredTotal: Math.max(0, current.summary.filteredTotal - 1),
          online: Math.max(0, current.summary.online - (profile.status === 'online' ? 1 : 0)),
          error: Math.max(0, current.summary.error - (profile.status === 'reauthorization_required' || profile.last_error_message ? 1 : 0)),
          paused: Math.max(0, current.summary.paused - (profile.status === 'offline' || profile.status === 'no_data' ? 1 : 0)),
        },
      }));
      setMessage(disconnectZernio ? 'Perfil removido do Atena e desconectado na Zernio.' : 'Perfil removido do Atena.');
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setDeletingProfileId(null);
    }
  }

  async function syncZernioAccounts(connectionId?: string) {
    if (connectionId) {
      setSyncingZernio(true);
      setMessage('');
      try {
        const response = await fetch(`/api/integrations/zernio/connections/${encodeURIComponent(connectionId)}/sync`, { method: 'POST' });
        const payload = await response.json() as ZernioSyncPayload;
        if (!response.ok) throw new Error(payload.error ?? 'Não foi possível sincronizar a conta Zernio.');
        if (payload.refreshJob?.job_id) setActiveRefreshJobId(payload.refreshJob.job_id);
        await refreshBulkZernioConnections();
        setMessage(formatZernioSyncMessage(payload));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Não foi possível conectar ao servidor.');
      } finally {
        setSyncingZernio(false);
      }
      return;
    }

    if (zernioConnections.length === 0) {
      setMessage('Cadastre uma conta Zernio antes de sincronizar perfis.');
      return;
    }

    setSyncingZernio(true);
    setMessage('');
    try {
      const response = await fetch('/api/integrations/zernio/sync-all', { method: 'POST' });
      const payload = await response.json() as ZernioOrganizationSyncPayload;
      if (!response.ok) throw new Error(payload.error ?? 'Não foi possível enfileirar a sincronia de contas.');
      if (!payload.batchId) throw new Error('O lote de sincronia não foi criado.');
      setActiveZernioSyncBatchId(payload.batchId);
      setMessage(payload.status === 'already_running'
        ? 'Uma sincronia já estava em andamento; exibindo o progresso do lote atual.'
        : `Sincronia enfileirada: ${payload.totalConnections ?? 0} chave(s) aguardando a VPS.`);
    } catch (error) {
      setSyncingZernio(false);
      setMessage(error instanceof Error ? error.message : 'Não foi possível conectar ao servidor.');
    }
  }

  async function refreshBulkZernioConnections() {
    if (bulkZernioRefreshing) return;

    setBulkZernioRefreshing(true);
    setBulkZernioRefreshMessage('');

    try {
      const response = await fetch('/api/integrations/zernio/connections', { cache: 'no-store' });
      const payload = await response.json() as { connections?: ZernioConnection[]; error?: string };

      if (!response.ok) {
        setBulkZernioRefreshMessage(payload.error ?? 'Não foi possível atualizar a leitura das contas Zernio.');
        return;
      }

      const sortedConnections = sortZernioConnectionsByProfileCount(payload.connections ?? []);
      setZernioConnections(sortedConnections);
      setSelectedZernioConnectionId((current) => sortedConnections.some((connection) => connection.id === current) ? current : sortedConnections[0]?.id ?? '');
      setBulkZernioLastRefreshAt(new Date().toISOString());
    } catch {
      setBulkZernioRefreshMessage('Não foi possível conectar ao servidor para atualizar a lista.');
    } finally {
      setBulkZernioRefreshing(false);
    }
  }

  async function copyBulkZernioList() {
    setBulkZernioCopyMessage('');
    if (!bulkZernioPlan.text) {
      setBulkZernioCopyMessage('Nenhuma conta com slot livre para copiar com estes critérios.');
      return;
    }

    try {
      await navigator.clipboard.writeText(bulkZernioPlan.text);
      setBulkZernioCopyMessage(`${bulkZernioPlan.rows.length} linha(s) copiadas para colar no Excel.`);
    } catch {
      setBulkZernioCopyMessage('Não foi possível copiar automaticamente. Selecione o texto da prévia e copie manualmente.');
    }
  }

  async function copyAuthMirrorUrl(url: string) {
    if (!url) return false;
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  }

  async function activateAuthMirrorLink() {
    setAuthMirrorBusy(true);
    setAuthMirrorMessage('');

    try {
      const response = await fetch('/api/auth/mirror-link', { method: 'POST' });
      const payload = await response.json() as { mirrorLink?: AuthMirrorLinkState; mirrorUrl?: string; error?: string };

      if (!response.ok || !payload.mirrorLink || !payload.mirrorUrl) {
        setAuthMirrorMessage(payload.error ?? 'Não foi possível ativar o link espelho.');
        return;
      }

      setAuthMirrorLink(payload.mirrorLink);
      setAuthMirrorUrl(payload.mirrorUrl);
      const copied = await copyAuthMirrorUrl(payload.mirrorUrl);
      setAuthMirrorMessage(copied ? 'Link espelho ativado e copiado.' : 'Link espelho ativado. Copie o link para usar nos aparelhos.');
    } catch {
      setAuthMirrorMessage('Não foi possível conectar ao servidor.');
    } finally {
      setAuthMirrorBusy(false);
    }
  }

  async function deactivateAuthMirrorLink() {
    if (!window.confirm('Desativar o link espelho atual? Quem usar esse link será enviado para o login.')) return;

    setAuthMirrorBusy(true);
    setAuthMirrorMessage('');

    try {
      const response = await fetch('/api/auth/mirror-link', { method: 'DELETE' });
      const payload = await response.json() as { mirrorLink?: AuthMirrorLinkState; error?: string };

      if (!response.ok || !payload.mirrorLink) {
        setAuthMirrorMessage(payload.error ?? 'Não foi possível desativar o link espelho.');
        return;
      }

      setAuthMirrorLink(payload.mirrorLink);
      setAuthMirrorUrl('');
      setAuthMirrorMessage('Link espelho desativado. O link anterior não autentica mais.');
    } catch {
      setAuthMirrorMessage('Não foi possível conectar ao servidor.');
    } finally {
      setAuthMirrorBusy(false);
    }
  }

  return (
    <main className="standalone-page profiles-page">
      <header className="standalone-header">
        <div>
          <span className="section-kicker">{activeOrganization.name} · Integrações</span>
          <h1>Contas</h1>
          <p>Suas contas do Instagram, organizadas em pastas.</p>
        </div>
        {canManage && (
          <div className="profiles-header-actions">
            <Link className="button button-ghost" href="/operacao/adicoes-zernio">
              Histórico de adições
            </Link>
            <button className="button button-ghost profile-sync-button" type="button" onClick={() => void syncZernioAccounts()} disabled={syncingZernio || zernioConnections.length === 0}>
              <SyncIcon className="button-icon button-icon-sync" />
              {syncingZernio ? 'Sincronizando…' : 'Sincronizar contas'}
            </button>
            <button className="button button-ghost" type="button" onClick={() => { setBulkZernioCopyMessage(''); setBulkZernioModalOpen(true); }} disabled={zernioConnections.length === 0}>
              Bulk Zernio
            </button>
            <button className="button button-secondary mobile-connect-button" type="button" onClick={() => setConnectModalOpen(true)}>
              ＋ Conectar conta
            </button>
          </div>
        )}
      </header>

      <section className="top-notification-region" aria-live="polite" aria-atomic="true">
        {message && <p className="inline-message" role="alert">{message}</p>}
        {zernioSyncBatchProgress && activeZernioSyncBatchId && (
          <p className="inline-message inline-message-success" role="status">
            Sincronia Zernio: {zernioSyncBatchProgress.processedConnections}/{zernioSyncBatchProgress.totalConnections} chave(s) concluída(s), {zernioSyncBatchProgress.processingConnections} em processamento · {zernioSyncBatchProgress.synced} perfil(is) reconciliado(s) · {zernioSyncBatchProgress.conflicts} conflito(s) · {zernioSyncBatchProgress.failures} falha(s).
          </p>
        )}
      </section>

      {canManage && (
        <section className="mobile-connect-hint" aria-label="Conexão pelo celular">
          <span aria-hidden="true">⌁</span>
          <div>
            <strong>Conecte pelo próprio celular</strong>
            <p>Toque em “Adicionar perfil”. Depois de autorizar, a solicitação será enviada à VPS e este aparelho poderá ser fechado imediatamente.</p>
          </div>
        </section>
      )}

      {canManage && (
        <section className={`panel profile-mirror-login-panel${authMirrorLink.active ? ' profile-mirror-login-panel-active' : ' profile-mirror-login-panel-inactive'}`} aria-label="Link espelho de login">
          <div className="profile-mirror-login-copy">
            <span className="section-kicker">Acesso rápido</span>
            <h2>Link espelho para aparelhos limpos</h2>
            <p>Ative um link temporário para abrir em celulares ou computadores sem sessão. Enquanto estiver ativo, quem usar o link entra como você e cai direto em Perfis.</p>
            {authMirrorLink.active ? (
              <p className="profile-mirror-login-warning">Quem tiver esse link acessa com suas permissões até você desativar.</p>
            ) : (
              <p className="profile-mirror-login-note">Nenhum link ativo agora. Ative somente quando for usar em um aparelho limpo.</p>
            )}
          </div>
          <div className={`profile-mirror-login-controls${authMirrorLink.active ? '' : ' profile-mirror-login-controls-inactive'}`}>
            <div className="profile-mirror-login-status-row">
              <span className={authMirrorLink.active ? 'profile-mirror-login-status active' : 'profile-mirror-login-status'}>
                <span aria-hidden="true" />{authMirrorLink.active ? 'Ativo' : 'Inativo'}
              </span>
              <button
                className={authMirrorLink.active ? 'profile-mirror-switch profile-mirror-switch-on' : 'profile-mirror-switch'}
                type="button"
                role="switch"
                aria-checked={authMirrorLink.active}
                disabled={authMirrorBusy}
                onClick={() => authMirrorLink.active ? void deactivateAuthMirrorLink() : void activateAuthMirrorLink()}
              >
                <span aria-hidden="true" />
                <strong>{authMirrorLink.active ? 'Desativar' : 'Ativar link'}</strong>
              </button>
            </div>
            {!authMirrorLink.active && <p className="profile-mirror-inactive-summary">Ao ativar, o link será gerado e copiado automaticamente para você enviar ao aparelho.</p>}
            {authMirrorLink.active && (
              <dl className="profile-mirror-login-meta">
                <div><dt>Gerado por</dt><dd>{authMirrorLink.createdByEmail ?? '—'}</dd></div>
                <div><dt>Usos</dt><dd>{authMirrorLink.useCount}</dd></div>
                <div><dt>Último uso</dt><dd>{formatDate(authMirrorLink.lastUsedAt)}</dd></div>
              </dl>
            )}
            {authMirrorUrl ? (
              <div className="profile-mirror-link-box">
                <input value={authMirrorUrl} readOnly aria-label="Link espelho ativo" onFocus={(event) => event.currentTarget.select()} />
                <button className="button button-secondary" type="button" onClick={() => void copyAuthMirrorUrl(authMirrorUrl).then((copied) => setAuthMirrorMessage(copied ? 'Link copiado.' : 'Não foi possível copiar automaticamente. Selecione e copie o campo.'))}>
                  Copiar link
                </button>
              </div>
            ) : authMirrorLink.active ? (
              <div className="profile-mirror-hidden-link">
                <span>O link está ativo, mas só é exibido no momento em que é gerado.</span>
                <button className="button button-ghost" type="button" disabled={authMirrorBusy} onClick={() => void activateAuthMirrorLink()}>
                  Gerar novo link
                </button>
              </div>
            ) : null}
            {authMirrorMessage && <p className="profile-mirror-login-message" role="status">{authMirrorMessage}</p>}
          </div>
        </section>
      )}

      {profileCounters.total === 0 ? (
        <section className="panel empty-state">
          <span className="empty-state-icon" aria-hidden="true">◎</span>
          <h2>Nenhum perfil conectado</h2>
          <p>O primeiro perfil conectado ficará disponível para grupos, fila e publicações.</p>
          {canManage && (
            <a className="button button-secondary" href="/api/integrations/meta/start?returnTo=%2Fperfis">
              Conectar Instagram
            </a>
          )}
        </section>
      ) : (
        <>
          <section className="profiles-toolbar panel" aria-label="Filtros de perfis">
            <div className="profiles-status-tabs" role="tablist" aria-label="Resumo das contas">
              <button className={selectedSituation === 'all' ? 'profiles-status-tab profiles-status-tab-active' : 'profiles-status-tab'} type="button" onClick={() => { resetCatalogPagination(); setSelectedSituation('all'); }}><span>Todas</span><strong>{profileCounters.total}</strong></button>
              <button className={selectedSituation === 'online' ? 'profiles-status-tab profiles-status-tab-active' : 'profiles-status-tab'} type="button" onClick={() => { resetCatalogPagination(); setSelectedSituation('online'); }}><span>Online</span><strong>{profileCounters.online}</strong></button>
              <button className={selectedSituation === 'error' ? 'profiles-status-tab profiles-status-tab-active' : 'profiles-status-tab'} type="button" onClick={() => { resetCatalogPagination(); setSelectedSituation('error'); }}><span>Com erro</span><strong>{profileCounters.error}</strong></button>
              <button className={selectedSituation === 'paused' ? 'profiles-status-tab profiles-status-tab-active' : 'profiles-status-tab'} type="button" onClick={() => { resetCatalogPagination(); setSelectedSituation('paused'); }}><span>Pausadas</span><strong>{profileCounters.paused}</strong></button>
            </div>
            <div className="profiles-toolbar-controls">
            <label htmlFor="profile-group-filter">
              Filtrar por grupo
              <select id="profile-group-filter" value={selectedGroupId} onChange={(event) => { resetCatalogPagination(); setSelectedGroupId(event.target.value); }}>
                <option value="all">Todos os grupos ({profileCounters.total})</option>
                {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
            </label>
            <label htmlFor="profile-status-filter">
              Status
              <select id="profile-status-filter" value={selectedStatus} onChange={(event) => { resetCatalogPagination(); setSelectedStatus(event.target.value as typeof selectedStatus); }}>
                <option value="all">Todos</option>
                <option value="online">Online</option>
                <option value="offline">Offline</option>
                <option value="reauthorization_required">Reautorizar</option>
                <option value="no_data">Sem dados</option>
              </select>
            </label>
            <label htmlFor="profile-search-filter">
              Buscar
              <input id="profile-search-filter" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="@usuario, nome ou conta Zernio" />
            </label>
            <label htmlFor="profile-sort-filter">
              Ordenar por
              <select id="profile-sort-filter" value={selectedSort} onChange={(event) => { resetCatalogPagination(); setSelectedSort(event.target.value as InstagramProfileSort); }}>
                <option value="recent">Mais recentes</option>
                <option value="followers">Mais seguidores</option>
                <option value="views">Mais visualizações</option>
              </select>
            </label>
            <div className="profiles-posted-toggle" role="group" aria-label="Filtro de postadas">
              <button className={selectedPublicationView === 'all' ? 'profiles-posted-toggle-button-active' : ''} type="button" aria-pressed={selectedPublicationView === 'all'} onClick={() => { resetCatalogPagination(); setSelectedPublicationView('all'); }}>Todas</button>
              <button className={selectedPublicationView === 'posted' ? 'profiles-posted-toggle-button-active' : ''} type="button" aria-pressed={selectedPublicationView === 'posted'} onClick={() => { resetCatalogPagination(); setSelectedPublicationView('posted'); }}>Postadas {profileCounters.publishedItems}</button>
            </div>
            <div className="profiles-posted-toggle" role="group" aria-label="Modo de exibição">
              <button className={viewMode === 'list' ? 'profiles-posted-toggle-button-active' : ''} type="button" aria-pressed={viewMode === 'list'} onClick={() => changeViewMode('list')}>Lista</button>
              <button className={viewMode === 'cards' ? 'profiles-posted-toggle-button-active' : ''} type="button" aria-pressed={viewMode === 'cards'} onClick={() => changeViewMode('cards')}>Cards</button>
            </div>
            <span aria-live="polite">{catalogLoading ? 'Carregando…' : `${profiles.length} de ${profileCounters.filteredTotal} ${profileCounters.filteredTotal === 1 ? 'perfil' : 'perfis'}`}</span>
            </div>
            {canManage && profiles.length > 0 && (
              <div className={styles.selectionRow}>
                <label className={styles.selectVisible}>
                  <input
                    type="checkbox"
                    checked={visibleSelection.allSelected}
                    ref={(input) => { if (input) input.indeterminate = visibleSelection.someSelected; }}
                    onChange={(event) => setSelection((current) => toggleVisibleProfiles(current, visibleProfileIds, event.target.checked))}
                  />
                  Selecionar os {profiles.length} desta página
                </label>
                {selection.allFilterSelected ? (
                  <span className={styles.selectionHint}>
                    Selecionados todos os {selectionCount} perfis deste filtro{selection.excludedIds.length ? ` (${selection.excludedIds.length} desmarcado(s))` : ''}.
                  </span>
                ) : profileCounters.filteredTotal > profiles.length ? (
                  <button
                    className={styles.selectionLink}
                    type="button"
                    onClick={() => setSelection(selectAllMatchingFilter())}
                    disabled={profileCounters.filteredTotal > MAX_FILTER_PROFILE_DELETE}
                  >
                    {profileCounters.filteredTotal > MAX_FILTER_PROFILE_DELETE
                      ? `Filtro com ${profileCounters.filteredTotal} perfis — acima do limite de ${MAX_FILTER_PROFILE_DELETE} por operação`
                      : `Selecionar todos os ${profileCounters.filteredTotal} perfis deste filtro`}
                  </button>
                ) : null}
              </div>
            )}
          </section>
          {catalogError && <p className={`inline-message inline-message-error ${styles.catalogMessage}`} role="alert">{catalogError}</p>}
          {removalProgress && removalProgress.total > 0 && (
            <section className={`panel ${styles.removalPanel}`} aria-label="Andamento das exclusões" aria-live="polite">
              <div className={styles.removalHeader}>
                <span className="section-kicker">Exclusão em andamento</span>
                <strong>{removalProgress.done} de {removalProgress.total} perfil(is) removido(s) da Zernio</strong>
                {!removalProgress.pending && <button className={styles.selectionLink} type="button" onClick={() => setRemovalProgress(null)}>Dispensar</button>}
              </div>
              <div className={styles.removalTrack} role="presentation">
                <span style={{ width: `${Math.round((removalProgress.done / Math.max(1, removalProgress.total)) * 100)}%` }} />
              </div>
              <p className={styles.removalHint}>
                {removalProgress.pending
                  ? `${removalProgress.pending} na fila. O worker de publicação processa até 20 por ciclo e libera a vaga da chave Zernio ao confirmar cada remoção.`
                  : 'Fila concluída. As vagas liberadas já aparecem no inventário das chaves Zernio.'}
              </p>
              {removalProgress.failed > 0 && (
                <ul className={styles.removalFailures}>
                  {removalProgress.failures.map((failure) => (
                    <li key={failure.id}>
                      <strong>@{failure.username_snapshot}</strong>
                      <span>{failure.connection_label_snapshot ?? 'Conta Zernio não identificada'}</span>
                      <small>{failure.error_message ?? 'Falha terminal na remoção remota.'}</small>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {profiles.length === 0 ? (
            <section className="panel empty-state profiles-filter-empty">
              <h2>Nenhum perfil encontrado</h2>
              <p>Ajuste a busca ou os filtros para consultar outro trecho do catálogo.</p>
            </section>
          ) : viewMode === 'list' ? (
            <section className={`panel ${styles.listPanel}`} aria-label="Perfis conectados">
              <div className={styles.listScroll}>
                <table className={styles.listTable}>
                  <thead>
                    <tr>
                      <th scope="col" className={styles.listCheckboxCell}><span className="visually-hidden">Selecionar</span></th>
                      <th scope="col">Perfil</th>
                      <th scope="col">Grupo</th>
                      <th scope="col">Conta Zernio</th>
                      <th scope="col">Status</th>
                      <th scope="col" className={styles.listNumberCell}>Seguidores</th>
                      <th scope="col" className={styles.listNumberCell}>Views</th>
                      <th scope="col" className={styles.listNumberCell}>Posts</th>
                      <th scope="col"><span className="visually-hidden">Ações</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {profiles.map((profile) => {
                      const analytics = profile.publication_metrics;
                      const selected = isProfileSelected(selection, profile.id);
                      return (
                        <tr key={profile.id} className={selected ? styles.listRowSelected : undefined}>
                          <td className={styles.listCheckboxCell}>
                            {canManage && (
                              <label className={styles.listCheckbox}>
                                <span className="visually-hidden">Selecionar @{profile.username}</span>
                                <input type="checkbox" checked={selected} onChange={(event) => setSelection((current) => toggleProfileSelection(current, profile.id, event.target.checked))} />
                              </label>
                            )}
                          </td>
                          <td>
                            <div className={styles.listIdentity}>
                              <Link className={styles.listIdentityLink} href={`/perfis/${profile.id}`}>
                                <ProfileAvatar profile={profile} />
                                <span>
                                  <strong>@{profile.username}</strong>
                                  <small>{profile.display_name ?? 'Perfil profissional'}</small>
                                </span>
                              </Link>
                              <a
                                className={styles.listInstagramLink}
                                href={instagramProfileUrl(profile.username)}
                                target="_blank"
                                rel="noreferrer"
                                title={`Abrir @${profile.username} no Instagram`}
                              >
                                <span aria-hidden="true">↗</span>
                                <span className="visually-hidden">Abrir @{profile.username} no Instagram</span>
                              </a>
                            </div>
                          </td>
                          <td>{profile.group_name ?? 'Sem grupo'}</td>
                          <td>{profile.provider === 'zernio' ? (profile.zernio_connection_label ?? 'Não identificada') : 'Meta oficial'}</td>
                          <td><span className={`${styles.listStatus} ${profile.status === 'online' ? styles.listStatusOk : styles.listStatusWarn}`}>{profileStatusLabels[profile.status]}</span></td>
                          <td className={styles.listNumberCell} data-label="Seguidores">{formatCompactNumber(analytics?.followers_count)}</td>
                          <td className={styles.listNumberCell} data-label="Views">{formatCompactNumber(analytics?.views)}</td>
                          <td className={styles.listNumberCell} data-label="Posts">{analytics?.posts_count ?? 0}</td>
                          <td>
                            <div className={styles.listActions}>
                              {canManage && (
                                <button
                                  className={`button button-ghost profile-sync-button ${styles.listIconButton}`}
                                  type="button"
                                  title={`Sincronizar @${profile.username}`}
                                  aria-label={`Sincronizar @${profile.username}`}
                                  onClick={() => syncProfile(profile.id)}
                                  disabled={checkingProfileId !== null}
                                >
                                  <SyncIcon className="button-icon button-icon-sync" />
                                  <span className="visually-hidden">{checkingProfileId === profile.id ? 'Sincronizando…' : 'Sincronizar'}</span>
                                </button>
                              )}
                              {canManage && (
                                <button className="button button-danger profile-delete-icon-button" type="button" title={`Excluir perfil @${profile.username}`} aria-label={`Excluir perfil @${profile.username}`} onClick={() => requestDeleteProfile(profile)} disabled={deletingProfileId !== null}>
                                  <TrashIcon className="button-icon" />
                                  <span className="visually-hidden">Excluir perfil</span>
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : <section className="profile-grid" aria-label="Perfis conectados">
          {profiles.map((profile) => {
            const metrics = publicationMetricsFromSummary(profile.publication_metrics);
            const analytics = profile.publication_metrics;
            const delta = analytics?.followers_delta ?? 0;
            const selected = isProfileSelected(selection, profile.id);
              return (
            <article className={`panel profile-card profile-card-clickable ${styles.profileCard} ${selected ? styles.profileCardSelected : ''}`} key={profile.id} onClick={(event) => {
              if ((event.target as HTMLElement).closest('a, button, select, input, label')) return;
              window.location.assign(`/perfis/${profile.id}`);
            }}>
              <div className="profile-card-header profile-card-header-redesigned">
                <label className={`profile-card-select ${styles.cardSelect}`} aria-label={`Selecionar @${profile.username}`}>
                  <input type="checkbox" checked={selected} onChange={(event) => setSelection((current) => toggleProfileSelection(current, profile.id, event.target.checked))} />
                </label>
                <ProfileAvatar profile={profile} />
                <div className="profile-card-identity">
                  <h2>
                    <a className="profile-instagram-link" href={instagramProfileUrl(profile.username)} target="_blank" rel="noreferrer">
                      @{profile.username} <span aria-hidden="true">↗</span>
                    </a>
                   </h2>
                   <p>{profile.display_name ?? 'Perfil profissional'}</p>
                 </div>
                <span className="profile-post-count-chip">{analytics?.posts_count ?? metrics.published.total} posts</span>
                <div className="profile-card-chips">
                  <span className="profile-group-chip">{profile.group_name ?? 'Sem grupo'}</span>
                  <span className="profile-zernio-connection-chip" title={profile.provider === 'zernio' ? (profile.zernio_connection_label ?? 'Conta Zernio não identificada') : 'Conexão oficial da Meta'}>
                    {profile.provider === 'zernio' ? `Zernio: ${profile.zernio_connection_label ?? 'Não identificada'}` : 'Meta oficial'}
                  </span>
                </div>
              </div>
              <div className="profile-analytics-strip" aria-label="Resumo de analytics">
                <div><strong>{formatCompactNumber(analytics?.followers_count)}</strong><span>Seguidores</span><small className={delta >= 0 ? 'trend-positive' : 'trend-negative'}>{delta >= 0 ? '↑' : '↓'} {formatCompactNumber(Math.abs(delta))}</small></div>
                <div><strong>{formatRelativeTime(analytics?.latest_published_at)}</strong><span>Último post</span><small>{analytics?.latest_published_at ? formatDate(analytics.latest_published_at) : 'Sem post recente'}</small></div>
                <div><strong>{formatExpiration(profile.token_expires_at)}</strong><span>Expira</span><small>{profile.provider === 'zernio' ? 'Zernio' : 'Meta'}</small></div>
              </div>
              <div className="profile-card-sync-row">
                <span>Conectada há {formatConnectedAgo(profile.created_at)}</span>
                <span>Sync: {formatRelativeTime(analytics?.analytics_synced_at ?? profile.last_checked_at)}</span>
              </div>
              <div className="profile-publication-metrics">
                <PublicationMetricBreakdown title="Agendadas" metrics={metrics.scheduled} tone="scheduled" />
                <PublicationMetricBreakdown title="Postadas" metrics={metrics.published} tone="published" />
              </div>
              {profile.last_error_message && (
                <p className="profile-error" role="status">{profile.last_error_message}</p>
              )}
              <div className="profile-card-actions">
                <div className="profile-card-primary-actions">
                  {profile.status === 'reauthorization_required' && canManage && (
                    <a className="button button-secondary" href={profile.provider === 'zernio' ? zernioReconnectUrl(profile) : '/api/integrations/meta/start?returnTo=%2Fperfis'}>Reautorizar</a>
                  )}
                  {canManage && (
                    <button
                      className="button button-ghost profile-sync-button"
                      type="button"
                      onClick={() => syncProfile(profile.id)}
                      disabled={checkingProfileId !== null}
                    >
                      <SyncIcon className="button-icon button-icon-sync" />
                      {checkingProfileId === profile.id ? 'Sincronizando…' : 'Sincronizar'}
                    </button>
                  )}
                  <select className="profile-card-posted-select" aria-label={`Visualização de @${profile.username}`} defaultValue="posted">
                    <option value="posted">Postadas</option>
                    <option value="scheduled">Agendadas</option>
                  </select>
                </div>
                {canManage && (
                  <button
                    className="button button-danger profile-delete-icon-button"
                    type="button"
                    aria-label={`Excluir perfil @${profile.username}`}
                    onClick={() => requestDeleteProfile(profile)}
                    disabled={deletingProfileId !== null}
                  >
                    {deletingProfileId === profile.id ? <span className="profile-delete-loading">Excluindo…</span> : <><TrashIcon className="button-icon" /><span className="visually-hidden">Excluir perfil</span></>}
                  </button>
                )}
              </div>
            </article>
            );
          })}
          </section>}
          {canManage && selectionCount > 0 && (
            <div className={styles.selectionBar} role="region" aria-label="Ações da seleção">
              <span className={styles.selectionBarCount}>
                <strong>{selectionCount}</strong>
                {selection.allFilterSelected ? ' perfil(is) deste filtro' : ' perfil(is) selecionado(s)'}
              </span>
              <span className={styles.selectionBarHint}>
                A exclusão remove a conta da Zernio, libera a vaga da chave e cancela as publicações em fila.
              </span>
              <div className={styles.selectionBarActions}>
                <button className="button button-ghost" type="button" onClick={() => setSelection(clearProfileSelection())}>Limpar seleção</button>
                <button
                  className="button button-danger"
                  type="button"
                  onClick={() => void openBulkDelete()}
                  disabled={Boolean(bulkDeleteBusy) || overSelectionCap}
                  title={overSelectionCap ? `Marque no máximo ${MAX_BULK_PROFILE_DELETE} perfis por operação, ou use “Selecionar todos deste filtro”.` : undefined}
                >
                  <TrashIcon className="button-icon" />
                  {overSelectionCap ? `Máximo de ${MAX_BULK_PROFILE_DELETE} por vez` : 'Excluir selecionados'}
                </button>
              </div>
            </div>
          )}
          <nav className={`${styles.pagination} panel`} aria-label="Paginação dos perfis">
            <span>Página {catalogCursorHistory.length + 1} · até {catalog.limit} perfis por página</span>
            <div>
              <button className="button button-secondary" type="button" onClick={loadPreviousCatalogPage} disabled={!catalogCursorHistory.length || catalogLoading}>Anterior</button>
              <button className="button button-primary" type="button" onClick={loadNextCatalogPage} disabled={!catalog.hasMore || !catalog.nextCursor || catalogLoading}>Próxima</button>
            </div>
          </nav>
        </>
      )}
      {connectModalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setConnectModalOpen(false)}>
          <section className="panel bulk-modal profile-connect-modal" role="dialog" aria-modal="true" aria-labelledby="profile-connect-title" onMouseDown={(event) => event.stopPropagation()}>
            <div>
              <span className="section-kicker">Conectar Instagram</span>
              <h2 id="profile-connect-title">Como você quer conectar a conta?</h2>
            </div>
            {connectionMessage && (
              <div className={`profile-connect-result inline-message${connectionResult.error ? ' inline-message-error' : ' inline-message-success'}`} role={connectionResult.error ? 'alert' : 'status'}>
                <strong>{connectionResult.error ? 'A conexão não foi concluída' : 'Conexão concluída'}</strong>
                <p>{planLimitMessage ?? connectionMessage}</p>
                {connectionResult.error === 'zernio_plan_limit' && <p>Nenhuma conta existente foi removida. Você pode escolher outra chave com vaga ou ajustar a cobrança dessa chave na Zernio.</p>}
                {connectionDiagnostic && (
                  <details>
                    <summary>Diagnóstico técnico</summary>
                    <pre className="connection-diagnostic">{formatDiagnostic(connectionDiagnostic)}</pre>
                  </details>
                )}
              </div>
            )}
            <div className="profile-connect-options">
              <div className="profile-connect-option profile-connect-option-zernio profile-connect-option-zernio-bulk">
                <strong>Conectar Zernio em massa</strong>
                <span>Cole exatamente <b>conta Zernio</b> ou <b>conta Zernio;grupo</b>. A conta é adicionada primeiro e, depois, vinculada ao grupo.</span>
                {zernioConnections.length > 0 ? (
                  <>
                    <label htmlFor="connect-modal-zernio-paste">
                      Conta Zernio e grupo opcional
                      <span className={`zernio-paste-input-shell${pastedZernioMatch.valid ? ' zernio-paste-input-shell-valid' : pastedZernioMatch.parsed.kind === 'empty' ? '' : ' zernio-paste-input-shell-invalid'}`}>
                        <input
                          id="connect-modal-zernio-paste"
                          value={pastedZernioLabel}
                          onChange={(event) => setPastedZernioLabel(event.target.value)}
                          placeholder="Ex: Conta Aurora;Equipe Norte"
                          autoComplete="off"
                          aria-describedby="zernio-paste-validation"
                        />
                        {pastedZernioMatch.parsed.kind !== 'empty' && (
                          <span className="zernio-paste-input-status" aria-label={pastedZernioMatch.valid ? 'Conta e grupo válidos' : 'Conta ou grupo inválido'}>
                            {pastedZernioMatch.valid ? '✓' : '×'}
                          </span>
                        )}
                      </span>
                    </label>
                    <div id="zernio-paste-validation" className="zernio-target-validation" aria-live="polite">
                      {pastedZernioMatch.parsed.kind === 'empty' ? (
                        <p className="zernio-target-validation-hint">Use o nome exato. Sem “;grupo”, o perfil será conectado sem grupo.</p>
                      ) : pastedZernioMatch.parsed.kind === 'invalid_format' ? (
                        <p className="zernio-target-validation-error"><span>×</span>Formato inválido. Use somente “conta” ou “conta;grupo”, sem partes vazias.</p>
                      ) : (
                        <>
                          <p className={pastedZernioMatch.connectionStatus === 'found' ? 'zernio-target-validation-success' : 'zernio-target-validation-error'}>
                            <span>{pastedZernioMatch.connectionStatus === 'found' ? '✓' : '×'}</span>
                            {pastedZernioMatch.connectionStatus === 'found' ? `Conta Zernio “${pastedZernioMatch.parsed.accountName}” encontrada.` : pastedZernioMatch.connectionStatus === 'duplicate' ? 'Há mais de uma conta Zernio com esse nome exato.' : `Conta Zernio “${pastedZernioMatch.parsed.accountName}” não encontrada.`}
                          </p>
                          {pastedZernioMatch.groupStatus === 'not_requested' ? (
                            <p className="zernio-target-validation-neutral"><span>—</span>Sem grupo: o perfil será apenas conectado.</p>
                          ) : (
                            <p className={pastedZernioMatch.groupStatus === 'found' ? 'zernio-target-validation-success' : 'zernio-target-validation-error'}>
                              <span>{pastedZernioMatch.groupStatus === 'found' ? '✓' : '×'}</span>
                              {pastedZernioMatch.groupStatus === 'found' ? `Grupo “${pastedZernioMatch.parsed.groupName}” encontrado.` : pastedZernioMatch.groupStatus === 'duplicate' ? 'Há mais de um grupo com esse nome exato.' : `Grupo “${pastedZernioMatch.parsed.groupName}” não encontrado.`}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                    {pastedZernioConnectUrl ? (
                      <a className="button button-primary" href={pastedZernioConnectUrl}>{pastedZernioMatch.group ? 'Adicionar e depois vincular ao grupo' : 'Adicionar sem grupo'}</a>
                    ) : <span className="button button-primary button-disabled" aria-disabled="true">Aguardando dados válidos</span>}
                  </>
                ) : <p className="profile-error">Cadastre uma conta Zernio antes de conectar por este provedor.</p>}
              </div>
              <div className="profile-connect-option profile-connect-option-zernio">
                <strong>Zernio manual</strong>
                <span>Opção tradicional: escolha manualmente uma conta Zernio salva para abrir o OAuth externo.</span>
                {zernioConnections.length > 0 ? (
                  <label htmlFor="connect-modal-zernio-selector">
                    Conta Zernio
                    <select id="connect-modal-zernio-selector" value={selectedConnectionId} onChange={(event) => setSelectedZernioConnectionId(event.target.value)}>
                      {zernioConnections.map((connection) => (
                        <option key={connection.id} value={connection.id}>{connection.label} ({connection.instagram_profile_count ?? 0})</option>
                      ))}
                    </select>
                  </label>
                ) : <p className="profile-error">Cadastre uma conta Zernio antes de conectar por este provedor.</p>}
                {selectedConnectionId ? (
                  <a className="button button-primary" href={selectedConnectionConnectUrl}>Conectar via Zernio</a>
                ) : <span className="button button-primary button-disabled" aria-disabled="true">Conectar via Zernio</span>}
              </div>
              <a className="profile-connect-option" href="/api/integrations/meta/start?returnTo=%2Fperfis">
                <strong>API oficial Meta</strong>
                <span>Abre o OAuth oficial do Instagram e retorna para a Athena.</span>
              </a>
            </div>
            <button className="button button-ghost" type="button" onClick={() => setConnectModalOpen(false)}>Cancelar</button>
          </section>
        </div>
      )}
      {bulkZernioModalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setBulkZernioModalOpen(false)}>
          <section className="panel bulk-modal zernio-bulk-copy-modal" role="dialog" aria-modal="true" aria-labelledby="zernio-bulk-copy-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="zernio-bulk-copy-header">
              <div>
                <span className="section-kicker">Bulk Zernio</span>
                <h2 id="zernio-bulk-copy-title">Copiar contas com slot livre</h2>
              </div>
              <div className="zernio-bulk-refresh-actions">
                {bulkZernioLastRefreshLabel && <span className="zernio-bulk-refresh-time">Atualizado {bulkZernioLastRefreshLabel}</span>}
                <button className="zernio-bulk-refresh-button" type="button" onClick={() => void refreshBulkZernioConnections()} disabled={bulkZernioRefreshing} aria-label="Atualizar leitura das contas Zernio">
                  <SyncIcon className={`zernio-bulk-refresh-icon${bulkZernioRefreshing ? ' zernio-bulk-refresh-icon-spinning' : ''}`} />
                </button>
              </div>
            </div>
            <p className="bulk-modal-help">Gere uma estimativa para colar no Excel. Cada linha representa um celular/tela. A capacidade usa o limite individual, o inventário remoto recente, os vínculos locais e as reservas ativas. Copiar a lista não reserva slots.</p>
            {bulkZernioRefreshMessage && <p className="zernio-paste-status zernio-paste-status-warning" role="status">{bulkZernioRefreshMessage}</p>}
            <div className="zernio-bulk-copy-controls">
              <label htmlFor="zernio-bulk-quantity">
                Quantidade para copiar
                <input id="zernio-bulk-quantity" type="number" min="1" value={bulkZernioQuantity} onChange={(event) => setBulkZernioQuantity(Number(event.target.value))} />
              </label>
              <label className="zernio-bulk-group-control" htmlFor="zernio-bulk-group">
                Grupo depois da adição
                <select id="zernio-bulk-group" value={bulkZernioGroupId} onChange={(event) => setBulkZernioGroupId(event.target.value)}>
                  <option value="none">Sem grupo</option>
                  {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
                <small>{bulkZernioGroup ? `A lista sairá como conta;${bulkZernioGroup.name}` : 'A lista terá somente o nome da conta.'}</small>
              </label>
            </div>
            <dl className="zernio-bulk-copy-summary">
              <div><dt>Disponíveis</dt><dd>{bulkZernioPlan.availableSlots}</dd></div>
              <div><dt>Selecionadas</dt><dd>{bulkZernioPlan.rows.length}</dd></div>
              <div><dt>Sem slot</dt><dd>{bulkZernioPlan.fullConnections}</dd></div>
              <div><dt>Sem leitura recente</dt><dd>{bulkZernioPlan.unavailableSnapshotConnections}</dd></div>
            </dl>
            {bulkZernioPlan.unavailableSnapshotConnections > 0 && (
              <p className="zernio-paste-status zernio-paste-status-warning" role="status">{bulkZernioPlan.unavailableSnapshotConnections} conta(s) ficaram indisponíveis porque ainda não possuem inventário remoto válido ou a última leitura retornou erro. Execute “Sincronizar contas” para recuperar somente esses casos.</p>
            )}
            {bulkZernioPlan.availableSlots < bulkZernioPlan.requested && (
              <p className="zernio-paste-status zernio-paste-status-warning" role="status">Só existem {bulkZernioPlan.availableSlots} slot(s) livres com estes critérios. A cópia será menor que a quantidade pedida.</p>
            )}
            <label className="zernio-bulk-preview" htmlFor="zernio-bulk-preview-text">
              Prévia para Excel
              <textarea id="zernio-bulk-preview-text" readOnly value={bulkZernioPlan.text} rows={Math.min(12, Math.max(4, bulkZernioPreviewRows.length))} placeholder="Nenhuma conta disponível com os critérios atuais." />
              {bulkZernioPlan.rows.length > bulkZernioPreviewRows.length && <small>Prévia limitada; o botão copia as {bulkZernioPlan.rows.length} linhas.</small>}
            </label>
            {bulkZernioCopyMessage && <p className="profile-mirror-login-message" role="status">{bulkZernioCopyMessage}</p>}
            <div className="profile-delete-actions">
              <button className="button button-primary" type="button" onClick={() => void copyBulkZernioList()} disabled={bulkZernioPlan.rows.length === 0}>Copiar lista</button>
              <button className="button button-ghost" type="button" onClick={() => setBulkZernioModalOpen(false)}>Fechar</button>
            </div>
          </section>
        </div>
      )}
      {deleteChoiceProfile && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDeleteChoiceProfile(null)}>
          <section className="panel bulk-modal profile-delete-modal" role="dialog" aria-modal="true" aria-labelledby="zernio-delete-title" onMouseDown={(event) => event.stopPropagation()}>
            <div>
              <span className="section-kicker">Perfil Zernio</span>
              <h2 id="zernio-delete-title">Como remover @{deleteChoiceProfile.username}?</h2>
            </div>
            <p className="bulk-modal-help">Escolha a ação com cuidado. Remover só do Atena mantém a conta conectada na Zernio. Desconectar na Zernio pode liberar limite/plano lá e depois remove o perfil do Atena.</p>
            <div className="profile-delete-actions">
              <button className="button button-ghost" type="button" onClick={() => void deleteProfile(deleteChoiceProfile, false)} disabled={deletingProfileId !== null}>
                Remover só do Atena
              </button>
              <button className="button button-danger" type="button" onClick={() => void deleteProfile(deleteChoiceProfile, true)} disabled={deletingProfileId !== null}>
                Desconectar na Zernio e remover
              </button>
              <button className="button button-secondary" type="button" onClick={() => setDeleteChoiceProfile(null)} disabled={deletingProfileId !== null}>
                Cancelar
              </button>
            </div>
          </section>
        </div>
      )}
      {bulkDeleteOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!bulkDeleteBusy) setBulkDeleteOpen(false); }}>
          <section className={`panel bulk-modal ${styles.deleteModal}`} role="dialog" aria-modal="true" aria-labelledby="bulk-delete-title" onMouseDown={(event) => event.stopPropagation()}>
            <div>
              <span className="section-kicker">Ação irreversível</span>
              <h2 id="bulk-delete-title">Excluir {selectionCount} perfil(is)</h2>
            </div>

            {bulkDeleteBusy === 'preview' ? <p className="inline-message" role="status">Calculando o impacto…</p> : null}
            {bulkDeleteError && <p className="inline-message inline-message-error" role="alert">{bulkDeleteError}</p>}

            {bulkDeletePreview && (
              <>
                <dl className={styles.deleteSummary}>
                  <div><dt>Perfis</dt><dd>{bulkDeletePreview.total}</dd></div>
                  <div><dt>Na Zernio</dt><dd>{bulkDeletePreview.zernioCount}</dd></div>
                  <div><dt>Só no Atena</dt><dd>{bulkDeletePreview.metaCount}</dd></div>
                  <div><dt>Publicações canceladas</dt><dd>{bulkDeletePreview.pendingItemCount}</dd></div>
                </dl>

                {bulkDeletePreview.connectionLabels.length > 0 && (
                  <p className={styles.deleteDetail}>
                    Chaves Zernio afetadas: <strong>{bulkDeletePreview.connectionLabels.join(', ')}</strong>. Cada remoção confirmada libera uma vaga na chave correspondente.
                  </p>
                )}

                {bulkDeletePreview.zernioCount > 0 && (
                  <p className="inline-message inline-message-error" role="note">
                    Na Zernio, apagar uma conta é global: ela deixa de existir em todas as chaves que a enxergam, não só na chave listada aqui.
                  </p>
                )}

                {bulkDeletePreview.metaCount > 0 && (
                  <p className={styles.deleteDetail}>
                    {bulkDeletePreview.metaCount} perfil(is) não passam pela Zernio e saem imediatamente — sem liberar vaga nenhuma.
                  </p>
                )}

                {bulkDeletePreview.alreadyQueued > 0 && (
                  <p className={styles.deleteDetail}>{bulkDeletePreview.alreadyQueued} perfil(is) já estavam na fila de remoção; a ação não os duplica.</p>
                )}

                <label className={styles.deleteConfirmLabel} htmlFor="bulk-delete-confirmation">
                  Digite EXCLUIR para confirmar
                  <input
                    id="bulk-delete-confirmation"
                    autoComplete="off"
                    value={bulkDeleteConfirmation}
                    onChange={(event) => setBulkDeleteConfirmation(event.target.value)}
                    placeholder="EXCLUIR"
                  />
                </label>
              </>
            )}

            <div className="profile-delete-actions">
              <button
                className="button button-danger"
                type="button"
                onClick={() => void confirmBulkDelete()}
                disabled={!selectionCount || !bulkDeletePreview || !isBulkDeleteConfirmed(bulkDeleteConfirmation) || Boolean(bulkDeleteBusy)}
              >
                {bulkDeleteBusy === 'deleting' ? 'Excluindo…' : `Excluir ${selectionCount} perfil(is)`}
              </button>
              <button className="button button-ghost" type="button" onClick={() => setBulkDeleteOpen(false)} disabled={Boolean(bulkDeleteBusy)}>
                Cancelar
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
