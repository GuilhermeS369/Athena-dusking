'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  Batch,
  PublicationGenerationJob,
  QueueAggregateTab,
  QueueCursor,
  QueueCancellationOperation,
  QueueFormatFilter,
  QueueGroup,
  PausedPublicationBatchSummary,
  QueueResumption,
  QueueSummary,
  QueueSummaryPage,
  QueueStatusFilter,
  QueueTimingFilter,
} from './publication-queue-types';
import {
  activeGenerationJobStatuses,
  batchItemStatuses,
  cancelableGenerationJobStatuses,
  isQueueItemCancelable,
  uniqueBatches,
} from './publication-queue-utils';

export function usePublicationQueue({
  initialBatches,
  groups,
  canManage,
  organizationId,
  aggregateTab,
}: {
  initialBatches: Batch[];
  groups: QueueGroup[];
  canManage: boolean;
  organizationId: string;
  aggregateTab: QueueAggregateTab;
}) {
  const [batches, setBatches] = useState(initialBatches);
  const [message, setMessage] = useState('');
  const [queueActionId, setQueueActionId] = useState<string | null>(null);
  const [queueFilter, setQueueFilter] = useState<QueueStatusFilter>('all');
  const [queueFormatFilter, setQueueFormatFilter] = useState<QueueFormatFilter>('all');
  const [queueTimingFilter, setQueueTimingFilter] = useState<QueueTimingFilter>('all');
  const [queueProfileFilter, setQueueProfileFilter] = useState('all');
  const [queueGroupFilter, setQueueGroupFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  const [queueLoaded, setQueueLoaded] = useState(initialBatches.length > 0);
  const [queueCursor, setQueueCursor] = useState<QueueCursor | null>(null);
  const [hasMoreBatches, setHasMoreBatches] = useState(true);
  const [loadingMoreBatches, setLoadingMoreBatches] = useState(false);
  const [selectedQueueItemId, setSelectedQueueItemId] = useState<string | null>(null);
  const [selectedMediaIndex, setSelectedMediaIndex] = useState(0);
  const [queueItemDisplayLimits, setQueueItemDisplayLimits] = useState<Record<string, number>>({});
  const [generationJobs, setGenerationJobs] = useState<PublicationGenerationJob[]>([]);
  const [generationJobsLoaded, setGenerationJobsLoaded] = useState(false);
  const [generationJobsLoading, setGenerationJobsLoading] = useState(false);
  const [generationJobActionId, setGenerationJobActionId] = useState<string | null>(null);
  const [summary, setSummary] = useState<QueueSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryErrors, setSummaryErrors] = useState<Record<QueueAggregateTab, string | null>>({ account: null, batch: null, group: null });
  const [summaryLoadedScopes, setSummaryLoadedScopes] = useState<Record<QueueAggregateTab, boolean>>({ account: false, batch: false, group: false });
  const [summaryPages, setSummaryPages] = useState<Record<QueueAggregateTab, QueueSummaryPage>>({
    account: { scope: 'account', offset: 0, limit: 25, totalCount: 0, hasMore: false },
    batch: { scope: 'batch', offset: 0, limit: 25, totalCount: 0, hasMore: false },
    group: { scope: 'group', offset: 0, limit: 25, totalCount: 0, hasMore: false },
  });
  const [pausedBatches, setPausedBatches] = useState<PausedPublicationBatchSummary>({
    snapshotAt: null,
    total: 0,
    blockedItems: 0,
    batches: [],
  });
  const [cancellationOperation, setCancellationOperation] = useState<QueueCancellationOperation | null>(null);

  const queueFilterSignature = [queueFilter, queueFormatFilter, queueTimingFilter, queueProfileFilter, queueGroupFilter].join('|');
  const latestQueueFilterSignatureRef = useRef(queueFilterSignature);
  const loadedQueueFilterSignatureRef = useRef(queueFilterSignature);
  const queueRequestSeqRef = useRef(0);
  const summaryRequestSeqRef = useRef<Record<QueueAggregateTab, number>>({ account: 0, batch: 0, group: 0 });
  const summaryPendingRef = useRef(0);
  const cancellationStorageKey = `athena.queue.cancellation-operation.${organizationId}`;

  function appendQueueFilterParams(params: URLSearchParams) {
    if (queueFilter !== 'all' && queueFilter !== 'acknowledged_failed') params.set('status', queueFilter);
    if (queueFilter === 'acknowledged_failed') params.set('acknowledgedFailures', 'only');
    else if (queueFilter === 'all' || queueFilter === 'failed') params.set('acknowledgedFailures', 'exclude');
    if (queueFormatFilter !== 'all') params.set('format', queueFormatFilter);
    if (queueTimingFilter !== 'all') params.set('timing', queueTimingFilter);
    if (queueProfileFilter !== 'all') params.set('profileId', queueProfileFilter);
    if (queueGroupFilter !== 'all') params.set('groupId', queueGroupFilter);
  }

  async function refreshSummary(scope: QueueAggregateTab = aggregateTab, append = false) {
    const currentPage = summaryPages[scope];
    if (append && (!currentPage.hasMore || summaryLoading)) return;
    const offset = append ? currentPage.offset + currentPage.limit : 0;
    const requestSeq = summaryRequestSeqRef.current[scope] + 1;
    summaryRequestSeqRef.current[scope] = requestSeq;
    summaryPendingRef.current += 1;
    setSummaryLoading(true);
    if (!append) setSummaryErrors((current) => ({ ...current, [scope]: null }));
    try {
      const params = new URLSearchParams({ scope, limit: String(currentPage.limit), offset: String(offset) });
      const response = await fetch(`/api/publications/summary?${params.toString()}`, { cache: 'no-store' });
      const payload = await response.json() as {
        snapshotAt?: string | null;
        totals?: QueueSummary['totals'];
        rows?: QueueSummary['accounts'];
        page?: QueueSummaryPage;
        error?: string;
      };
      if (!response.ok || !payload.totals || !payload.page || !Array.isArray(payload.rows)) {
        throw new Error(payload.error ?? 'Não foi possível carregar o resumo da fila.');
      }
      if (summaryRequestSeqRef.current[scope] !== requestSeq) return;
      setSummary((current) => {
        const previous = current ?? {
          snapshotAt: null,
          totals: payload.totals!,
          accounts: [],
          batches: [],
          groups: [],
        };
        const key = scope === 'account' ? 'accounts' : scope === 'batch' ? 'batches' : 'groups';
        const existingRows = append ? previous[key] : [];
        const byId = new Map(existingRows.map((row) => [row.id, row]));
        payload.rows!.forEach((row) => byId.set(row.id, row));
        return {
          ...previous,
          snapshotAt: payload.snapshotAt ?? null,
          totals: payload.totals!,
          [key]: [...byId.values()],
        };
      });
      setSummaryPages((current) => ({ ...current, [scope]: payload.page! }));
      setSummaryLoadedScopes((current) => ({ ...current, [scope]: true }));
      setSummaryErrors((current) => ({ ...current, [scope]: null }));
    } catch (error) {
      if (summaryRequestSeqRef.current[scope] === requestSeq) {
        setSummaryErrors((current) => ({
          ...current,
          [scope]: error instanceof Error ? error.message : 'Não foi possível carregar o resumo da fila.',
        }));
      }
    } finally {
      summaryPendingRef.current = Math.max(0, summaryPendingRef.current - 1);
      if (summaryPendingRef.current === 0) setSummaryLoading(false);
    }
  }

  async function refreshPausedBatches() {
    try {
      const response = await fetch('/api/publications/paused-batches', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json() as PausedPublicationBatchSummary;
      setPausedBatches({
        snapshotAt: payload.snapshotAt ?? null,
        total: Number(payload.total ?? 0),
        blockedItems: Number(payload.blockedItems ?? 0),
        batches: Array.isArray(payload.batches) ? payload.batches : [],
      });
    } catch {
      // O alerta preserva o ultimo snapshot valido; falha de rede nao apaga
      // uma pausa ja visivel nem interfere na fila.
    }
  }

  async function refreshQueue(append = false, force = false) {
    if (append && (!queueCursor || !hasMoreBatches || loadingMoreBatches)) return;
    if (!append && refreshing && !force) return;

    const requestFilterSignature = queueFilterSignature;
    const requestSeq = append ? queueRequestSeqRef.current : queueRequestSeqRef.current + 1;
    if (!append) queueRequestSeqRef.current = requestSeq;
    if (append) setLoadingMoreBatches(true);
    else setRefreshing(true);
    try {
      const params = new URLSearchParams({ limit: append ? '10' : '5' });
      appendQueueFilterParams(params);
      if (append && queueCursor) {
        params.set('cursorCreatedAt', queueCursor.createdAt);
        params.set('cursorId', queueCursor.id);
      }
      const response = await fetch(`/api/publications?${params.toString()}`, { cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json() as {
        batches?: Batch[];
        hasMore?: boolean;
        nextCursor?: QueueCursor | null;
      };
      if (payload.batches) {
        if (requestFilterSignature !== latestQueueFilterSignatureRef.current || (!append && requestSeq !== queueRequestSeqRef.current)) return;
        setBatches((current) => uniqueBatches(append ? [...current, ...payload.batches!] : payload.batches!));
        setQueueCursor(payload.nextCursor ?? null);
        setHasMoreBatches(payload.hasMore ?? false);
        setQueueLoaded(true);
      }
    } finally {
      if (append) setLoadingMoreBatches(false);
      else setRefreshing(false);
    }
  }

  async function refreshGenerationJobs() {
    if (generationJobsLoading) return;
    setGenerationJobsLoading(true);
    try {
      const response = await fetch('/api/publication-generation-jobs?limit=8', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json() as { jobs?: PublicationGenerationJob[] };
      setGenerationJobs(payload.jobs ?? []);
      setGenerationJobsLoaded(true);
    } finally {
      setGenerationJobsLoading(false);
    }
  }

  async function refreshAll(_force = false) {
    await Promise.all([refreshGenerationJobs(), refreshSummary(aggregateTab), refreshPausedBatches()]);
  }

  useEffect(() => {
    void Promise.all([refreshGenerationJobs(), refreshPausedBatches()]);
  // Jobs e alertas sao independentes da pagina agregada ativa.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refreshSummary(aggregateTab);
  // Cada aba busca somente a sua primeira pagina; nenhum item detalhado e carregado.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aggregateTab]);

  useEffect(() => {
    // A chave antiga não era isolada por organização e podia fazer uma operação
    // já encerrada em outra conta reaparecer como se ainda estivesse rodando.
    window.localStorage.removeItem('athena.queue.cancellation-operation');
    const saved = window.localStorage.getItem(cancellationStorageKey);
    if (!saved) return;
    try {
      const operation = JSON.parse(saved) as QueueCancellationOperation;
      if (operation?.id) setCancellationOperation(operation);
    } catch {
      window.localStorage.removeItem(cancellationStorageKey);
    }
  }, [cancellationStorageKey]);

  function persistCancellationOperation(operation: QueueCancellationOperation | null) {
    setCancellationOperation(operation);
    if (!operation) window.localStorage.removeItem(cancellationStorageKey);
    else window.localStorage.setItem(cancellationStorageKey, JSON.stringify(operation));
  }

  useEffect(() => {
    latestQueueFilterSignatureRef.current = queueFilterSignature;
    if (loadedQueueFilterSignatureRef.current === queueFilterSignature) return;

    loadedQueueFilterSignatureRef.current = queueFilterSignature;
    setQueueItemDisplayLimits({});
    setSelectedQueueItemId(null);
    setQueueCursor(null);
    setHasMoreBatches(true);
    setBatches([]);
    setQueueLoaded(false);
    void refreshQueue(false, true);
  // Recarrega a fila do início quando qualquer filtro muda para manter paginação e resultados alinhados.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueFilterSignature]);

  useEffect(() => {
    if (!generationJobs.some((job) => activeGenerationJobStatuses.has(job.status))) return;
    const interval = window.setInterval(() => {
      void refreshAll(true);
    }, 10000);
    return () => window.clearInterval(interval);
  // O polling é ligado/desligado pelo conjunto atual de jobs ativos.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generationJobs]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshPausedBatches();
    };
    const interval = window.setInterval(refreshWhenVisible, 10_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  // Consulta leve e independente de jobs para nunca esconder uma pausa operacional.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleBatches = batches.map((batch) => ({
    ...batch,
    publication_items: (batch.publication_items ?? []).filter((item) => {
      const failureAcknowledged = Boolean(item.publication_failure_acknowledgements?.length);
      const statusMatches = queueFilter === 'acknowledged_failed'
        ? item.status === 'failed' && failureAcknowledged
        : (queueFilter === 'all'
          ? !(item.status === 'failed' && failureAcknowledged)
          : (queueFilter === 'failed'
            ? item.status === 'failed' && !failureAcknowledged
            : (queueFilter === 'scheduled' && ['waiting', 'ready'].includes(item.status))
              || (queueFilter === 'processing' && ['preparing', 'publishing'].includes(item.status))
              || item.status === queueFilter));
      const formatMatches = queueFormatFilter === 'all' || item.format === queueFormatFilter;
      const timingMatches = queueTimingFilter === 'all'
        || (queueTimingFilter === 'immediate' && !item.execute_at)
        || (queueTimingFilter === 'scheduled' && Boolean(item.execute_at));
      const profileMatches = queueProfileFilter === 'all' || item.profile_id === queueProfileFilter;
      const groupMatches = queueGroupFilter === 'all'
        || (queueGroupFilter === 'none'
          ? !groups.some((group) => (group.profile_group_members ?? []).some((member) => member.profile_id === item.profile_id))
          : groups.some((group) => group.id === queueGroupFilter && (group.profile_group_members ?? []).some((member) => member.profile_id === item.profile_id)));
      return statusMatches && formatMatches && timingMatches && profileMatches && groupMatches;
    }),
  })).filter((batch) => (batch.publication_items ?? []).length > 0);

  const selectedQueueItem = useMemo(() => batches
    .flatMap((batch) => (batch.publication_items ?? []).map((item) => ({ batch, item })))
    .find(({ item }) => item.id === selectedQueueItemId) ?? null, [batches, selectedQueueItemId]);

  async function handleQueueAction(itemId: string, action: 'cancel' | 'retry') {
    if (!canManage) return;
    setMessage('');
    setQueueActionId(itemId);
    try {
      const response = await fetch(`/api/publications/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json() as { item?: { status: string }; error?: string };
      if (!response.ok || !payload.item) {
        setMessage(payload.error ?? 'Não foi possível atualizar a publicação.');
        return;
      }

      setBatches((current) => current.map((batch) => ({
        ...batch,
        publication_items: (batch.publication_items ?? []).map((item) => item.id === itemId
          ? { ...item, status: payload.item!.status, last_error_message: action === 'retry' ? null : item.last_error_message }
          : item),
      })));
      setMessage(action === 'cancel' ? 'Publicação cancelada.' : 'Publicação devolvida à fila para reprocessamento.');
      void refreshSummary();
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setQueueActionId(null);
    }
  }

  async function resumeBatchProfile(batchId: string, profileId: string) {
    if (!canManage) return;
    if (!window.confirm('Retomar somente este lote para este perfil? Horários vencidos serão encerrados e o restante será redistribuído depois da fila atual.')) return;

    setMessage('');
    setQueueActionId(`resume:${batchId}:${profileId}`);
    try {
      const response = await fetch(
        `/api/publications/batch/${batchId}/profiles/${profileId}/resume`,
        { method: 'POST' },
      );
      const payload = await response.json() as {
        resumption?: QueueResumption;
        error?: string;
      };
      if (!response.ok || !payload.resumption) {
        setMessage(payload.error ?? 'Não foi possível retomar as publicações.');
        return;
      }

      const resumed = BigInt(payload.resumption.resumedItems)
        + BigInt(payload.resumption.resumedCompactSlots);
      const ignored = BigInt(payload.resumption.ignoredItems)
        + BigInt(payload.resumption.ignoredCompactSlots);
      setSelectedQueueItemId(null);
      setMessage(`${resumed.toLocaleString('pt-BR')} publicação(ões) restante(s) retomada(s); ${ignored.toLocaleString('pt-BR')} horário(s) vencido(s) encerrado(s).`);
      await refreshAll(true);
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setQueueActionId(null);
    }
  }

  async function continueBatch(batchId: string) {
    if (!canManage) return;
    if (!window.confirm('Continuar este lote? Todos os horários anteriores a agora serão ignorados. Publicações já concluídas e a falha original serão preservadas; apenas o próximo horário disponível e os seguintes poderão ser processados.')) return;

    setMessage('');
    setQueueActionId(`continue:${batchId}`);
    try {
      const response = await fetch(`/api/publications/batch/${batchId}/continue`, { method: 'POST' });
      const payload = await response.json() as {
        continuation?: { ignoredItems?: number; continuedItems?: number };
        error?: string;
      };
      if (!response.ok || !payload.continuation) {
        setMessage(payload.error ?? 'Não foi possível continuar o lote.');
        return;
      }
      setMessage(`Lote liberado: ${payload.continuation.ignoredItems ?? 0} horário(s) anterior(es) ignorado(s) e ${payload.continuation.continuedItems ?? 0} publicação(ões) futura(s) mantida(s) na fila.`);
      await refreshAll(true);
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setQueueActionId(null);
    }
  }

  async function cancelBatch(batchId: string, scope: 'entire_batch' | 'visible_items', visibleItemIds: string[] = []) {
    if (!canManage) return;
    if (scope === 'entire_batch') {
      const batch = batches.find((candidate) => candidate.id === batchId);
      await cancelScope('batch', batchId, batch?.name || 'selecionado');
      return;
    }
    const targetCount = visibleItemIds.length;
    const label = `${targetCount} item(ns) exibido(s)`;
    if (!targetCount || !window.confirm(`Cancelar ${label}? Itens já publicados ou encerrados serão mantidos.`)) return;

    setMessage('');
    setQueueActionId(`batch:${batchId}:${scope}`);
    try {
      const response = await fetch(`/api/publications/batch/${batchId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, itemIds: scope === 'visible_items' ? visibleItemIds : undefined }),
      });
      const payload = await response.json() as {
        batch?: { id: string; status: string; updated_at?: string };
        cancelledItemIds?: string[];
        skippedItemIds?: string[];
        error?: string;
      };
      if (!response.ok || !payload.cancelledItemIds || !payload.batch) {
        setMessage(payload.error ?? 'Não foi possível cancelar as publicações do lote.');
        return;
      }
      const cancelledIds = new Set(payload.cancelledItemIds);
      setBatches((current) => current.map((batch) => batch.id !== batchId ? batch : {
        ...batch,
        status: payload.batch!.status,
        updated_at: payload.batch!.updated_at ?? batch.updated_at,
        publication_items: (batch.publication_items ?? []).map((item) => cancelledIds.has(item.id)
          ? { ...item, status: 'cancelled', cancelled_at: new Date().toISOString() }
          : item),
      }));
      const skipped = payload.skippedItemIds?.length ?? 0;
      setMessage(`${payload.cancelledItemIds.length} publicação(ões) cancelada(s)${skipped ? `; ${skipped} item(ns) do lote foram mantidos.` : '.'}`);
      void refreshSummary();
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setQueueActionId(null);
    }
  }

  async function cancelVisibleBatches() {
    const targets = visibleBatches.map((batch) => ({
      batchId: batch.id,
      itemIds: batchItemStatuses(batch).filter(isQueueItemCancelable).map((item) => item.id),
    })).filter((target) => target.itemIds.length > 0);
    const total = targets.reduce((sum, target) => sum + target.itemIds.length, 0);
    if (!total || !window.confirm(`Cancelar ${total} item(ns) cancelável(eis) visível(eis)?`)) return;

    setMessage('');
    setQueueActionId('visible:cancel');
    try {
      for (const target of targets) {
        await cancelBatch(target.batchId, 'visible_items', target.itemIds);
      }
    } finally {
      setQueueActionId(null);
    }
  }

  async function runCancellation(operation: QueueCancellationOperation, execute = false) {
    setQueueActionId(`scope:${operation.scope}:${operation.targetId}`);
    try {
      // O polling consulta somente o registro durável. A mutação SQL é longa e
      // não pode ser reenviada a cada três segundos, pois a nova chamada ficava
      // esperando o lock da primeira e ocultava o estado real da operação.
      const statusResponse = await fetch(`/api/publications/cancel?operationId=${encodeURIComponent(operation.id)}`, { cache: 'no-store' });
      const statusPayload = await statusResponse.json() as { operation?: { status: QueueCancellationOperation['status']; progress: number; result?: Record<string, unknown>; error?: string | null }; error?: string };
      if (statusPayload.operation) {
        const updated = { ...operation, ...statusPayload.operation };
        persistCancellationOperation(updated);
        if (updated.status === 'running' && !execute) return;
        if (updated.status === 'blocked') setMessage('Cancelamento bloqueado: há publicação em processamento. Nenhum item foi alterado.');
        else if (updated.status === 'completed') {
          const cancelledItems = Number(updated.result?.cancelledItems ?? 0);
          setSelectedQueueItemId(null);
          setMessage(`Fila interrompida e verificada: ${cancelledItems.toLocaleString('pt-BR')} publicação(ões) cancelada(s).`);
          await refreshAll(true);
        }
        if (updated.status !== 'running') return;
      }
      if (!execute) return;
      const response = await fetch('/api/publications/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ scope: operation.scope, targetId: operation.targetId, idempotencyKey: operation.idempotencyKey, execute: true }),
      });
      const payload = await response.json() as { operation?: { status: QueueCancellationOperation['status']; progress: number; result?: Record<string, unknown>; error?: string | null; createdAt?: string | null }; error?: string };
      const updated = payload.operation ? { ...operation, ...payload.operation } : { ...operation, status: 'failed' as const, progress: 100, error: payload.error ?? 'Não foi possível confirmar o cancelamento.' };
      persistCancellationOperation(updated);
      if (response.status === 409 || updated.status === 'blocked') {
        setMessage('Cancelamento bloqueado: há publicação em processamento. Nenhum item foi alterado.');
        return;
      }
      if (!response.ok || updated.status !== 'completed') {
        setMessage(updated.error ?? payload.error ?? 'Não foi possível confirmar o cancelamento da fila selecionada.');
        return;
      }
      const cancelledItems = Number(updated.result?.cancelledItems ?? 0);
      setSelectedQueueItemId(null);
      setMessage(`Fila interrompida e verificada: ${cancelledItems.toLocaleString('pt-BR')} publicação(ões) cancelada(s).`);
      await refreshAll(true);
    } catch {
      persistCancellationOperation({ ...operation, status: 'running', error: 'A conexão foi interrompida; a operação será retomada automaticamente ao atualizar.' });
      setMessage('Não foi possível conectar ao servidor. A operação ficou salva e será retomada ao atualizar a página.');
    } finally {
      setQueueActionId(null);
    }
  }

  async function resumeCancellationOperation() {
    if (!cancellationOperation || cancellationOperation.status !== 'running') return;
    // A primeira execução pode ter sido interrompida por timeout/rede. Reusar a
    // mesma chave idempotente retoma a mutação; a RPC serializa concorrência e
    // devolve imediatamente se outra tentativa já a concluiu.
    await runCancellation(cancellationOperation, true);
  }

  function dismissCancellationOperation() {
    persistCancellationOperation(null);
  }

  async function cancelScope(scope: 'account' | 'batch' | 'group', targetId: string, targetLabel: string) {
    if (!canManage) return;
    if (!targetId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId)) {
      setMessage('Não foi possível identificar o destino do cancelamento. Recarregue a fila antes de tentar novamente.');
      return;
    }
    const scopeLabel = scope === 'account' ? `a fila do perfil ${targetLabel}` : scope === 'batch' ? `o lote ${targetLabel}` : `a fila do grupo ${targetLabel}`;
    const confirmation = `Cancelar ${scopeLabel}? Isso interromperá todas as postagens ainda ativas, sem distinguir formato. Se alguma já estiver sendo enviada ao provedor, nada será cancelado até que ela termine.`;
    if (!window.confirm(confirmation)) return;

    const actionId = `scope:${scope}:${targetId}`;
    const idempotencyKey = crypto.randomUUID();
    setMessage('');
    setQueueActionId(actionId);
    try {
      const response = await fetch('/api/publications/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, targetId, idempotencyKey }),
      });
      const payload = await response.json() as { operation?: { id: string; status: QueueCancellationOperation['status']; progress: number; result?: Record<string, unknown>; error?: string | null; createdAt?: string | null }; error?: string };
      if (!response.ok || !payload.operation) {
        setMessage(payload.error ?? 'Não foi possível iniciar o cancelamento da fila selecionada.');
        return;
      }
      const operation: QueueCancellationOperation = { ...payload.operation, scope, targetId, targetLabel, idempotencyKey };
      persistCancellationOperation(operation);
      // Dispara a execução uma vez; os polls posteriores só leem o progresso.
      void runCancellation(operation, true);
    } catch {
      setMessage('Não foi possível conectar ao servidor. A fila não foi considerada cancelada; atualize para verificar o estado atual.');
    } finally {
      setQueueActionId(null);
    }
  }

  async function cancelGenerationJob(job: PublicationGenerationJob) {
    if (!canManage || !cancelableGenerationJobStatuses.has(job.status)) return;
    if (!window.confirm('Cancelar este agendamento grande? Chunks pendentes serão interrompidos e publicações já geradas que ainda não foram publicadas serão canceladas.')) return;

    setMessage('');
    setGenerationJobActionId(job.id);
    try {
      const response = await fetch(`/api/publication-generation-jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      });
      const payload = await response.json() as {
        job?: PublicationGenerationJob;
        cancelledItems?: number;
        preservedItems?: number;
        error?: string;
      };
      if (!response.ok || !payload.job) {
        setMessage(payload.error ?? 'Não foi possível cancelar o job grande.');
        return;
      }

      setGenerationJobs((current) => current.map((candidate) => candidate.id === job.id ? { ...candidate, ...payload.job! } : candidate));
      await refreshSummary();
      setMessage(`Job grande cancelado. ${payload.cancelledItems ?? 0} publicação(ões) cancelada(s); ${payload.preservedItems ?? 0} já estavam encerrada(s) e foram mantidas.`);
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setGenerationJobActionId(null);
    }
  }

  async function cleanFinished() {
    if (!canManage) return;
    const completedCount = summary?.totals.ok ?? 0;
    const failureCount = summary?.totals.errors ?? 0;
    const closedCount = summary?.totals.closed ?? 0;
    const cleanableCount = completedCount + failureCount + closedCount;
    if (!cleanableCount || !window.confirm(`Limpar ${cleanableCount} publicação(ões) encerrada(s) da fila? Isso inclui publicadas, canceladas e falhas. O histórico será preservado.`)) return;
    setMessage('');
    setQueueActionId('queue:clean_finished');
    try {
      let archivedCompleted = 0;
      let archivedFailures = 0;
      let remaining = cleanableCount;
      let capacityWaits = 0;
      do {
        const response = await fetch('/api/publications/queue-actions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'clean_finished' }),
        });
        const payload = await response.json() as { archivedCompleted?: number; archivedFailures?: number; remaining?: number; busy?: boolean; error?: string };
        if (!response.ok) {
          const partial = archivedCompleted + archivedFailures;
          setMessage(`${payload.error ?? 'Não foi possível limpar todas as publicações encerradas.'}${partial ? ` ${partial.toLocaleString('pt-BR')} item(ns) já foram arquivados com segurança.` : ''}`);
          return;
        }
        if (payload.busy) {
          capacityWaits += 1;
          if (capacityWaits >= 120) {
            setMessage('A limpeza ficou aguardando capacidade por dois minutos. Nada foi perdido; tente novamente quando as tarefas pesadas atuais avançarem.');
            return;
          }
          setMessage('A limpeza está aguardando capacidade para não sobrecarregar publicações, sincronização e o painel.');
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          continue;
        }
        capacityWaits = 0;
        archivedCompleted += payload.archivedCompleted ?? 0;
        archivedFailures += payload.archivedFailures ?? 0;
        remaining = payload.remaining ?? 0;
        if (remaining > 0 && (payload.archivedCompleted ?? 0) + (payload.archivedFailures ?? 0) === 0) {
          setMessage(`A limpeza foi pausada porque outro processo está alterando os itens encerrados. ${remaining.toLocaleString('pt-BR')} item(ns) ainda precisam ser limpos; tente novamente em instantes.`);
          return;
        }
        if (remaining > 0) {
          setMessage(`Limpando em blocos… ${(archivedCompleted + archivedFailures).toLocaleString('pt-BR')} arquivada(s), ${remaining.toLocaleString('pt-BR')} restante(s).`);
          await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
      } while (remaining > 0);
      setMessage(`Fila limpa: ${archivedCompleted.toLocaleString('pt-BR')} concluída(s)/cancelada(s) e ${archivedFailures.toLocaleString('pt-BR')} falha(s) arquivada(s). O histórico foi preservado.`);
      await refreshAll(true);
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setQueueActionId(null);
    }
  }

  function clearFilters() {
    setQueueFilter('all');
    setQueueFormatFilter('all');
    setQueueTimingFilter('all');
    setQueueProfileFilter('all');
    setQueueGroupFilter('all');
  }

  function openPublicationDetails(itemId: string) {
    setSelectedQueueItemId(itemId);
    setSelectedMediaIndex(0);
  }

  return {
    batches,
    visibleBatches,
    message,
    setMessage,
    queueActionId,
    queueFilter,
    setQueueFilter,
    queueFormatFilter,
    setQueueFormatFilter,
    queueTimingFilter,
    setQueueTimingFilter,
    queueProfileFilter,
    setQueueProfileFilter,
    queueGroupFilter,
    setQueueGroupFilter,
    refreshing,
    queueLoaded,
    hasMoreBatches,
    loadingMoreBatches,
    queueItemDisplayLimits,
    setQueueItemDisplayLimits,
    selectedQueueItem,
    selectedMediaIndex,
    setSelectedMediaIndex,
    setSelectedQueueItemId,
    generationJobs,
    generationJobsLoaded,
    generationJobsLoading,
    generationJobActionId,
    summary,
    summaryPages,
    summaryLoadedScopes,
    summaryErrors,
    pausedBatches,
    summaryLoading,
    cancellationOperation,
    refreshQueue,
    refreshGenerationJobs,
    refreshSummary,
    refreshPausedBatches,
    refreshAll,
    handleQueueAction,
    resumeBatchProfile,
    continueBatch,
    cancelBatch,
    cancelVisibleBatches,
    cancelScope,
    resumeCancellationOperation,
    dismissCancellationOperation,
    cancelGenerationJob,
    cleanFinished,
    clearFilters,
    openPublicationDetails,
  };
}
