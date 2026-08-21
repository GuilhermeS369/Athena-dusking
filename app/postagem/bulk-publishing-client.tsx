'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  BULK_PROFILE_RENDER_BATCH,
  bulkProfileQueueMetric,
  bulkProfileRenderLimit,
  bulkPublicationProjection,
  filterBulkProfiles,
  selectAllBulkProfileIds,
  sortBulkProfilesByQueue,
  toggleBulkProfileSelection,
} from '@/lib/publications/bulk-ui';
import type { ProfilePublicationMetrics } from '@/lib/publications/composer';
import styles from './bulk-publishing.module.css';

type BulkFormat = 'image' | 'reel' | 'story';
type BulkOrderMode = 'same_order' | 'diversified';
type BulkScheduleMode = 'interval' | 'daily_time';

type BulkProfile = {
  id: string;
  username: string;
  display_name: string | null;
  profile_picture_url?: string | null;
  provider: string;
  publication_metrics?: ProfilePublicationMetrics;
};

type BulkProfileGroup = {
  id: string;
  name: string;
  profile_group_members: Array<{ profile_id: string }> | null;
};

type BulkOrigin = {
  type: 'group' | 'ungrouped';
  groupId: string | null;
  name: string;
};

type MediaSummary = {
  totalFound: string;
  eligible: string;
  excluded: {
    deleted: string;
    pendingDeletion: string;
    notReady: string;
    missingStorage: string;
    incompatible: string;
  };
};

type MediaPreview = {
  id: string;
  originalName: string;
  kind: 'image' | 'video';
  thumbnailUrl: string | null;
};

type CompactRequest = {
  name: string;
  profileIds: string[];
  origin: { type: 'group'; groupId: string } | { type: 'ungrouped'; groupId: null };
  format: BulkFormat;
  scheduleMode: BulkScheduleMode;
  intervalMinutes: number;
  durationDays: string;
  dailyTime: string | null;
  caption: string | null;
  orderMode: BulkOrderMode;
  rotationSeed: string;
  reelCover: {
    enabled: true;
    origin: { type: 'group'; groupId: string } | { type: 'ungrouped'; groupId: null };
    mediaAssetId: string;
  } | { enabled: false };
};

type ScheduleReview = {
  profileCount: string;
  slotsPerProfile: string;
  expectedPublications: string;
  firstExecuteAt: string | null;
  lastExecuteAt: string | null;
  reviewedAt: string;
};

type ReviewResponse = {
  request: CompactRequest;
  schedule: ScheduleReview;
  media: MediaSummary;
  reviewToken: string;
  expiresAt: string;
  cover: { id: string; originalName: string; originName: string; thumbnailUrl: string | null } | null;
  error?: string;
};

type ConfirmResponse = {
  created: boolean;
  planId: string;
  batchId: string;
  profileCount: string;
  mediaCount: string;
  slotsPerProfile: string;
  expectedPublications: string;
  firstExecuteAt?: string | null;
  lastExecuteAt?: string | null;
  error?: string;
};

type PlanProgress = {
  planId: string;
  batchId: string;
  name: string;
  status: string;
  format: BulkFormat;
  profileCount: string;
  mediaCount: string;
  slotsPerProfile: string;
  expectedPublications: string;
  generatedPublications: string;
  suspendedPublications: string;
  ignoredPublications: string;
  failedPublications: string;
  expectedChunks: string;
  chunks: Record<'queued' | 'processing' | 'paused' | 'completed' | 'failed' | 'cancelled', string>;
  firstExecuteAt: string | null;
  lastExecuteAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type BulkPublishingClientProps = {
  canManage: boolean;
  profiles: BulkProfile[];
  groups: BulkProfileGroup[];
  onDirtyChange?: (dirty: boolean) => void;
};

const terminalStatuses = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);

function requestKey() {
  return `bulk-ui-${Date.now()}-${crypto.randomUUID()}`;
}

function rotationSeed() {
  return `rotation-${crypto.randomUUID()}`;
}

function formatInteger(value: string | number | bigint) {
  try {
    return BigInt(value).toLocaleString('pt-BR');
  } catch {
    return '0';
  }
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(new Date(value));
}

function progressPercent(progress: PlanProgress) {
  const expected = BigInt(progress.expectedPublications);
  if (expected === BigInt(0)) return 0;
  const handled = BigInt(progress.generatedPublications)
    + BigInt(progress.ignoredPublications)
    + BigInt(progress.failedPublications);
  return Number((handled * BigInt(10000)) / expected) / 100;
}

