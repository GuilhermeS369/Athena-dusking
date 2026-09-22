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
  MetaProfileActionBlock,
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

// O resumo agregado é a leitura mais cara do painel: `get_publication_queue_reference_page`
// materializa todos os itens não arquivados da organização e roda catorze agregados,
// três deles `count(distinct profile_id)`. Progresso de geração e alertas de pausa são
// consultas leves e continuam no tick de 10 s; o resumo é consultado no máximo 1×/minuto.
const SUMMARY_POLL_INTERVAL_MS = 60_000;

// Fila de cancelamento. A lista vem do servidor (operações da organização nas
// últimas 24 h) e é consultada a cada 3 s enquanto houver alguma em execução.
// Quem avança os blocos é o worker da VPS; o navegador é reserva e só chama a
// execução de uma operação que ninguém tocou há mais de 15 s.
const CANCELLATION_POLL_MS = 3_000;
const CANCELLATION_STALE_STEP_MS = 15_000;
// Depois de uma operação concluir, o resumo materializado é invalidado e o worker
// de resumo recalcula em até ~20 s. Duas releituras cobrem esse intervalo sem
// religar o poll de 60 s do resumo (que só roda com job de geração ativo).
const CANCELLATION_SUMMARY_CATCH_UP_MS = [25_000, 60_000];

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
  // Grupo escolhido para a aba "Por conta". Nulo = nada buscado ainda, e a aba
  // fica vazia. O ref espelha o estado porque refreshSummary e chamada tambem
  // pelo polling e pelo "Recarregar", fora do ciclo de render.
  const [accountGroupId, setAccountGroupId] = useState<string | null>(null);
  const accountScopeRef = useRef<string | null>(null);
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
  // Perfis com erro 9 da Meta (438). A lista vem do servidor e só some quando alguém limpa.
  const [actionBlocks, setActionBlocks] = useState<MetaProfileActionBlock[]>([]);
  const [cancellationOperations, setCancellationOperations] = useState<QueueCancellationOperation[]>([]);
  const [dismissedCancellationIds, setDismissedCancellationIds] = useState<string[]>([]);
  // Um execute por vez a partir desta aba, mesmo com várias operações correndo.
  const cancellationExecuteInFlightRef = useRef(false);
  const cancellationListInFlightRef = useRef(false);
  // Ids já vistos como concluídos, para a mensagem e a releitura do resumo
  // dispararem uma vez por operação, não a cada poll.
  const settledCancellationIdsRef = useRef<Set<string>>(new Set());

  const queueFilterSignature = [queueFilter, queueFormatFilter, queueTimingFilter, queueProfileFilter, queueGroupFilter].join('|');
  const latestQueueFilterSignatureRef = useRef(queueFilterSignature);
  const loadedQueueFilterSignatureRef = useRef(queueFilterSignature);
  const queueRequestSeqRef = useRef(0);
  const summaryRequestSeqRef = useRef<Record<QueueAggregateTab, number>>({ account: 0, batch: 0, group: 0 });
  const summaryPendingRef = useRef(0);
  // Qualquer consulta ao resumo — automática ou disparada pelo usuário — reinicia a
  // janela, para o tick não repetir logo em seguida o que acabou de ser carregado.
  const lastSummaryPollAtRef = useRef(0);
  const cancellationDismissedStorageKey = `athena.queue.cancellation-dismissed.${organizationId}`;

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
    // "Por conta" nunca busca sozinha: agrega uma linha por perfil (1.526 na
    // organização Pomodoro, contra dezenas de grupos) e é a aba que o operador
    // nem sempre quer. Ela só sai daqui depois de escolher um grupo e clicar em
    // buscar — inclusive no polling e no "Recarregar", que passam por esta mesma
    // função.
    if (scope === 'account' && !accountScopeRef.current) return;
    lastSummaryPollAtRef.current = Date.now();
    const offset = append ? currentPage.offset + currentPage.limit : 0;
    const requestSeq = summaryRequestSeqRef.current[scope] + 1;
    summaryRequestSeqRef.current[scope] = requestSeq;
    summaryPendingRef.current += 1;
    setSummaryLoading(true);
    if (!append) setSummaryErrors((current) => ({ ...current, [scope]: null }));
    try {
      const params = new URLSearchParams({ scope, limit: String(currentPage.limit), offset: String(offset) });
      // So a aba de contas recorta por grupo. Os totais do topo continuam
      // sendo da fila inteira, em qualquer aba.
      if (scope === 'account' && accountScopeRef.current && accountScopeRef.current !== 'all') {
        params.set('groupId', accountScopeRef.current);
      }
      const response = await fetch(`/api/publications/summary?${params.toString()}`, { cache: 'no-store' });
      const payload = await response.json() as {
        snapshotAt?: string | null;
        historyHours?: number;
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
          historyHours: 24,
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
          historyHours: payload.historyHours ?? previous.historyHours,
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

  async function refreshActionBlocks() {
    try {
      const response = await fetch('/api/publications/action-blocks', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json() as { blocks?: MetaProfileActionBlock[] };
      setActionBlocks(Array.isArray(payload.blocks) ? payload.blocks : []);
    } catch {
      // Falha de rede preserva a última lista; o aviso não some sozinho.
    }
  }

  async function clearActionBlocks(blockIds: string[]) {
    if (!canManage || blockIds.length === 0) return;
    const question = blockIds.length === 1
      ? 'Limpar este aviso? Os reels que foram cancelados continuam cancelados; para o perfil voltar a postar, agende de novo.'
      : `Limpar ${blockIds.length} avisos? Os reels que foram cancelados continuam cancelados; para os perfis voltarem a postar, agende de novo.`;
    if (!window.confirm(question)) return;
    setMessage('');
    setQueueActionId('action-blocks');
    try {
      const response = await fetch('/api/publications/action-blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blockIds }),
      });
      const payload = await response.json() as { blocks?: MetaProfileActionBlock[]; error?: string };
      if (!response.ok) {
        setMessage(payload.error ?? 'Não foi possível limpar os avisos.');
        return;
      }
      setActionBlocks(Array.isArray(payload.blocks) ? payload.blocks : []);
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setQueueActionId(null);
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
    await Promise.all([refreshGenerationJobs(), refreshSummary(aggregateTab), refreshPausedBatches(), refreshActionBlocks()]);
  }

  useEffect(() => {
    void Promise.all([refreshGenerationJobs(), refreshPausedBatches(), refreshActionBlocks()]);
  // Jobs e alertas sao independentes da pagina agregada ativa.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // A aba de contas e a excecao: abrir nao busca nada, quem busca e o botao.
    if (aggregateTab === 'account' && !accountScopeRef.current) return;
    void refreshSummary(aggregateTab);
  // Cada aba busca somente a sua primeira pagina; nenhum item detalhado e carregado.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aggregateTab]);

  useEffect(() => {
    // As chaves antigas guardavam UMA operação no navegador — era o que fazia o
    // segundo clique sobrescrever a primeira. Agora a lista vem do servidor; o
    // navegador só lembra quais avisos encerrados o operador já fechou.
    window.localStorage.removeItem('athena.queue.cancellation-operation');
    window.localStorage.removeItem(`athena.queue.cancellation-operation.${organizationId}`);
    try {
      const saved = window.localStorage.getItem(cancellationDismissedStorageKey);
      const ids = saved ? JSON.parse(saved) as unknown : [];
      if (Array.isArray(ids)) setDismissedCancellationIds(ids.filter((id): id is string => typeof id === 'string'));
    } catch {
      window.localStorage.removeItem(cancellationDismissedStorageKey);
    }
    settledCancellationIdsRef.current = new Set();
    void refreshCancellationOperations();
  // Roda uma vez por organização, no mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancellationDismissedStorageKey]);

  function mergeCancellationOperation(operation: QueueCancellationOperation) {
    setCancellationOperations((current) => {
      const others = current.filter((candidate) => candidate.id !== operation.id);
      return [operation, ...others];
    });
  }

  function noteSettledCancellations(operations: QueueCancellationOperation[]) {
    // Só reage a operações que esta aba viu em execução: as que já estavam
    // encerradas ao abrir a tela não devem disparar mensagem nem releitura.
    for (const operation of operations) {
      if (operation.status === 'running') {
        settledCancellationIdsRef.current.add(operation.id);
        continue;
      }
      if (!settledCancellationIdsRef.current.has(operation.id)) continue;
      settledCancellationIdsRef.current.delete(operation.id);
      if (operation.status === 'completed') {
        const cancelledItems = Number(operation.result?.cancelledItems ?? 0);
        const inFlightLeft = Number(operation.result?.inFlightItemsLeft ?? 0);
        setSelectedQueueItemId(null);
        setMessage(inFlightLeft > 0
          ? `Fila de ${operation.targetLabel ?? 'alvo'} interrompida: ${cancelledItems.toLocaleString('pt-BR')} publicação(ões) cancelada(s); ${inFlightLeft} ainda em envio terminam sozinhas.`
          : `Fila de ${operation.targetLabel ?? 'alvo'} interrompida e verificada: ${cancelledItems.toLocaleString('pt-BR')} publicação(ões) cancelada(s).`);
        for (const delay of CANCELLATION_SUMMARY_CATCH_UP_MS) {
          window.setTimeout(() => { void refreshSummary(aggregateTab); }, delay);
        }
      } else if (operation.status === 'blocked') {
        setMessage('Cancelamento bloqueado: há publicação em processamento. Nenhum item foi alterado.');
      } else {
        setMessage(operation.error ?? `Não foi possível concluir o cancelamento de ${operation.targetLabel ?? 'alvo'}.`);
      }
    }
  }

  async function refreshCancellationOperations() {
    if (cancellationListInFlightRef.current) return;
    cancellationListInFlightRef.current = true;
    try {
      const response = await fetch('/api/publications/cancel', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json() as { operations?: QueueCancellationOperation[] };
      const operations = payload.operations ?? [];
      setCancellationOperations((current) => {
        // Uma operação que esta aba acabou de iniciar pode ainda não estar na
        // lista do servidor (a resposta do POST chega antes); não a perde.
        const known = new Set(operations.map((operation) => operation.id));
        const pendingLocal = current.filter((operation) => !known.has(operation.id) && operation.status === 'running');
        return [...pendingLocal, ...operations];
      });
      noteSettledCancellations(operations);
    } catch {
      // Uma leitura perdida não derruba a tela; a próxima volta resolve.
    } finally {
      cancellationListInFlightRef.current = false;
    }
  }

  /**
   * Avança uma etapa de uma operação. O servidor devolve `busy` (202) quando o
   * worker está no meio de um bloco dela; `running` quando processou uma etapa.
   */
  async function stepCancellationOperation(operation: QueueCancellationOperation) {
    if (cancellationExecuteInFlightRef.current) return;
    cancellationExecuteInFlightRef.current = true;
    try {
      const response = await fetch('/api/publications/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ operationId: operation.id, execute: true }),
      });
      const payload = await response.json() as { operation?: QueueCancellationOperation; error?: string };
      if (payload.operation) {
        mergeCancellationOperation(payload.operation);
        noteSettledCancellations([payload.operation]);
      } else if (!response.ok && response.status !== 503) {
        setMessage(payload.error ?? 'Não foi possível avançar o cancelamento.');
      }
    } catch {
      // Rede caiu: a operação está salva; o worker ou o próximo poll retomam.
    } finally {
      cancellationExecuteInFlightRef.current = false;
    }
  }

  const hasRunningCancellation = cancellationOperations.some((operation) => operation.status === 'running');

  useEffect(() => {
    if (!hasRunningCancellation) return;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      await refreshCancellationOperations();
      // Reserva: a operação em execução parada há mais tempo, se ninguém (worker
      // ou outra aba) a tocou há mais de 15 s.
      const stale = cancellationOperations
        .filter((operation) => operation.status === 'running')
        .map((operation) => ({ operation, at: Date.parse(operation.lastChunkAt ?? operation.updatedAt ?? operation.createdAt ?? '') || 0 }))
        .sort((left, right) => left.at - right.at)[0];
      if (stale && Date.now() - stale.at > CANCELLATION_STALE_STEP_MS) await stepCancellationOperation(stale.operation);
    };
    const interval = window.setInterval(() => { void tick(); }, CANCELLATION_POLL_MS);
    return () => window.clearInterval(interval);
  // O tick lê o estado mais recente via closure recriada a cada mudança da lista.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRunningCancellation, cancellationOperations]);

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
      // Uma aba esquecida aberta durante uma geração longa não precisa pagar nada disso.
      if (document.visibilityState !== 'visible') return;
      // O progresso da geração continua ao vivo em 10 s.
      void Promise.all([refreshGenerationJobs(), refreshPausedBatches()]);
      const now = Date.now();
      if (now - lastSummaryPollAtRef.current < SUMMARY_POLL_INTERVAL_MS) return;
      lastSummaryPollAtRef.current = now;
      void refreshSummary(aggregateTab);
    }, 10000);
    return () => window.clearInterval(interval);
  // O polling é ligado/desligado pelo conjunto atual de jobs ativos.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generationJobs]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void Promise.all([refreshPausedBatches(), refreshActionBlocks()]);
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

  function dismissCancellationOperation(operationId: string) {
    setDismissedCancellationIds((current) => {
      const next = current.includes(operationId) ? current : [...current, operationId];
      try {
        window.localStorage.setItem(cancellationDismissedStorageKey, JSON.stringify(next.slice(-100)));
      } catch {
        // Sem armazenamento local a lista só não sobrevive ao F5.
      }
      return next;
    });
  }

  function runningCancellationFor(scope: 'account' | 'batch' | 'group', targetId: string) {
    return cancellationOperations.find((operation) => operation.status === 'running' && operation.scope === scope && operation.targetId === targetId) ?? null;
  }

  /**
   * Operação concluída depois do snapshot que a tela está mostrando: a linha
   * ainda exibe itens ativos que já não existem. A tela sobrepõe "Cancelada"
   * até o resumo alcançar.
   */
  function recentCompletedCancellationFor(scope: 'account' | 'batch' | 'group', targetId: string) {
    const snapshotAt = summary?.snapshotAt ? Date.parse(summary.snapshotAt) : 0;
    return cancellationOperations.find((operation) => operation.status === 'completed'
      && operation.scope === scope
      && operation.targetId === targetId
      && (Date.parse(operation.completedAt ?? '') || 0) > snapshotAt) ?? null;
  }

  async function cancelScope(scope: 'account' | 'batch' | 'group', targetId: string, targetLabel: string) {
    if (!canManage) return;
    if (!targetId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId)) {
      setMessage('Não foi possível identificar o destino do cancelamento. Recarregue a fila antes de tentar novamente.');
      return;
    }
    if (runningCancellationFor(scope, targetId)) return;
    const scopeLabel = scope === 'account' ? `a fila do perfil ${targetLabel}` : scope === 'batch' ? `o lote ${targetLabel}` : `a fila do grupo ${targetLabel}`;
    const confirmation = `Cancelar ${scopeLabel}? Isso interromperá todas as postagens ainda ativas, sem distinguir formato. Publicações já em envio terminam sozinhas; o restante é cancelado em blocos e a operação aparece na fila de cancelamento.`;
    if (!window.confirm(confirmation)) return;

    // Nada de `queueActionId` aqui: ele é um único valor para a página inteira e
    // era zerado antes de a operação terminar. O estado da linha vem da própria
    // operação (`runningCancellationFor`).
    const idempotencyKey = crypto.randomUUID();
    setMessage('');
    try {
      const response = await fetch('/api/publications/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ scope, targetId, idempotencyKey }),
      });
      const payload = await response.json() as { operation?: QueueCancellationOperation; error?: string };
      if (!response.ok || !payload.operation) {
        setMessage(payload.error ?? 'Não foi possível iniciar o cancelamento da fila selecionada.');
        return;
      }
      const operation: QueueCancellationOperation = { ...payload.operation, targetLabel: payload.operation.targetLabel ?? targetLabel, idempotencyKey };
      mergeCancellationOperation(operation);
      if (operation.status === 'running') settledCancellationIdsRef.current.add(operation.id);
      // Primeira etapa na hora: cancela as fontes e o primeiro bloco (ou tudo,
      // num escopo pequeno). As seguintes são do worker; o poll só acompanha.
      void stepCancellationOperation(operation);
    } catch {
      setMessage('Não foi possível conectar ao servidor. A fila não foi considerada cancelada; atualize para verificar o estado atual.');
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
    // O saldo vem pronto do banco, com o mesmo predicado que a RPC vai aplicar.
    // Somar ok + errors + closed aqui deixou de funcionar quando `ok` passou a
    // incluir o publicado já arquivado (migration 337): o botão prometeria
    // limpar milhares de itens que não têm mais nada a arquivar.
    const cleanableCount = summary?.totals.pendingArchive ?? 0;
    if (!cleanableCount || !window.confirm(`Limpar ${cleanableCount} publicação(ões) encerrada(s) da fila? Isso inclui publicadas e canceladas, além de falhas que já esgotaram as tentativas. O histórico será preservado.`)) return;
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

  /**
   * Busca a aba "Por conta" para um escopo escolhido: o id de um grupo, ou
   * 'all' para todos os perfis. E o unico caminho que carrega essa aba.
   */
  function searchAccounts(scope: string) {
    if (!scope) return;
    accountScopeRef.current = scope;
    setAccountGroupId(scope);
    setSummaryPages((current) => ({ ...current, account: { ...current.account, offset: 0 } }));
    void refreshSummary('account');
  }

  function clearAccountScope() {
    accountScopeRef.current = null;
    setAccountGroupId(null);
    setSummaryLoadedScopes((current) => ({ ...current, account: false }));
    setSummaryErrors((current) => ({ ...current, account: null }));
  }

  return {
    accountGroupId,
    searchAccounts,
    clearAccountScope,
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
    cancellationOperations,
    dismissedCancellationIds,
    runningCancellationFor,
    recentCompletedCancellationFor,
    refreshQueue,
    refreshGenerationJobs,
    refreshSummary,
    refreshPausedBatches,
    actionBlocks,
    refreshActionBlocks,
    clearActionBlocks,
    refreshAll,
    handleQueueAction,
    resumeBatchProfile,
    continueBatch,
    cancelBatch,
    cancelVisibleBatches,
    cancelScope,
    dismissCancellationOperation,
    cancelGenerationJob,
    cleanFinished,
    clearFilters,
    openPublicationDetails,
  };
}
