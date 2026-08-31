'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DEFAULT_RECOVERY_ADJUSTMENT,
  RECOVERY_ADJUSTMENTS,
  RECOVERY_GROUP_STATUS_HINTS,
  RECOVERY_GROUP_STATUS_LABELS,
  RECOVERY_REASON_LABELS,
  type RecoveryAdjustment,
} from '@/lib/recovery/ruler';
import type {
  RecoveryCandidate,
  RecoveryCohortItem,
  RecoveryGroupCard,
  RecoveryMilestone,
  RecoveryOverview,
  RecoverySeriesPoint,
} from '@/lib/recovery/snapshot';
import {
  RECOVERY_VERDICT_HINTS,
  RECOVERY_VERDICT_LABELS,
  formatZeroViewRate,
  type RecoveryVerdict,
} from '@/lib/recovery/verdict';

import styles from './recovery.module.css';

type Tab = 'eligible' | 'cohort' | 'history';

type Props = {
  organizationName: string;
  canManage: boolean;
  initialOverview: RecoveryOverview | null;
  initialCandidates: RecoveryCandidate[];
  initialCandidatesHasMore: boolean;
  initialCohort: RecoveryCohortItem[];
};

type CohortSeries = {
  points: Array<{ d: string; cohort: number | null; origin: number | null; zeroRate: number | null; n: number }>;
  milestones: RecoveryMilestone[];
};

const numberFormat = new Intl.NumberFormat('pt-BR');