export default function BulkPublishingClient({ canManage, profiles, groups, onDirtyChange }: BulkPublishingClientProps) {
  const origins = useMemo<BulkOrigin[]>(() => [
    { type: 'ungrouped', groupId: null, name: 'Sem grupo' },
    ...groups.map((group) => ({ type: 'group' as const, groupId: group.id, name: group.name })),
  ], [groups]);
  const [profileSelection, setProfileSelection] = useState({ ids: [] as string[], anchorId: null as string | null });
  const [profileSearch, setProfileSearch] = useState('');
  const [profileGroupId, setProfileGroupId] = useState('');
  const [renderedProfileLimit, setRenderedProfileLimit] = useState(BULK_PROFILE_RENDER_BATCH);
  const [name, setName] = useState('');
  const [format, setFormat] = useState<BulkFormat>('reel');
  const [originKey, setOriginKey] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState('60');
  const [durationDays, setDurationDays] = useState('1');
  const [scheduleMode, setScheduleMode] = useState<BulkScheduleMode>('interval');
  const [dailyTime, setDailyTime] = useState('21:00');
  const [orderMode, setOrderMode] = useState<BulkOrderMode>('diversified');
  const [caption, setCaption] = useState('');
  const [seed, setSeed] = useState(rotationSeed);
  const [idempotencyKey, setIdempotencyKey] = useState(requestKey);
  const [loadingMedia, setLoadingMedia] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState('');
  const [mediaSummary, setMediaSummary] = useState<MediaSummary | null>(null);
  const [mediaAssets, setMediaAssets] = useState<MediaPreview[]>([]);
  const [mediaCursor, setMediaCursor] = useState<string | null>(null);
  const [mediaHasMore, setMediaHasMore] = useState(false);
  const [coverEnabled, setCoverEnabled] = useState(false);
  const [coverOriginKey, setCoverOriginKey] = useState('');
  const [coverAssets, setCoverAssets] = useState<MediaPreview[]>([]);
  const [selectedCover, setSelectedCover] = useState<MediaPreview | null>(null);
  const [coverCursor, setCoverCursor] = useState<string | null>(null);
  const [coverHasMore, setCoverHasMore] = useState(false);
  const [loadingCovers, setLoadingCovers] = useState(false);
  const [loadingMoreCovers, setLoadingMoreCovers] = useState(false);
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [progress, setProgress] = useState<PlanProgress | null>(null);
  const mediaRequestRef = useRef<{ sequence: number; controller: AbortController | null }>({ sequence: 0, controller: null });
  const coverRequestRef = useRef<{ sequence: number; controller: AbortController | null }>({ sequence: 0, controller: null });
  const reviewDialogRef = useRef<HTMLElement>(null);
  const reviewTriggerRef = useRef<HTMLButtonElement>(null);

  const origin = origins.find((candidate) => `${candidate.type}:${candidate.groupId ?? ''}` === originKey) ?? null;
  const coverOrigin = origins.find((candidate) => `${candidate.type}:${candidate.groupId ?? ''}` === coverOriginKey) ?? null;
  const filteredProfiles = useMemo(() => {
    const query = profileSearch.trim().toLocaleLowerCase('pt-BR');
    const selectedGroup = profileGroupId ? groups.find((group) => group.id === profileGroupId) : null;
    const memberIds = selectedGroup
      ? new Set((selectedGroup.profile_group_members ?? []).map((member) => member.profile_id))
      : null;
    const visible = filterBulkProfiles(profiles, query, memberIds);
    return sortBulkProfilesByQueue(visible, format);
  }, [format, groups, profileGroupId, profileSearch, profiles]);
  const renderedProfiles = useMemo(
    () => filteredProfiles.slice(0, renderedProfileLimit),
    [filteredProfiles, renderedProfileLimit],
  );
  const selectedSet = useMemo(() => new Set(profileSelection.ids), [profileSelection.ids]);
  const projected = useMemo(
    () => bulkPublicationProjection(durationDays, intervalMinutes, profileSelection.ids.length, scheduleMode),
    [durationDays, intervalMinutes, scheduleMode, profileSelection.ids.length],
  );
  const dirty = Boolean(
    name.trim()
    || profileSelection.ids.length
    || originKey
    || caption
    || format !== 'reel'
    || intervalMinutes !== '60'
    || durationDays !== '1'
    || scheduleMode !== 'interval'
    || dailyTime !== '21:00'
    || orderMode !== 'diversified'
    || coverEnabled
    || coverOriginKey
    || selectedCover
  );

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    setRenderedProfileLimit(BULK_PROFILE_RENDER_BATCH);
  }, [format, profileGroupId, profileSearch]);

  useEffect(() => {
    if (!origin) {
      mediaRequestRef.current.controller?.abort();
      setMediaSummary(null);
      setMediaAssets([]);
      setMediaCursor(null);
      setMediaHasMore(false);
      return;
    }
    void loadMediaPage(false);
    // `originKey` represents the single origin and is the stable dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originKey, format]);

  useEffect(() => {
    if (format !== 'reel') {
      coverRequestRef.current.controller?.abort();
      setCoverEnabled(false);
      setCoverOriginKey('');
      setCoverAssets([]);
      setSelectedCover(null);
      setCoverCursor(null);
      setCoverHasMore(false);
    }
  }, [format]);

  useEffect(() => {
    if (!coverEnabled || !coverOrigin) {
      coverRequestRef.current.controller?.abort();
      setCoverAssets([]);
      setSelectedCover(null);
      setCoverCursor(null);
      setCoverHasMore(false);
      return;
    }
    void loadCoverPage(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverEnabled, coverOriginKey]);

  useEffect(() => {
    if (!progress || terminalStatuses.has(progress.status)) return;
    let active = true;
    let timer: number | null = null;
    let controller: AbortController | null = null;
    const poll = async () => {
      controller = new AbortController();
      await loadProgress(progress.planId, false, controller.signal);
      if (active) timer = window.setTimeout(() => void poll(), 4000);
    };
    timer = window.setTimeout(() => void poll(), 4000);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [progress?.planId, progress?.status]);

  useEffect(() => {
    if (!review) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    reviewDialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !confirming) setReview(null);
      if (event.key !== 'Tab' || !reviewDialogRef.current) return;
      const focusable = Array.from(reviewDialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1) as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      (previousFocus ?? reviewTriggerRef.current)?.focus();
    };
  }, [review, confirming]);

  useEffect(() => () => {
    mediaRequestRef.current.controller?.abort();
    coverRequestRef.current.controller?.abort();
  }, []);

  function invalidateReview() {
    setReview(null);
    setMessage('');
  }

  function toggleProfile(profileId: string, shiftKey = false) {
    invalidateReview();
    const orderedIds = filteredProfiles.map((profile) => profile.id);
    setProfileSelection((current) => toggleBulkProfileSelection(current, orderedIds, profileId, shiftKey));
  }

  function selectAllFiltered() {
    invalidateReview();
    const orderedIds = filteredProfiles.map((profile) => profile.id);
    setProfileSelection((current) => ({
      ids: selectAllBulkProfileIds(current.ids, orderedIds),
      anchorId: orderedIds.at(-1) ?? current.anchorId,
    }));
  }

  function clearProfiles() {
    invalidateReview();
    setProfileSelection({ ids: [], anchorId: null });
  }

  function revealMoreProfiles() {
    setRenderedProfileLimit((current) => bulkProfileRenderLimit(current, filteredProfiles.length));
  }

  function maybeRevealProfiles(element: HTMLDivElement) {
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - 120) revealMoreProfiles();
  }

  function mediaUrl(cursor: string | null) {
    if (!origin) return '';
    const params = new URLSearchParams({ originType: origin.type, format, limit: '60' });
    if (origin.groupId) params.set('groupId', origin.groupId);
    if (cursor) params.set('cursor', cursor);
    return `/api/bulk-publications/media?${params.toString()}`;
  }

  async function loadMediaPage(append: boolean) {
    if (!origin) return;
    const requestOriginKey = originKey;
    const requestFormat = format;
    const requestCursor = append ? mediaCursor : null;
    mediaRequestRef.current.controller?.abort();
    const controller = new AbortController();
    const sequence = mediaRequestRef.current.sequence + 1;
    mediaRequestRef.current = { sequence, controller };
    append ? setLoadingMore(true) : setLoadingMedia(true);
    if (!append) {
      setMediaAssets([]);
      setMediaSummary(null);
      setMediaCursor(null);
      setMediaHasMore(false);
    }
    try {
      const response = await fetch(mediaUrl(requestCursor), { cache: 'no-store', signal: controller.signal });
      const payload = await response.json() as {
        summary?: MediaSummary;
        assets?: MediaPreview[];
        hasMore?: boolean;
        nextCursor?: string | null;
        error?: string;
      };
      if (!response.ok || !payload.summary) throw new Error(payload.error ?? 'Não foi possível carregar as mídias.');
      if (mediaRequestRef.current.sequence !== sequence || originKey !== requestOriginKey || format !== requestFormat) return;
      setMediaSummary(payload.summary);
      setMediaAssets((current) => append ? [...current, ...(payload.assets ?? [])] : payload.assets ?? []);
      setMediaHasMore(Boolean(payload.hasMore));
      setMediaCursor(payload.nextCursor ?? null);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setMessage(error instanceof Error ? error.message : 'Não foi possível carregar as mídias.');
    } finally {
      if (mediaRequestRef.current.sequence === sequence) {
        setLoadingMedia(false);
        setLoadingMore(false);
      }
    }
  }

  function coverUrl(cursor: string | null) {
    if (!coverOrigin) return '';
    const params = new URLSearchParams({ originType: coverOrigin.type, limit: '36' });
    if (coverOrigin.groupId) params.set('groupId', coverOrigin.groupId);
    if (cursor) params.set('cursor', cursor);
    return `/api/bulk-publications/covers?${params.toString()}`;
  }

  async function loadCoverPage(append: boolean) {
    if (!coverOrigin) return;
    const requestOriginKey = coverOriginKey;
    const requestCursor = append ? coverCursor : null;
    coverRequestRef.current.controller?.abort();
    const controller = new AbortController();
    const sequence = coverRequestRef.current.sequence + 1;
    coverRequestRef.current = { sequence, controller };
    append ? setLoadingMoreCovers(true) : setLoadingCovers(true);
    if (!append) {
      setCoverAssets([]);
      setSelectedCover(null);
      setCoverCursor(null);
      setCoverHasMore(false);
    }
    try {
      const response = await fetch(coverUrl(requestCursor), { cache: 'no-store', signal: controller.signal });
      const payload = await response.json() as { assets?: MediaPreview[]; hasMore?: boolean; nextCursor?: string | null; error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Não foi possível carregar as capas.');
      if (coverRequestRef.current.sequence !== sequence || coverOriginKey !== requestOriginKey) return;
      setCoverAssets((current) => append ? [...current, ...(payload.assets ?? [])] : payload.assets ?? []);
      setCoverHasMore(Boolean(payload.hasMore));
      setCoverCursor(payload.nextCursor ?? null);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setMessage(error instanceof Error ? error.message : 'Não foi possível carregar as capas.');
    } finally {
      if (coverRequestRef.current.sequence === sequence) {
        setLoadingCovers(false);
        setLoadingMoreCovers(false);
      }
    }
  }

  function compactRequest(): CompactRequest | null {
    if (!origin) return null;
    return {
      name,
      profileIds: profileSelection.ids,
      origin: origin.type === 'group'
        ? { type: 'group', groupId: origin.groupId as string }
        : { type: 'ungrouped', groupId: null },
      format,
      scheduleMode,
      intervalMinutes: Number(intervalMinutes),
      durationDays,
      dailyTime: scheduleMode === 'daily_time' ? dailyTime : null,
      caption: caption || null,
      orderMode,
      rotationSeed: seed,
      reelCover: coverEnabled && coverOrigin && selectedCover
        ? {
          enabled: true,
          origin: coverOrigin.type === 'group'
            ? { type: 'group', groupId: coverOrigin.groupId as string }
            : { type: 'ungrouped', groupId: null },
          mediaAssetId: selectedCover.id,
        }
        : { enabled: false },
    };
  }

  async function reviewPlan() {
    const request = compactRequest();
    setMessage('');
    if (!request) return setMessage('Selecione uma origem de mídia.');
    if (!name.trim()) return setMessage('Informe o nome do lote.');
    if (!profileSelection.ids.length) return setMessage('Selecione pelo menos um perfil online.');
    if (!mediaSummary || BigInt(mediaSummary.eligible) === BigInt(0)) return setMessage('A origem não possui mídias elegíveis para o formato.');
    if (caption.length > 2200) return setMessage('A legenda excede 2.200 caracteres.');
    if (projected.slotsPerProfile < BigInt(1)) return setMessage('Intervalo e duração precisam formar pelo menos um horário.');
    if (coverEnabled && !coverOrigin) return setMessage('Selecione a pasta/grupo das capas.');
    if (coverEnabled && !selectedCover) return setMessage('Selecione uma imagem para usar como capa.');
    if (coverEnabled && profileSelection.ids.some((id) => profiles.find((profile) => profile.id === id)?.provider !== 'zernio')) return setMessage('A capa personalizada está disponível apenas para perfis Zernio.');

    setReviewing(true);
    try {
      const response = await fetch('/api/bulk-publications/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const payload = await response.json() as ReviewResponse;
      if (!response.ok || !payload.reviewToken) throw new Error(payload.error ?? 'Não foi possível revisar o plano.');
      setReview(payload);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível revisar o plano.');
    } finally {
      setReviewing(false);
    }
  }

  async function confirmPlan() {
    if (!review) return;
    setConfirming(true);
    setMessage('');
    try {
      const response = await fetch('/api/bulk-publications/confirm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ request: review.request, reviewToken: review.reviewToken }),
      });
      const payload = await response.json() as ConfirmResponse;
      if (!response.ok || !payload.planId) throw new Error(payload.error ?? 'Não foi possível confirmar o plano.');
      setMessage(payload.created === false ? 'Este plano já havia sido confirmado.' : 'Plano confirmado e enviado para geração incremental.');
      resetDraft(false);
      await loadProgress(payload.planId, true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível confirmar o plano.');
    } finally {
      setConfirming(false);
    }
  }

  async function loadProgress(planId: string, showError: boolean, signal?: AbortSignal) {
    try {
      const response = await fetch(`/api/bulk-publications/${planId}`, { cache: 'no-store', signal });
      const payload = await response.json() as PlanProgress & { error?: string };
      if (!response.ok || !payload.planId) throw new Error(payload.error ?? 'Não foi possível acompanhar o plano.');
      setProgress(payload);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (showError) setMessage(error instanceof Error ? error.message : 'Não foi possível acompanhar o plano.');
    }
  }

  function resetDraft(clearFeedback = true) {
    setProfileSelection({ ids: [], anchorId: null });
    setName('');
    setFormat('reel');
    setOriginKey('');
    setCoverEnabled(false);
    setCoverOriginKey('');
    setCoverAssets([]);
    setSelectedCover(null);
    setCoverCursor(null);
    setCoverHasMore(false);
    setIntervalMinutes('60');
    setDurationDays('1');
    setScheduleMode('interval');
    setDailyTime('21:00');
    setOrderMode('diversified');
    setCaption('');
    setSeed(rotationSeed());
    setIdempotencyKey(requestKey());
    setReview(null);
    if (clearFeedback) {
      setProgress(null);
      setMessage('');
    }
  }

  return (
    <section className={styles.shell} aria-labelledby="bulk-publishing-title">
      <header className={styles.header}>
        <div>
          <span className="section-kicker">Plano compacto</span>
          <h2 id="bulk-publishing-title">Programar em massa</h2>
          <p>Cada perfil recebe a rotação completa. O navegador envia somente o plano, sem expandir publicações.</p>
        </div>
        {dirty && <button className={styles.subtleButton} type="button" onClick={() => resetDraft()} disabled={!canManage || confirming}>Limpar rascunho</button>}
      </header>

      {message && <p className={styles.message} role="status">{message}</p>}
      <div className={styles.workspace}>
          <aside className={styles.profilesPanel}>
            <div className={styles.panelHeader}>
              <div><strong>Perfis online</strong><small>{formatInteger(profileSelection.ids.length)} selecionados · {formatInteger(filteredProfiles.length)} disponíveis no filtro</small></div>
              <div className={styles.profileActions}>
                <button type="button" onClick={selectAllFiltered} disabled={!canManage || !filteredProfiles.length}>Selecionar todos</button>
                <button type="button" onClick={clearProfiles} disabled={!canManage || !profileSelection.ids.length}>Limpar</button>
              </div>
            </div>
            <label className={styles.profileGroupFilter}>
              <span>Filtrar perfis por grupo</span>
              <select value={profileGroupId} onChange={(event) => setProfileGroupId(event.target.value)}>
                <option value="">Sem grupo selecionado</option>
                {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
            </label>
            <input className={styles.search} type="search" value={profileSearch} onChange={(event) => setProfileSearch(event.target.value)} placeholder="Buscar perfil" aria-label="Buscar perfil online" />
            <div
              className={styles.profileList}
              onScroll={(event) => maybeRevealProfiles(event.currentTarget)}
              onWheel={(event) => {
                if (!event.shiftKey) return;
                // Em navegadores Chromium/Windows, Shift + roda pode mover o
                // delta vertical para `deltaX`. Mantemos a lista vertical
                // rolável enquanto o usuário segura Shift para o próximo
                // clique de seleção por intervalo.
                const verticalDelta = event.deltaY || event.deltaX;
                if (verticalDelta === 0) return;
                event.preventDefault();
                event.currentTarget.scrollTop += verticalDelta;
              }}
              aria-label="Lista de perfis online"
            >
              {filteredProfiles.length === 0 ? <p>Nenhum perfil online encontrado.</p> : renderedProfiles.map((profile) => {
                const metric = bulkProfileQueueMetric(profile, format);
                const selected = selectedSet.has(profile.id);
                return (
                <div
                  className={`${styles.profileRow} ${selected ? styles.profileRowActive : ''}`}
                  key={profile.id}
                  role="checkbox"
                  aria-checked={selected}
                  aria-disabled={!canManage}
                  tabIndex={canManage ? 0 : -1}
                  onClick={(event) => {
                    if (!canManage) return;
                    toggleProfile(profile.id, event.shiftKey);
                    event.currentTarget.focus();
                  }}
                  onKeyDown={(event) => {
                    if (canManage && (event.key === ' ' || event.key === 'Enter')) {
                      event.preventDefault();
                      toggleProfile(profile.id, event.shiftKey);
                    }
                  }}
                >
                  <span className={styles.profileCheckbox} aria-hidden="true">{selected ? '✓' : ''}</span>
                  {profile.profile_picture_url ? <img src={profile.profile_picture_url} alt="" /> : <span className={styles.avatar}>{profile.username.slice(0, 1).toUpperCase()}</span>}
                  <span className={styles.profileIdentity}><strong>@{profile.username}</strong><small>{profile.display_name || profile.provider}</small></span>
                  <span className={`${styles.profileQueue} ${metric.total === 0 ? styles.profileQueueEmpty : ''}`} title={`${metric.published} publicadas de ${metric.total}; ${metric.remaining} a postar`}>
                    <strong>{formatInteger(metric.published)}/{formatInteger(metric.total)}</strong>
                    <span className={styles.profileProgressTrack} aria-hidden="true"><span style={{ width: `${metric.progress}%` }} /></span>
                  </span>
                </div>
              );})}
              {renderedProfiles.length < filteredProfiles.length && <button className={styles.profileLoadMore} type="button" onClick={revealMoreProfiles}>Mostrar mais perfis ({formatInteger(filteredProfiles.length - renderedProfiles.length)})</button>}
            </div>
          </aside>

          <div className={styles.configuration}>
            <section className={styles.card}>
              <header><strong>Configuração do lote</strong><small>Nome, formato, origem única e janela móvel</small></header>
              <div className={styles.fieldGrid}>
                <label className={styles.field}>Nome do lote *<input maxLength={160} value={name} onChange={(event) => { invalidateReview(); setName(event.target.value); }} disabled={!canManage} placeholder="Ex.: campanha de setembro" /></label>
                <label className={styles.field}>Formato<select value={format} onChange={(event) => { invalidateReview(); setFormat(event.target.value as BulkFormat); }} disabled={!canManage}><option value="image">Imagem</option><option value="reel">Reel</option><option value="story">Story</option></select></label>
                <label className={`${styles.field} ${styles.wideField}`}>Origem de mídia *<select value={originKey} onChange={(event) => { invalidateReview(); setOriginKey(event.target.value); }} disabled={!canManage}><option value="">Selecione uma origem</option>{origins.map((item) => <option key={`${item.type}:${item.groupId ?? ''}`} value={`${item.type}:${item.groupId ?? ''}`}>{item.name}</option>)}</select><small>Ao trocar a origem, a seleção anterior é substituída. Todas as mídias elegíveis serão usadas.</small></label>
                <label className={`${styles.field} ${styles.wideField}`}>Esquema de horários<select value={scheduleMode} onChange={(event) => { invalidateReview(); setScheduleMode(event.target.value as BulkScheduleMode); }} disabled={!canManage}><option value="interval">Intervalo contínuo</option><option value="daily_time">Uma vez por dia em horário fixo</option></select><small>{scheduleMode === 'daily_time' ? 'Cada perfil receberá uma publicação por dia no horário de São Paulo.' : 'Os horários são calculados a partir do intervalo e da duração.'}</small></label>
                {scheduleMode === 'interval' ? <><label className={styles.field}>Intervalo (minutos)<input type="number" min="1" step="1" value={intervalMinutes} onChange={(event) => { invalidateReview(); setIntervalMinutes(event.target.value); }} disabled={!canManage} /></label><label className={styles.field}>Duração (dias de 24h)<input type="number" min="1" step="1" value={durationDays} onChange={(event) => { invalidateReview(); setDurationDays(event.target.value); }} disabled={!canManage} /></label></> : <><label className={styles.field}>Horário diário<input type="time" value={dailyTime} onChange={(event) => { invalidateReview(); setDailyTime(event.target.value); }} disabled={!canManage} /></label><label className={styles.field}>Quantidade de dias<input type="number" min="1" step="1" value={durationDays} onChange={(event) => { invalidateReview(); setDurationDays(event.target.value); }} disabled={!canManage} /></label></>}
                <label className={`${styles.field} ${styles.wideField}`}>Ordem da rotação<select value={orderMode} onChange={(event) => { invalidateReview(); setOrderMode(event.target.value as BulkOrderMode); }} disabled={!canManage}><option value="diversified">Diversificada e determinística</option><option value="same_order">Mesma ordem em todos os perfis</option></select></label>
                <label className={`${styles.field} ${styles.wideField}`}>Legenda compartilhada<textarea maxLength={2200} value={caption} onChange={(event) => { invalidateReview(); setCaption(event.target.value); }} disabled={!canManage} placeholder="Opcional. Quebras de linha serão preservadas." /><small>{caption.length.toLocaleString('pt-BR')} / 2.200 unidades UTF-16</small></label>
              </div>
            </section>

            <section className={styles.projection} aria-label="Projeção compacta">
              <div><span>Perfis</span><strong>{formatInteger(profileSelection.ids.length)}</strong></div>
              <div><span>Slots por perfil</span><strong>{formatInteger(projected.slotsPerProfile)}</strong></div>
              <div><span>Publicações projetadas</span><strong>{formatInteger(projected.expectedPublications)}</strong></div>
              <div><span>Mídias elegíveis</span><strong>{mediaSummary ? formatInteger(mediaSummary.eligible) : '—'}</strong></div>
            </section>

            <section className={styles.card}>
              <header><strong>Mídias da origem</strong><small>Prévia paginada e somente leitura</small></header>
              {!origin ? <p className={styles.empty}>Selecione uma origem para revisar elegibilidade e miniaturas.</p> : loadingMedia ? <p className={styles.loading}>Classificando mídias…</p> : mediaSummary && (
                <>
                  <div className={styles.mediaSummary}>
                    <div className={styles.eligible}><span>Aceitas</span><strong>{formatInteger(mediaSummary.eligible)}</strong></div>
                    <div><span>Incompatíveis</span><strong>{formatInteger(mediaSummary.excluded.incompatible)}</strong></div>
                    <div><span>Apagadas</span><strong>{formatInteger(mediaSummary.excluded.deleted)}</strong></div>
                    <div><span>Exclusão pendente</span><strong>{formatInteger(mediaSummary.excluded.pendingDeletion)}</strong></div>
                    <div><span>Não prontas</span><strong>{formatInteger(mediaSummary.excluded.notReady)}</strong></div>
                    <div><span>Sem arquivo</span><strong>{formatInteger(mediaSummary.excluded.missingStorage)}</strong></div>
                  </div>
                  {mediaAssets.length === 0 ? <p className={styles.empty}>Nenhuma mídia elegível para este formato.</p> : <div className={styles.thumbnailGrid}>{mediaAssets.map((asset, index) => <figure key={asset.id} title={asset.originalName}>{asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt={asset.originalName} loading="lazy" /> : <span>{asset.kind === 'video' ? 'Vídeo' : 'Imagem'}</span>}<figcaption>{index + 1}</figcaption></figure>)}</div>}
                  {mediaHasMore && <button className={styles.loadMore} type="button" onClick={() => void loadMediaPage(true)} disabled={loadingMore}>{loadingMore ? 'Carregando…' : 'Carregar mais miniaturas'}</button>}
                </>
              )}
            </section>

            {format === 'reel' && <section className={`${styles.card} ${styles.coverCard} ${coverEnabled ? styles.coverCardActive : ''}`}>
              <header className={styles.coverHeader}>
                <div><strong>Capa personalizada do Reel</strong><small>A mesma imagem será aplicada a todas as publicações deste plano</small></div>
                <button
                  className={styles.coverToggle}
                  type="button"
                  role="switch"
                  aria-checked={coverEnabled}
                  onClick={() => {
                    invalidateReview();
                    setCoverEnabled((current) => !current);
                    if (coverEnabled) {
                      setCoverOriginKey('');
                      setSelectedCover(null);
                    }
                  }}
                  disabled={!canManage}
                ><span aria-hidden="true" />{coverEnabled ? 'Ativada' : 'Desativada'}</button>
              </header>
              {coverEnabled && <div className={styles.coverBody}>
                <p className={styles.coverNotice}>Escolha uma imagem editorial vertical. O arquivo não será duplicado: o Athena criará uma URL temporária para a Zernio em cada publicação.</p>
                <label className={`${styles.field} ${styles.coverOriginField}`}>Pasta/grupo das capas *
                  <select value={coverOriginKey} onChange={(event) => { invalidateReview(); setCoverOriginKey(event.target.value); setSelectedCover(null); }} disabled={!canManage}>
                    <option value="">Selecione uma origem de capas</option>
                    {origins.map((item) => <option key={`cover:${item.type}:${item.groupId ?? ''}`} value={`${item.type}:${item.groupId ?? ''}`}>{item.name}</option>)}
                  </select>
                </label>
                {!coverOrigin ? <p className={styles.coverEmpty}>Selecione uma pasta para visualizar somente as imagens disponíveis.</p> : loadingCovers ? <p className={styles.coverLoading} role="status">Carregando capas…</p> : coverAssets.length === 0 ? <p className={styles.coverEmpty}>Nenhuma imagem elegível encontrada nesta origem.</p> : <>
                  <div className={styles.coverGrid} aria-label="Imagens disponíveis para capa">
                    {coverAssets.map((asset) => {
                      const selected = selectedCover?.id === asset.id;
                      return <button key={asset.id} type="button" className={`${styles.coverOption} ${selected ? styles.coverOptionSelected : ''}`} aria-pressed={selected} title={asset.originalName} onClick={() => { invalidateReview(); setSelectedCover(asset); }} disabled={!canManage}>
                        {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt={asset.originalName} loading="lazy" /> : <span>Imagem</span>}
                        <small>{asset.originalName}</small>
                        {selected && <b aria-hidden="true">✓</b>}
                      </button>;
                    })}
                  </div>
                  {coverHasMore && <button className={`${styles.loadMore} ${styles.coverLoadMore}`} type="button" onClick={() => void loadCoverPage(true)} disabled={loadingMoreCovers}>{loadingMoreCovers ? 'Carregando…' : 'Carregar mais capas'}</button>}
                </>}
                {selectedCover && <div className={styles.coverPreview}>
                  {selectedCover.thumbnailUrl && <img className={styles.coverPreviewImage} src={selectedCover.thumbnailUrl} alt="" />}
                  <div className={styles.coverMeta}><span>Capa selecionada</span><strong>{selectedCover.originalName}</strong><small>Será usada em {formatInteger(projected.expectedPublications)} publicações projetadas.</small></div>
                  <button type="button" className={styles.subtleButton} onClick={() => { invalidateReview(); setSelectedCover(null); }}>Remover</button>
                </div>}
              </div>}
            </section>}

            <div className={styles.reviewAction}>
              <p>{scheduleMode === 'daily_time' ? `Cada perfil receberá uma publicação por dia às ${dailyTime}, no horário de São Paulo.` : 'O primeiro horário de cada perfil será a base segura da fila mais o intervalo informado.'}</p>
              <button ref={reviewTriggerRef} className="button button-secondary" type="button" onClick={() => void reviewPlan()} disabled={!canManage || reviewing || confirming}>{reviewing ? 'Revisando…' : 'Revisar plano compacto'}</button>
            </div>
          </div>
        </div>

      {review && <div className={styles.modalBackdrop} role="presentation">
        <section ref={reviewDialogRef} className={styles.reviewModal} role="dialog" aria-modal="true" aria-labelledby="bulk-review-title" aria-describedby="bulk-review-description" tabIndex={-1}>
          <header><div><span className="section-kicker">Confirmação</span><h3 id="bulk-review-title">Revise o plano compacto</h3></div><button type="button" onClick={() => setReview(null)} disabled={confirming} aria-label="Fechar revisão">×</button></header>
          <dl className={styles.reviewGrid}>
            <div><dt>Lote</dt><dd>{review.request.name}</dd></div>
            <div><dt>Perfis online</dt><dd>{formatInteger(review.schedule.profileCount)}</dd></div>
            <div><dt>Mídias elegíveis</dt><dd>{formatInteger(review.media.eligible)}</dd></div>
            <div><dt>Slots por perfil</dt><dd>{formatInteger(review.schedule.slotsPerProfile)}</dd></div>
            <div><dt>Total projetado</dt><dd>{formatInteger(review.schedule.expectedPublications)}</dd></div>
            <div><dt>Primeira execução</dt><dd>{formatDate(review.schedule.firstExecuteAt)}</dd></div>
            <div><dt>Última execução</dt><dd>{formatDate(review.schedule.lastExecuteAt)}</dd></div>
            <div><dt>Revisão válida até</dt><dd>{formatDate(review.expiresAt)}</dd></div>
            <div><dt>Capa do Reel</dt><dd>{review.cover ? 'Personalizada' : 'Automática'}</dd></div>
          </dl>
          {review.cover && <div className={styles.reviewCover}>{review.cover.thumbnailUrl && <img src={review.cover.thumbnailUrl} alt={review.cover.originalName} />}<div><span>Origem: {review.cover.originName}</span><strong>{review.cover.originalName}</strong></div></div>}
          <p id="bulk-review-description">A confirmação cria reservas atômicas por perfil e inicia a geração incremental. Nenhuma publicação individual é enviada pelo navegador.</p>
          <footer><button className={styles.subtleButton} type="button" onClick={() => setReview(null)} disabled={confirming}>Voltar e editar</button><button className="button button-secondary" type="button" onClick={() => void confirmPlan()} disabled={confirming}>{confirming ? 'Confirmando…' : 'Confirmar programação em massa'}</button></footer>
        </section>
      </div>}

      {progress && <section className={styles.progressCard} aria-live="polite">
        <header><div><span className="section-kicker">Acompanhamento</span><h3>{progress.name}</h3></div><span className={styles.status}>{progress.status.replaceAll('_', ' ')}</span></header>
        <div className={styles.progressTrack}><span style={{ width: `${Math.min(100, progressPercent(progress))}%` }} /></div>
        <div className={styles.progressMetrics}>
          <div><span>Progresso</span><strong>{progressPercent(progress).toLocaleString('pt-BR')}%</strong></div>
          <div><span>Geradas</span><strong>{formatInteger(progress.generatedPublications)}</strong></div>
          <div><span>Suspensas</span><strong>{formatInteger(progress.suspendedPublications)}</strong></div>
          <div><span>Ignoradas</span><strong>{formatInteger(progress.ignoredPublications)}</strong></div>
          <div><span>Falhas</span><strong>{formatInteger(progress.failedPublications)}</strong></div>
          <div><span>Chunks concluídos</span><strong>{formatInteger(progress.chunks.completed)} / {formatInteger(progress.expectedChunks)}</strong></div>
        </div>
        <footer><span>Atualização automática a cada 4 segundos durante a geração.</span><Link href="/queue" prefetch={false}>Abrir fila operacional</Link></footer>
      </section>}
    </section>
  );
}