function formatDecimal(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const percent = value * 100;
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

function formatDay(value: string | null | undefined) {
  if (!value) return '—';
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}/${month}${year ? '' : ''}`;
}

/**
 * O tipo da leva é inferido do nome do arquivo no upload. 'mixed' é um estado
 * real e vale dizer: uma leva que junta reprocessado e comum não é legível para
 * o experimento, e esconder isso atrás de um dos dois rótulos seria pior.
 */
function milestoneLabel(milestone: RecoveryMilestone) {
  const count = `${milestone.mediaCount} ${milestone.mediaCount === 1 ? 'mídia' : 'mídias'}`;
  if (milestone.batchKind === 'reprocessed') return `${count} · reprocessada`;
  if (milestone.batchKind === 'common') return `${count} · comum`;
  if (milestone.batchKind === 'mixed') return `${count} · leva mista`;
  return count;
}

function daysBetween(from: string | null | undefined) {
  if (!from) return null;
  const start = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.floor((Date.now() - start) / 86_400_000));
}

/* ------------------------------------------------------------------ */
/* Sparkline do card de grupo                                          */
/* ------------------------------------------------------------------ */

function Sparkline({
  series,
  threshold,
  milestones,
}: {
  series: RecoverySeriesPoint[];
  threshold: number | null;
  milestones: RecoveryMilestone[];
}) {
  if (series.length < 2) {
    return <p className={styles.groupSparkEmpty}>Série insuficiente para o gráfico</p>;
  }

  const width = 240;
  const height = 46;
  const padding = 3;
  const values = series.map((point) => Number(point.m) || 0);
  // O topo do eixo considera o limiar: sem isso, uma linha inteiramente abaixo
  // dele empurraria o tracejado para fora do desenho e o card mentiria por
  // omissão.
  const max = Math.max(...values, threshold ?? 0, 1);
  const scaleX = (index: number) => padding + (index / (series.length - 1)) * (width - padding * 2);
  const scaleY = (value: number) => height - padding - (value / max) * (height - padding * 2);

  const line = series.map((point, index) => `${scaleX(index)},${scaleY(Number(point.m) || 0)}`).join(' ');
  const area = `${padding},${height - padding} ${line} ${width - padding},${height - padding}`;
  const dayIndex = new Map(series.map((point, index) => [point.d.slice(0, 10), index]));

  return (
    <svg className={styles.groupSpark} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img"
      aria-label={`Mediana diária do grupo em ${series.length} dias`}>
      <defs>
        <linearGradient id="recSparkFade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--rec-accent)" stopOpacity=".22" />
          <stop offset="100%" stopColor="var(--rec-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon className={styles.groupSparkArea} points={area} />
      {threshold !== null && threshold > 0 ? (
        <line className={styles.groupSparkThreshold}
          x1={padding} x2={width - padding} y1={scaleY(threshold)} y2={scaleY(threshold)} />
      ) : null}
      <polyline className={styles.groupSparkLine} points={line} />
      {milestones.map((milestone) => {
        const index = dayIndex.get(milestone.happenedOn.slice(0, 10));
        if (index === undefined) return null;
        const x = scaleX(index);
        return (
          <polygon key={milestone.id} className={styles.groupSparkMarker}
            points={`${x - 3.5},${height - 1} ${x + 3.5},${height - 1} ${x},${height - 6}`}>
            <title>{`Troca de mídia em ${formatDay(milestone.happenedOn)} · ${milestoneLabel(milestone)}`}</title>
          </polygon>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Barra com os tiques de 25% e 40%                                    */
/* ------------------------------------------------------------------ */

function MedianBar({ index, severe }: { index: number | null; severe: boolean }) {
  const ratio = index === null || !Number.isFinite(index) ? 0 : Math.max(0, Math.min(index, 1));
  return (
    <span className={styles.medianCell}>
      <span className={styles.medianValue}>{formatPercent(index)}</span>
      <span className={styles.medianBar} role="img"
        aria-label={`${formatPercent(index)} da mediana do grupo`}>
        <span className={`${styles.medianBarFill} ${severe ? styles.medianBarFillSevere : ''}`}
          style={{ width: `${ratio * 100}%` }} />
        <span className={styles.medianBarTick} style={{ left: '25%' }} />
        <span className={styles.medianBarTick} style={{ left: '40%' }} />
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Gráfico de acompanhamento                                           */
/* ------------------------------------------------------------------ */

function CohortChart({ series }: { series: CohortSeries }) {
  const points = series.points.filter((point) => point.cohort !== null || point.origin !== null);
  if (points.length < 2) {
    return (
      <p className={styles.modalNote}>
        O gráfico aparece a partir do segundo dia de observação — a esteira precisa de dois pontos
        para ter linha.
      </p>
    );
  }

  const width = 760;
  const height = 210;
  const left = 44;
  const right = 12;
  const top = 14;
  const bottom = 28;
  const values = points.flatMap((point) => [point.cohort ?? 0, point.origin ?? 0]);
  const max = Math.max(...values, 1);
  const scaleX = (index: number) => left + (index / Math.max(points.length - 1, 1)) * (width - left - right);
  const scaleY = (value: number) => height - bottom - (value / max) * (height - top - bottom);
  const path = (key: 'cohort' | 'origin') => points
    .map((point, index) => (point[key] === null ? null : `${scaleX(index)},${scaleY(point[key] as number)}`))
    .filter(Boolean)
    .join(' ');
  const dayIndex = new Map(points.map((point, index) => [point.d.slice(0, 10), index]));

  return (
    <>
      <svg className={styles.cohortChartSvg} viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label="Mediana da coorte comparada com a mediana do grupo de origem, nos mesmos dias">
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line className={styles.chartGrid}
              x1={left} x2={width - right} y1={scaleY(max * fraction)} y2={scaleY(max * fraction)} />
            <text className={styles.chartAxis} x={left - 8} y={scaleY(max * fraction) + 3} textAnchor="end">
              {formatDecimal(max * fraction, 0)}
            </text>
          </g>
        ))}
        {series.milestones.map((milestone) => {
          const index = dayIndex.get(milestone.happenedOn.slice(0, 10));
          if (index === undefined) return null;
          const x = scaleX(index);
          return (
            <g key={milestone.id}>
              <line className={styles.chartMarker} x1={x} x2={x} y1={top} y2={height - bottom} />
              <text className={styles.chartMarkerLabel} x={x + 4} y={top + 9}>
                {milestoneLabel(milestone)}
              </text>
            </g>
          );
        })}
        <polyline className={styles.chartOrigin} points={path('origin')} />
        <polyline className={styles.chartCohort} points={path('cohort')} />
        {points.map((point, index) => (
          index % Math.ceil(points.length / 7) === 0 ? (
            <text key={point.d} className={styles.chartAxis} x={scaleX(index)} y={height - 8} textAnchor="middle">
              {formatDay(point.d)}
            </text>
          ) : null
        ))}
      </svg>
      <div className={styles.legend}>
        <span><i className={styles.legendSwatch} />Coorte em recuperação</span>
        <span><i className={`${styles.legendSwatch} ${styles.legendSwatchOrigin}`} />Grupo de origem</span>
        <span><i className={`${styles.legendSwatch} ${styles.legendSwatchMarker}`} />Troca de mídia</span>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Tela                                                                */
/* ------------------------------------------------------------------ */

export default function RecoveryClient({
  organizationName,
  canManage,
  initialOverview,
  initialCandidates,
  initialCandidatesHasMore,
  initialCohort,
}: Props) {
  const [overview, setOverview] = useState(initialOverview);
  const [candidates, setCandidates] = useState(initialCandidates);
  const [candidatesHasMore, setCandidatesHasMore] = useState(initialCandidatesHasMore);
  const [cohort, setCohort] = useState(initialCohort);
  const [series, setSeries] = useState<CohortSeries | null>(null);

  const [adjustment, setAdjustment] = useState<RecoveryAdjustment>(DEFAULT_RECOVERY_ADJUSTMENT);
  const [groupId, setGroupId] = useState<string>('all');
  const [tab, setTab] = useState<Tab>('eligible');
  const [reasonFilter, setReasonFilter] = useState<'all' | 'never_started' | 'collapsed'>('all');
  const [hideStale, setHideStale] = useState(false);
  const [search, setSearch] = useState('');

  const [selection, setSelection] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'neutral'; text: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePreview, setDeletePreview] = useState<Record<string, unknown> | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');

  const skippedInitialFetch = useRef(false);

  const run = overview?.run ?? null;
  const groups = useMemo(() => overview?.groups ?? [], [overview]);
  const activeGroup = groupId === 'all' ? null : groups.find((group) => group.groupId === groupId) ?? null;

  const refreshOverview = useCallback(async () => {
    const response = await fetch('/api/recovery/overview', { cache: 'no-store' });
    const payload = await response.json() as RecoveryOverview & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? 'Não foi possível carregar a análise.');
    setOverview(payload);
    return payload;
  }, []);

  const refreshCohort = useCallback(async () => {
    const response = await fetch('/api/recovery/cohort?status=all', { cache: 'no-store' });
    const payload = await response.json() as { members?: RecoveryCohortItem[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? 'Não foi possível carregar a esteira.');
    setCohort(payload.members ?? []);
  }, []);

  // Candidatos são buscados por execução e grupo. O ajuste 25%/40% NÃO entra
  // aqui de propósito: ele é filtro de cliente sobre o superconjunto já
  // carregado, que é o que permite girar o botão sem requisição nova.
  useEffect(() => {
    if (!run?.id) return;
    if (!skippedInitialFetch.current) {
      skippedInitialFetch.current = true;
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({ runId: run.id });
    if (groupId !== 'all') params.set('groupId', groupId);
    void fetch(`/api/recovery/candidates?${params}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as {
          candidates?: RecoveryCandidate[]; hasMore?: boolean; error?: string;
        };
        if (!response.ok) throw new Error(payload.error ?? 'Não foi possível carregar os candidatos.');
        setCandidates(payload.candidates ?? []);
        setCandidatesHasMore(payload.hasMore ?? false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Falha ao carregar.' });
      });
    return () => controller.abort();
  }, [run?.id, groupId]);

  // A série do gráfico depende da esteira escolhida.
  const seriesGroupId = activeGroup?.recoveryGroupId
    ?? groups.find((group) => group.recoveryGroupId && group.cohortActive > 0)?.recoveryGroupId
    ?? null;

  useEffect(() => {
    if (tab !== 'cohort' || !seriesGroupId) { setSeries(null); return; }
    const controller = new AbortController();
    void fetch(`/api/recovery/cohort/series?recoveryGroupId=${seriesGroupId}`, {
      cache: 'no-store', signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as CohortSeries & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? 'Falha ao carregar a série.');
        setSeries(payload);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setSeries(null);
      });
    return () => controller.abort();
  }, [tab, seriesGroupId]);

  /* --- Elegíveis ---------------------------------------------------- */

  const isOutOfCut = useCallback((candidate: RecoveryCandidate) => (
    // O ajuste só existe para o Filtro 1. O Filtro 2 é fixo em 25% da mediana
    // recente e nunca é escondido pelo botão.
    adjustment === 0.25 && candidate.reason === 'never_started' && candidate.severity === 'moderate'
  ), [adjustment]);

  const visibleCandidates = useMemo(() => {
    const term = search.trim().toLowerCase().replace(/^@/, '');
    return candidates.filter((candidate) => {
      if (reasonFilter !== 'all' && candidate.reason !== reasonFilter) return false;
      if (hideStale && (candidate.staleDays ?? 0) > 2) return false;
      if (term && !candidate.username.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [candidates, reasonFilter, hideStale, search]);

  const inCutCandidates = useMemo(
    () => visibleCandidates.filter((candidate) => !isOutOfCut(candidate)),
    [visibleCandidates, isOutOfCut],
  );

  const totals = overview?.totals;
  const eligibleNow = adjustment === 0.25 ? totals?.eligible25 ?? 0 : totals?.eligible40 ?? 0;
  const neverStartedNow = adjustment === 0.25 ? totals?.neverStarted25 ?? 0 : totals?.neverStarted40 ?? 0;

  const outOfCutCount = useMemo(
    () => visibleCandidates.filter((candidate) => isOutOfCut(candidate)).length,
    [visibleCandidates, isOutOfCut],
  );

  const selectableIds = useMemo(
    () => inCutCandidates.filter((candidate) => !candidate.alreadyInRecovery).map((c) => c.profileId),
    [inCutCandidates],
  );
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const selectedCandidates = useMemo(
    () => candidates.filter((candidate) => selectedSet.has(candidate.profileId)),
    [candidates, selectedSet],
  );

  const toggleOne = (profileId: string, checked: boolean) => {
    setSelection((current) => (checked
      ? [...new Set([...current, profileId])]
      : current.filter((id) => id !== profileId)));
  };
  const toggleVisible = (checked: boolean) => {
    setSelection((current) => (checked
      ? [...new Set([...current, ...selectableIds])]
      : current.filter((id) => !selectableIds.includes(id))));
  };
  const clearSelection = () => setSelection([]);

  /* --- Ações -------------------------------------------------------- */

  const recompute = async () => {
    setBusy('recompute');
    setMessage({ tone: 'neutral', text: 'Recalculando a régua…' });
    try {
      let guard = 0;
      let done = false;
      while (!done && guard < 40) {
        guard += 1;
        const response = await fetch('/api/recovery/recompute', { method: 'POST' });
        const payload = await response.json() as { remaining?: number; error?: string };
        if (response.status === 429) throw new Error(payload.error ?? 'Aguarde para recalcular.');
        if (!response.ok && response.status !== 202) {
          throw new Error(payload.error ?? 'Falha ao recalcular.');
        }
        done = (payload.remaining ?? 0) <= 0;
      }
      const fresh = await refreshOverview();
      await refreshCohort();
      setMessage({
        tone: 'success',
        text: `Análise refeita: ${numberFormat.format(fresh.totals.eligible40)} perfis elegíveis a 40%.`,
      });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Falha ao recalcular.' });
    } finally {
      setBusy(null);
    }
  };

  const sendToRecovery = async () => {
    if (!selection.length) return;
    setBusy('cohort');
    try {
      // A RPC recebe UM grupo de origem por chamada, então a seleção é agrupada
      // e enviada em blocos — o operador pode ter marcado perfis de grupos
      // diferentes na visão "todos".
      const byGroup = new Map<string, string[]>();
      for (const candidate of selectedCandidates) {
        byGroup.set(candidate.groupId, [...(byGroup.get(candidate.groupId) ?? []), candidate.profileId]);
      }
      let moved = 0;
      let skipped = 0;
      for (const [sourceGroupId, profileIds] of byGroup) {
        const response = await fetch('/api/recovery/cohort', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sourceGroupId, profileIds, runId: run?.id ?? null }),
        });
        const payload = await response.json() as {
          movedProfileIds?: string[]; skippedProfileIds?: string[]; error?: string;
        };
        if (!response.ok) throw new Error(payload.error ?? 'Falha ao mandar para recuperação.');
        moved += payload.movedProfileIds?.length ?? 0;
        skipped += payload.skippedProfileIds?.length ?? 0;
      }
      clearSelection();
      await Promise.all([refreshOverview(), refreshCohort()]);
      setMessage({
        tone: skipped ? 'neutral' : 'success',
        text: skipped
          // Perfil ignorado quase sempre significa que outro operador mexeu no
          // meio. Dizer isso é melhor do que reportar sucesso genérico.
          ? `${moved} perfis movidos. ${skipped} ignorados — provavelmente já saíram do grupo de origem.`
          : `${moved} perfis movidos para a esteira. A fila deles continua intacta; cancele se quiser.`,
      });
      setTab('cohort');
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Falha ao mover.' });
    } finally {
      setBusy(null);
    }
  };

  const cancelQueue = async (profileIds: string[]) => {
    if (!profileIds.length) return;
    setBusy('queue');
    let cancelled = 0;
    let blocked = 0;
    try {
      for (const profileId of profileIds) {
        setMessage({
          tone: 'neutral',
          text: `Cancelando fila… ${cancelled + blocked + 1} de ${profileIds.length}`,
        });
        const response = await fetch('/api/publications/cancel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scope: 'account',
            targetId: profileId,
            execute: true,
            // Chave estável por (escopo, alvo, dia). Um uuid novo a cada clique
            // foi o que gerou duas operações presas na GG Lexy em 29/08.
            idempotencyKey: `recovery-${profileId}-${new Date().toISOString().slice(0, 10)}`,
          }),
        });
        const payload = await response.json() as { operation?: { status?: string } };
        if (response.status === 409 || payload.operation?.status === 'blocked') blocked += 1;
        else if (response.ok) cancelled += 1;
      }
      setMessage({
        tone: blocked ? 'neutral' : 'success',
        text: blocked
          ? `${cancelled} filas canceladas. ${blocked} bloqueadas por publicação em andamento — nada foi cancelado nelas; tente de novo em instantes.`
          : `${cancelled} filas canceladas.`,
      });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Falha ao cancelar.' });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Cancelar a fila da esteira inteira em UMA operação durável, em vez de uma
   * por perfil. É o caminho para o qual o mecanismo de cancelamento foi
   * desenhado e o que o repositório já exercita em produção.
   */
  const cancelGroupQueue = async (targetId: string, label: string) => {
    setBusy('queue');
    try {
      const idempotencyKey = `recovery-group-${targetId}-${new Date().toISOString().slice(0, 10)}`;
      let guard = 0;
      let status = 'running';
      while (status === 'running' && guard < 40) {
        guard += 1;
        const response = await fetch('/api/publications/cancel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope: 'group', targetId, execute: true, idempotencyKey }),
        });
        const payload = await response.json() as { operation?: { status?: string }; error?: string };
        status = payload.operation?.status ?? 'failed';
        if (status === 'blocked') {
          setMessage({
            tone: 'neutral',
            text: `Há publicação em andamento em ${label}. **Nada foi cancelado** — aguarde a finalização e tente de novo.`,
          });
          return;
        }
        if (!response.ok && response.status !== 202 && response.status !== 503) {
          throw new Error(payload.error ?? 'Falha ao cancelar a fila.');
        }
        if (status === 'completed') break;
      }
      setMessage({ tone: 'success', text: `Fila de ${label} cancelada.` });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Falha ao cancelar.' });
    } finally {
      setBusy(null);
    }
  };

  const openDelete = async () => {
    setDeleteOpen(true);
    setDeleteConfirmation('');
    setDeletePreview(null);
    setBusy('preview');
    try {
      const response = await fetch('/api/profiles/bulk-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profileIds: selection, dryRun: true }),
      });
      const payload = await response.json() as { summary?: Record<string, unknown>; error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Falha ao prever a exclusão.');
      setDeletePreview(payload.summary ?? null);
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Falha ao prever.' });
      setDeleteOpen(false);
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = async () => {
    setBusy('delete');
    try {
      const profileIds = [...selection];
      const response = await fetch('/api/profiles/bulk-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profileIds, confirmation: deleteConfirmation }),
      });
      const payload = await response.json() as { queued?: number; deletedLocal?: number; error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Falha ao excluir.');

      // Registro no Histórico. Vai depois da exclusão e não pode derrubá-la:
      // se falhar, o perfil já foi excluído de qualquer forma.
      await fetch('/api/recovery/deletions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profileIds, runId: run?.id ?? null }),
      }).catch(() => undefined);

      setDeleteOpen(false);
      clearSelection();
      await Promise.all([refreshOverview(), refreshCohort()]);
      setMessage({
        tone: 'success',
        text: `${payload.deletedLocal ?? 0} excluídos e ${payload.queued ?? 0} enfileirados na Zernio. A vaga só volta depois que o worker confirmar a remoção remota.`,
      });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Falha ao excluir.' });
    } finally {
      setBusy(null);
    }
  };

  const returnFromCohort = async (cohortMemberIds: string[], decision: string) => {
    if (!cohortMemberIds.length) return;
    setBusy('return');
    try {
      const response = await fetch('/api/recovery/cohort/return', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cohortMemberIds, decision }),
      });
      const payload = await response.json() as { returnedMemberIds?: string[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Falha ao devolver.');
      await Promise.all([refreshOverview(), refreshCohort()]);
      setMessage({
        tone: 'success',
        text: `${payload.returnedMemberIds?.length ?? 0} perfis devolvidos ao grupo de origem.`,
      });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Falha ao devolver.' });
    } finally {
      setBusy(null);
    }
  };

  /* --- Esteira ------------------------------------------------------ */

  const activeCohort = useMemo(() => cohort.filter((member) => member.status === 'active'), [cohort]);
  const historyCohort = useMemo(() => cohort.filter((member) => member.status !== 'active'), [cohort]);
  const cohortRecoveryGroupIds = useMemo(
    () => new Set(activeCohort.map((member) => member.recoveryGroupId).filter(Boolean)),
    [activeCohort],
  );

  const visibleCohort = useMemo(() => {
    if (groupId === 'all') return activeCohort;
    const group = groups.find((item) => item.groupId === groupId);
    if (!group?.recoveryGroupId) return [];
    return activeCohort.filter((member) => member.recoveryGroupId === group.recoveryGroupId);
  }, [activeCohort, groupId, groups]);

  /* --- Render ------------------------------------------------------- */

  const staleness = overview?.staleness;

  return (
    <main className="standalone-page recovery-page">
      <div className={styles.page}>
        <section className="top-notification-region" aria-live="polite" aria-atomic="true">
          {message ? (
            <p
              className={`inline-message ${
                message.tone === 'success' ? 'inline-message-success'
                  : message.tone === 'error' ? 'inline-message-error' : 'inline-message-neutral'
              }`}
              role="alert"
            >
              {message.text}
            </p>
          ) : null}
        </section>

        <header className="standalone-header">
          <div>
            <span className="section-kicker">{organizationName} · Instagram</span>
            <h1>Recuperação</h1>
            <p>Perfis que a régua marcou para teste antes da exclusão.</p>
          </div>
          <div className="profiles-header-actions">
            {canManage ? (
              <button type="button" className="button button-primary" onClick={recompute}
                disabled={busy !== null}>
                {busy === 'recompute' ? 'Recalculando…' : 'Recalcular'}
              </button>
            ) : null}
          </div>
        </header>

        {!run ? (
          <div className="empty-state">
            <span className="empty-state-icon" aria-hidden="true">◍</span>
            <h2>Nenhuma análise ainda</h2>
            <p>
              Ligue a recuperação em pelo menos um grupo na tela de Grupos e clique em Recalcular.
              A régua compara cada perfil com a mediana do próprio grupo, então ela só funciona por grupo.
            </p>
          </div>
        ) : (
          <>
            {/* Faixa da régua ------------------------------------------------ */}
            <section className={`panel ${styles.ruleBar}`}>
              <div>
                <div className={styles.ruleHeadline}>
                  <span className={styles.ruleCount}>{numberFormat.format(eligibleNow)}</span>
                  <span className={styles.ruleCountLabel}>elegíveis</span>
                  <span className={styles.ruleBreakdown}>
                    {numberFormat.format(neverStartedNow)} nunca engrenou ·{' '}
                    {numberFormat.format(totals?.collapsed ?? 0)} desabou
                  </span>
                  <span className={`${styles.ruleDelta} ${
                    (totals?.newSincePrevious ?? 0) === 0 ? styles.ruleDeltaZero : ''}`}>
                    {(totals?.newSincePrevious ?? 0) > 0 ? '▲ ' : ''}
                    {numberFormat.format(totals?.newSincePrevious ?? 0)} desde a rodada anterior
                  </span>
                </div>
                <p className={styles.ruleCuts}>
                  {groups.filter((group) => group.medianVs).slice(0, 4).map((group) => (
                    <span key={group.groupId}>
                      <strong>{group.groupName}</strong>{' '}
                      {formatDecimal(adjustment === 0.25 ? group.neverStartedCut : group.neverStartedCutAlt)}
                      {' · '}
                    </span>
                  ))}
                  <span>
                    limiares de hoje, recalculados a cada rodada — nenhum número absoluto fica gravado.
                  </span>
                </p>
              </div>

              <div className={styles.ruleAside}>
                <div className={styles.ruleToggle} role="group" aria-label="Ajuste do Filtro 1">
                  {RECOVERY_ADJUSTMENTS.map((option) => (
                    <button key={option} type="button"
                      className={adjustment === option ? styles.ruleToggleActive : undefined}
                      onClick={() => setAdjustment(option)}
                      aria-pressed={adjustment === option}>
                      <span className={styles.ruleToggleCount}>
                        {numberFormat.format(option === 0.25 ? totals?.eligible25 ?? 0 : totals?.eligible40 ?? 0)}
                      </span>
                      <span>{Math.round(option * 100)}% da mediana</span>
                    </button>
                  ))}
                </div>
                <div className={`${styles.staleness} ${staleness?.warn ? styles.stalenessWarn : ''}`}>
                  <span aria-hidden="true">◷</span>
                  Dados até {formatDay(staleness?.latestMetricDate)}
                  {staleness?.warn ? ' — coleta atrasada' : ''}
                </div>
              </div>
            </section>

            {/* Cards de grupo ------------------------------------------------ */}
            <section className={styles.groupGrid} aria-label="Grupos analisados">
              {groups.map((group) => (
                <GroupCard key={group.groupId} group={group} adjustment={adjustment}
                  active={groupId === group.groupId}
                  onSelect={() => setGroupId(groupId === group.groupId ? 'all' : group.groupId)} />
              ))}
            </section>

            {/* Abas ---------------------------------------------------------- */}
            <nav className={styles.tabs} aria-label="Seções da recuperação">
              {([
                ['eligible', 'Elegíveis', inCutCandidates.length],
                ['cohort', 'Em recuperação', visibleCohort.length],
                ['history', 'Histórico', historyCohort.length],
              ] as const).map(([key, label, count]) => (
                <button key={key} type="button"
                  className={`${styles.tab} ${tab === key ? styles.tabActive : ''}`}
                  onClick={() => { setTab(key); clearSelection(); }}
                  aria-pressed={tab === key}>
                  {label}
                  <span className={styles.tabCount}>{numberFormat.format(count)}</span>
                </button>
              ))}
            </nav>

            {tab === 'eligible' ? (
              <>
                <div className={styles.toolbar}>
                  <label>
                    Grupo
                    <select value={groupId} onChange={(event) => { setGroupId(event.target.value); clearSelection(); }}>
                      <option value="all">Todos os grupos</option>
                      {groups.map((group) => (
                        <option key={group.groupId} value={group.groupId}>{group.groupName}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Nível
                    <select value={reasonFilter}
                      onChange={(event) => setReasonFilter(event.target.value as typeof reasonFilter)}>
                      <option value="all">Os dois</option>
                      <option value="never_started">Nunca engrenou</option>
                      <option value="collapsed">Desabou</option>
                    </select>
                  </label>
                  <label>
                    Buscar
                    <input type="search" value={search} placeholder="@usuário"
                      onChange={(event) => setSearch(event.target.value)} />
                  </label>
                  <label>
                    Coleta
                    <select value={hideStale ? 'fresh' : 'all'}
                      onChange={(event) => setHideStale(event.target.value === 'fresh')}>
                      <option value="all">Todos</option>
                      <option value="fresh">Ocultar coleta atrasada</option>
                    </select>
                  </label>
                </div>

                {candidatesHasMore ? (
                  <p className="inline-message inline-message-neutral" role="status">
                    A execução tem mais candidatos do que cabe numa resposta. Filtre por grupo antes de
                    agir em massa — a tela não age sobre um conjunto que não mostrou.
                  </p>
                ) : null}

                {canManage && selectableIds.length ? (
                  <div className={styles.selectionRow}>
                    <label className={styles.selectVisible}>
                      <input type="checkbox"
                        checked={selectableIds.length > 0 && selectableIds.every((id) => selectedSet.has(id))}
                        ref={(input) => {
                          if (input) {
                            const some = selectableIds.some((id) => selectedSet.has(id));
                            input.indeterminate = some && !selectableIds.every((id) => selectedSet.has(id));
                          }
                        }}
                        onChange={(event) => toggleVisible(event.target.checked)} />
                      Selecionar os {numberFormat.format(selectableIds.length)} desta lista
                    </label>
                    <span className={styles.selectionHint}>
                      {outOfCutCount > 0
                        ? `${outOfCutCount} ${outOfCutCount === 1 ? 'perfil está' : 'perfis estão'} esmaecidos porque só entram com a régua a 40% — dá para marcar um a um mesmo assim.`
                        : 'Perfis já na esteira não entram na seleção.'}
                    </span>
                  </div>
                ) : null}

                <CandidatesTable
                  candidates={visibleCandidates}
                  isOutOfCut={isOutOfCut}
                  canManage={canManage}
                  selectedSet={selectedSet}
                  onToggle={toggleOne}
                />

                {canManage && selection.length ? (
                  <div className={styles.selectionBar}>
                    <span className={styles.selectionBarCount}>
                      <strong>{numberFormat.format(selection.length)}</strong> selecionados
                    </span>
                    <div className={styles.selectionBarActions}>
                      <button type="button" className="button button-primary"
                        onClick={sendToRecovery} disabled={busy !== null}>
                        {busy === 'cohort' ? 'Movendo…' : 'Mandar para recuperação'}
                      </button>
                      <button type="button" className="button button-ghost"
                        onClick={() => cancelQueue(selection)} disabled={busy !== null}
                        title="Cancela a fila de cada perfil selecionado, uma operação por perfil.">
                        {busy === 'queue' ? 'Cancelando…' : 'Cancelar fila'}
                      </button>
                      <button type="button" className="button button-danger"
                        onClick={openDelete} disabled={busy !== null}>
                        Excluir do Athena + Zernio
                      </button>
                      <button type="button" className="button button-ghost" onClick={clearSelection}
                        disabled={busy !== null}>
                        Limpar
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}

            {tab === 'cohort' ? (
              <>
                {series ? (
                  <section className={`panel ${styles.cohortChart}`}>
                    <div className={styles.cohortChartHead}>
                      <span className={styles.cohortChartTitle}>
                        A coorte contra o grupo de origem, nos mesmos dias
                      </span>
                      <span className={styles.modalNote}>
                        Se a linha da origem subir junto, a melhora foi da mídia nova — não do perfil.
                      </span>
                    </div>
                    <CohortChart series={series} />
                  </section>
                ) : null}

                <CohortTable
                  members={visibleCohort}
                  canManage={canManage}
                  busy={busy}
                  onReturn={returnFromCohort}
                  onCancelQueue={cancelQueue}
                />

                {canManage && seriesGroupId ? (
                  <div className={styles.selectionRow}>
                    <span className={styles.selectionHint}>
                      Cancelar a fila da esteira inteira é <strong>uma</strong> operação durável, em vez
                      de uma por perfil.
                    </span>
                    <button type="button" className="button button-ghost" disabled={busy !== null}
                      onClick={() => cancelGroupQueue(
                        seriesGroupId,
                        groups.find((group) => group.recoveryGroupId === seriesGroupId)?.recoveryGroupName
                          ?? 'esteira',
                      )}>
                      {busy === 'queue' ? 'Cancelando…' : 'Cancelar fila da esteira'}
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}

            {tab === 'history' ? <HistoryTable members={historyCohort} /> : null}

            <p className={styles.footnote}>
              A régua encontra perfil que <strong>não entrega</strong>. Ela não encontra perfil que
              entrega e não vende — o que trava a venda está depois da view, e nenhuma régua construída
              sobre views vai apontar para lá.
            </p>
          </>
        )}

        {deleteOpen ? (
          <div className="modal-backdrop" role="presentation"
            onMouseDown={() => { if (!busy) setDeleteOpen(false); }}>
            <section className={`panel bulk-modal ${styles.modal}`} role="dialog" aria-modal="true"
              aria-labelledby="recovery-delete-title" onMouseDown={(event) => event.stopPropagation()}>
              <div>
                <span className="section-kicker">Ação irreversível</span>
                <h2 id="recovery-delete-title">
                  Excluir {numberFormat.format(selection.length)} perfil(is)
                </h2>
              </div>
              {deletePreview ? (
                <dl className={styles.modalSummary}>
                  <dt>Perfis</dt><dd>{String(deletePreview.total ?? '—')}</dd>
                  <dt>Na Zernio</dt><dd>{String(deletePreview.zernio_count ?? '—')}</dd>
                  <dt>Só no Athena</dt><dd>{String(deletePreview.meta_count ?? '—')}</dd>
                  <dt>Publicações canceladas</dt><dd>{String(deletePreview.pending_item_count ?? '—')}</dd>
                </dl>
              ) : (
                <p className={styles.modalNote}>Calculando o que será removido…</p>
              )}
              <p className={styles.modalNote}>
                A vaga na Zernio <strong>não volta na hora</strong>: ela só é liberada depois que o
                worker confirma a remoção remota e relê o inventário. Até lá o perfil continua
                aparecendo como “removendo”.
              </p>
              <label className={styles.modalField}>
                <span>Digite <strong>EXCLUIR</strong> para confirmar</span>
                <input value={deleteConfirmation}
                  onChange={(event) => setDeleteConfirmation(event.target.value)} />
              </label>
              <div className={styles.modalActions}>
                <button type="button" className="button button-danger"
                  disabled={busy !== null || deleteConfirmation.trim().toUpperCase() !== 'EXCLUIR'}
                  onClick={confirmDelete}>
                  {busy === 'delete' ? 'Excluindo…' : 'Excluir definitivamente'}
                </button>
                <button type="button" className="button button-ghost"
                  onClick={() => setDeleteOpen(false)} disabled={busy !== null}>
                  Cancelar
                </button>
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Card de grupo                                                       */
/* ------------------------------------------------------------------ */

function GroupCard({
  group, adjustment, active, onSelect,
}: {
  group: RecoveryGroupCard;
  adjustment: RecoveryAdjustment;
  active: boolean;
  onSelect: () => void;
}) {
  const gateBlocked = group.status === 'gate_blocked';
  const badgeClass = group.status === 'ok'
    ? styles.groupBadgeOk
    : gateBlocked ? styles.groupBadgeWarn : styles.groupBadgeMuted;

  return (
    <button type="button" onClick={onSelect}
      className={`${styles.groupCard} ${active ? styles.groupCardActive : ''}`}
      aria-pressed={active}>
      <div className={styles.groupHead}>
        <span className={styles.groupName}>{group.groupName}</span>
        <span className={`${styles.groupBadge} ${badgeClass}`}
          title={RECOVERY_GROUP_STATUS_HINTS[group.status]}>
          {group.status === 'ok' ? '● saudável' : RECOVERY_GROUP_STATUS_LABELS[group.status]}
        </span>
      </div>

      <Sparkline series={group.series} threshold={group.healthGateThreshold} milestones={group.milestones} />

      <dl className={styles.groupStats}>
        <dt>mediana</dt><dd>{formatDecimal(group.medianVs)}</dd>
        <dt>recente</dt><dd>{formatDecimal(group.medianRecentVs)}</dd>
        <dt>pico</dt><dd>{formatDecimal(group.peakDailyMedian)}</dd>
        <dt>saúde</dt><dd>{formatPercent(group.healthRatio)}</dd>
      </dl>

      <div className={styles.groupCounts}>
        <span className={styles.groupCount}>
          <strong>{numberFormat.format(group.judgeableProfiles)}</strong> julgáveis
        </span>
        {group.profilesIdle > 0 ? (
          <span className={styles.groupCount} title="Membros sem nenhum dia com post na janela.">
            <strong>{numberFormat.format(group.profilesIdle)}</strong> parados
          </span>
        ) : null}
        <span className={styles.groupCount}>
          N1 <strong>{numberFormat.format(adjustment === 0.25 ? group.neverStarted25 : group.neverStarted40)}</strong>
        </span>
        <span className={styles.groupCount}>
          N2 <strong>{gateBlocked ? '—' : numberFormat.format(group.collapsed)}</strong>
        </span>
        {group.cohortActive > 0 ? (
          <span className={styles.groupCount}>
            rec <strong>{numberFormat.format(group.cohortActive)}</strong>
          </span>
        ) : null}
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Tabelas                                                             */
/* ------------------------------------------------------------------ */

function CandidatesTable({
  candidates, isOutOfCut, canManage, selectedSet, onToggle,
}: {
  candidates: RecoveryCandidate[];
  isOutOfCut: (candidate: RecoveryCandidate) => boolean;
  canManage: boolean;
  selectedSet: Set<string>;
  onToggle: (profileId: string, checked: boolean) => void;
}) {
  if (!candidates.length) {
    return (
      <div className="empty-state">
        <span className="empty-state-icon" aria-hidden="true">✓</span>
        <h2>Nenhum perfil elegível</h2>
        <p>Com os filtros atuais, a régua não marcou ninguém para recuperação.</p>
      </div>
    );
  }

  return (
    <section className={`panel ${styles.listPanel}`}>
      <div className={styles.listScroll}>
        <table className={styles.listTable}>
          <thead>
            <tr>
              {canManage ? <th className={styles.checkboxCell}><span className="visually-hidden">Selecionar</span></th> : null}
              <th>Perfil</th>
              <th>Grupo</th>
              <th>Nível</th>
              <th className={styles.numberCell}>Métrica julgada</th>
              <th className={styles.numberCell}>% da mediana</th>
              <th className={styles.numberCell}>Melhor dia</th>
              <th className={styles.numberCell}>Posts</th>
              <th className={styles.numberCell}>Coleta</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate) => {
              const outOfCut = isOutOfCut(candidate);
              const collapsed = candidate.reason === 'collapsed';
              const selected = selectedSet.has(candidate.profileId);
              const stale = (candidate.staleDays ?? 0) > 2;
              return (
                <tr key={candidate.profileId}
                  className={`${selected ? styles.listRowSelected : ''} ${outOfCut ? styles.listRowOutOfCut : ''}`}>
                  {canManage ? (
                    <td className={styles.checkboxCell}>
                      <span className={styles.checkbox}>
                        <input type="checkbox" checked={selected}
                          disabled={candidate.alreadyInRecovery}
                          title={candidate.alreadyInRecovery
                            ? 'Este perfil já está na esteira de recuperação.'
                            : outOfCut
                              ? 'Fora do corte de 25%. Dá para marcar mesmo assim — a régua é recomendação, não trava.'
                              : undefined}
                          onChange={(event) => onToggle(candidate.profileId, event.target.checked)}
                          aria-label={`Selecionar @${candidate.username}`} />
                      </span>
                    </td>
                  ) : null}
                  <td className={styles.identityCell}>
                    <span className={styles.identity}>
                      {candidate.newSincePrevious ? <i className={styles.newDot} title="Novo desde a rodada anterior" /> : null}
                      <span className={styles.identityName}>
                        <strong>@{candidate.username}</strong>
                        {candidate.alreadyInRecovery ? (
                          <span className={styles.identityMeta}>já na esteira</span>
                        ) : null}
                      </span>
                    </span>
                  </td>
                  <td>{candidate.groupName}</td>
                  <td>
                    <span className={`${styles.reasonChip} ${
                      collapsed ? styles.reasonCollapsed : styles.reasonNeverStarted}`}>
                      {RECOVERY_REASON_LABELS[candidate.reason]}
                    </span>
                    {outOfCut ? <span className={styles.onlyAt40}>só a 40%</span> : null}
                  </td>
                  <td className={styles.numberCell} data-label="Métrica julgada">
                    {/* Cada nível é julgado por uma métrica diferente. Mostrar
                        sempre a agregada colocaria quem DESABOU acima do tique
                        dos 40%, parecendo que não deveria estar aqui. */}
                    <span className={styles.judgedMetric}>
                      <span>{collapsed ? 'recente' : 'vs'}</span>
                      <strong>{formatDecimal(collapsed ? candidate.recentVs : candidate.vs)}</strong>
                    </span>
                  </td>
                  <td className={styles.numberCell} data-label="% da mediana">
                    <MedianBar index={candidate.judgedIndex} severe={candidate.severity === 'severe'} />
                  </td>
                  <td className={styles.numberCell} data-label="Melhor dia">
                    {formatDecimal(candidate.bestDayVs)}
                  </td>
                  <td className={styles.numberCell} data-label="Posts">
                    {numberFormat.format(candidate.postsTotal)}
                  </td>
                  <td className={`${styles.numberCell} ${styles.staleCell}`} data-label="Coleta">
                    <span className={stale ? styles.staleWarn : undefined}>
                      {candidate.staleDays === 0 ? 'em dia' : `${candidate.staleDays ?? '—'} d`}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function verdictClass(verdict: RecoveryVerdict | null) {
  switch (verdict) {
    case 'recovered': return styles.verdictRecovered;
    case 'partial': return styles.verdictPartial;
    case 'not_recovered': return styles.verdictNotRecovered;
    default: return styles.verdictPending;
  }
}

function CohortTable({
  members, canManage, busy, onReturn, onCancelQueue,
}: {
  members: RecoveryCohortItem[];
  canManage: boolean;
  busy: string | null;
  onReturn: (ids: string[], decision: string) => void;
  onCancelQueue: (profileIds: string[]) => void;
}) {
  if (!members.length) {
    return (
      <div className="empty-state">
        <span className="empty-state-icon" aria-hidden="true">◍</span>
        <h2>Ninguém em recuperação</h2>
        <p>
          Marque perfis na aba Elegíveis e mande para a esteira. Atribua a mídia nova ao grupo
          <strong> rec</strong> antes de reagendar — a esteira nasce sem pool.
        </p>
      </div>
    );
  }

  return (
    <section className={`panel ${styles.listPanel}`}>
      <div className={styles.listScroll}>
        <table className={styles.listTable}>
          <thead>
            <tr>
              <th>Perfil</th>
              <th>Esteira</th>
              <th className={styles.numberCell}>Dias</th>
              <th className={styles.numberCell}>Posts</th>
              <th className={styles.numberCell}>Zerados</th>
              <th className={styles.numberCell}>vs antes → depois</th>
              <th className={styles.numberCell}>Índice vs origem</th>
              <th>Veredito</th>
              {canManage ? <th><span className="visually-hidden">Ações</span></th> : null}
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const days = daysBetween(member.measurementStartOn);
              return (
                <tr key={member.cohortMemberId}>
                  <td>
                    <span className={styles.identityName}>
                      <strong>@{member.username}</strong>
                      <span className={styles.identityMeta}>de {member.sourceGroupName ?? '—'}</span>
                    </span>
                  </td>
                  <td>{member.recoveryGroupName ?? '—'}</td>
                  <td className={styles.numberCell} data-label="Dias">{days ?? '—'}</td>
                  <td className={styles.numberCell} data-label="Posts">
                    {member.postsSince === null ? '—' : numberFormat.format(member.postsSince)}
                  </td>
                  <td className={styles.numberCell} data-label="Zerados">
                    {/* O denominador vai junto: a Zernio devolve analytics em
                        páginas de 25, então a taxa é sobre o que foi medido. */}
                    <span className={styles.zeroRate}>
                      {formatZeroViewRate(member.zeroViewPosts, member.measuredPosts)}
                    </span>
                  </td>
                  <td className={styles.numberCell} data-label="vs antes → depois">
                    <span className={styles.transition}>
                      <em>{formatDecimal(member.baselineVs)}</em>
                      <span className={styles.transitionArrow}>→</span>
                      <strong>{formatDecimal(member.vsSince)}</strong>
                    </span>
                  </td>
                  <td className={styles.numberCell} data-label="Índice vs origem">
                    <span className={styles.transition}>
                      <em>{formatPercent(member.baselineRatio)}</em>
                      <span className={styles.transitionArrow}>→</span>
                      <strong>{formatPercent(member.recoveryIndex)}</strong>
                    </span>
                  </td>
                  <td>
                    <span className={`${styles.verdict} ${verdictClass(member.verdict)}`}
                      title={member.verdict ? RECOVERY_VERDICT_HINTS[member.verdict] : undefined}>
                      {member.verdict ? RECOVERY_VERDICT_LABELS[member.verdict] : '—'}
                    </span>
                  </td>
                  {canManage ? (
                    <td>
                      <span className={styles.selectionBarActions}>
                        <button type="button" className="button button-ghost" disabled={busy !== null}
                          onClick={() => onReturn([member.cohortMemberId], member.verdict === 'recovered'
                            ? 'recovered' : member.verdict === 'partial' ? 'partial' : 'manual')}>
                          Devolver
                        </button>
                        <button type="button" className="button button-ghost" disabled={busy !== null}
                          onClick={() => onCancelQueue([member.profileId])}>
                          Cancelar fila
                        </button>
                      </span>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HistoryTable({ members }: { members: RecoveryCohortItem[] }) {
  if (!members.length) {
    return (
      <div className="empty-state">
        <span className="empty-state-icon" aria-hidden="true">◷</span>
        <h2>Nada encerrado ainda</h2>
        <p>Quando um perfil sair da esteira ou for excluído, a decisão fica registrada aqui.</p>
      </div>
    );
  }

  return (
    <section className={`panel ${styles.listPanel}`}>
      <div className={styles.listScroll}>
        <table className={styles.listTable}>
          <thead>
            <tr>
              <th>Perfil</th>
              <th>Origem</th>
              <th>Entrou</th>
              <th>Saiu</th>
              <th>Decisão</th>
              <th className={styles.numberCell}>Índice na saída</th>
              <th>Nota</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.cohortMemberId}>
                <td><strong>@{member.username}</strong></td>
                <td>{member.sourceGroupName ?? '—'}</td>
                <td>{formatDay(member.enteredOn)}</td>
                <td>{member.exitAt ? formatDay(member.exitAt.slice(0, 10)) : '—'}</td>
                <td>
                  <span className={`${styles.verdict} ${
                    member.exitDecision === 'recovered' ? styles.verdictRecovered
                      : member.exitDecision === 'deleted' ? styles.verdictNotRecovered
                        : styles.verdictPending}`}>
                    {member.exitDecision === 'deleted' ? 'Excluído'
                      : member.exitDecision === 'recovered' ? 'Recuperado'
                        : member.exitDecision === 'partial' ? 'Parcial'
                          : member.exitDecision === 'not_recovered' ? 'Não recuperou' : 'Encerrado'}
                  </span>
                </td>
                <td className={styles.numberCell} data-label="Índice na saída">
                  {formatPercent(member.exitIndex)}
                </td>
                <td>{member.exitNote ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
