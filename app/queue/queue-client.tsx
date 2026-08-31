'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

import { BulkPlanProgressFeed } from '@/app/components/bulk-plan-progress-list';

import type { Organization, QueueAggregateTab } from './publication-queue-types';
import { usePublicationQueue } from './use-publication-queue';
import {
  cancelableGenerationJobStatuses,
  formatShortDate,
  generationJobProgress,
  statusLabel,
} from './publication-queue-utils';

type QueueClientProps = {
  activeOrganization: Organization;
};

type AggregatedCard = {
  id: string;
  initials: string;
  title: string;
  subtitle: string;
  total: number;
  completed: number;
  closed: number;
  errors: number;
  suspended: number;
  pending: number;
  processing: number;
  active: number;
  nextAt: string | null;
  tone: 'paused' | 'posting' | 'error' | 'suspended' | 'done' | 'idle';
  pausedReason?: string | null;
  consecutiveFailures?: number;
  imageUrl?: string | null;
};

function initials(value: string) {
  const cleaned = value.replace(/^@/, '').trim();
  if (!cleaned) return 'FI';
  const words = cleaned.split(/[\s._-]+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : cleaned.slice(0, 2)).toUpperCase();
}

function compactFuture(value: string | null) {
  if (!value) return 'sem horário';
  const diff = new Date(value).getTime() - Date.now();
  if (Number.isNaN(diff)) return 'sem horário';
  if (diff <= 0) return 'agora';
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `próx ${minutes}min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `próx ${hours}h`;
  return `próx ${Math.round(hours / 24)}d`;
}

function statusToneLabel(card: AggregatedCard) {
  if (card.tone === 'paused') return 'Pausado por limite de erros';
  if (card.tone === 'error') return 'Com erro';
  if (card.tone === 'posting') return 'Postando';
  if (card.tone === 'suspended') return 'Suspenso';
  if (card.tone === 'done') return 'Concluído';
  return 'Na fila';
}

function PausedBatchAlert({ queue }: { queue: ReturnType<typeof usePublicationQueue> }) {
  const paused = queue.pausedBatches;
  if (!paused.total || paused.batches.length === 0) return null;
  return (
    <section className="queue-paused-alert" role="alert" aria-live="assertive">
      <div className="queue-paused-alert-icon" aria-hidden="true">!</div>
      <div className="queue-paused-alert-content">
        <div className="queue-paused-alert-heading">
          <div>
            <strong>Pausado por limite de erros</strong>
            <span>{paused.total.toLocaleString('pt-BR')} lote(s) · {paused.blockedItems.toLocaleString('pt-BR')} publicação(ões) bloqueada(s)</span>
          </div>
          <small>Atualização automática a cada 10 segundos</small>
        </div>
        <div className="queue-paused-alert-list">
          {paused.batches.map((batch) => <article key={batch.batchId}>
            <div><strong>{batch.name || 'Lote sem nome'}</strong><small>Pausado em {formatShortDate(batch.pausedAt)}</small></div>
            <span>{batch.consecutiveFailures} erros consecutivos</span>
            <span>{batch.blockedItems.toLocaleString('pt-BR')} itens · {batch.blockedProfiles.toLocaleString('pt-BR')} perfis</span>
            <p>{batch.reason || 'O limite de falhas terminais do lote foi atingido.'}</p>
          </article>)}
        </div>
        <p className="queue-paused-alert-note">Nenhum item é retomado automaticamente. Analise a causa antes de usar qualquer ação de continuação.</p>
      </div>
    </section>
  );
}

function progressPercent(completed: number, total: number) {
  if (!total) return 0;
  return Math.round((completed / total) * 100);
}

function QueueActions({ queue, canManage }: { queue: ReturnType<typeof usePublicationQueue>; canManage: boolean }) {
  // Saldo real de arquivamento vindo do banco. Antes era ok + errors + closed,
  // que virou um número inflado quando `ok` passou a contar o publicado já
  // arquivado — e o botão prometia limpar o que já estava limpo.
  const cleanableCount = queue.summary?.totals.pendingArchive ?? 0;
  return (
    <div className="queue-reference-actions">
      <button type="button" onClick={() => void queue.refreshAll(true)} disabled={queue.summaryLoading || queue.generationJobsLoading} aria-busy={queue.summaryLoading || queue.generationJobsLoading}><span aria-hidden="true">↻</span>{queue.summaryLoading ? 'Atualizando…' : 'Recarregar'}</button>
      <button type="button" onClick={() => void queue.cleanFinished()} disabled={!canManage || queue.queueActionId === 'queue:clean_finished' || !cleanableCount} aria-busy={queue.queueActionId === 'queue:clean_finished'}><span aria-hidden="true">✓</span>{queue.queueActionId === 'queue:clean_finished' ? 'Limpando…' : `Limpar encerradas (${cleanableCount})`}</button>
    </div>
  );
}

function QueueCancellationProgress({ queue }: { queue: ReturnType<typeof usePublicationQueue> }) {
  const requestInFlight = useRef(false);
  const operation = queue.cancellationOperation;
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!operation || operation.status !== 'running') {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.parse(operation.createdAt || new Date().toISOString());
    const updateElapsed = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(interval);
  }, [operation]);

  useEffect(() => {
    if (!operation || operation.status !== 'running') return;
    const resume = async () => {
      if (requestInFlight.current) return;
      requestInFlight.current = true;
      try {
        await queue.resumeCancellationOperation();
      } finally {
        requestInFlight.current = false;
      }
    };
    const interval = window.setInterval(() => void resume(), 3000);
    return () => window.clearInterval(interval);
  }, [operation, queue]);

  if (!operation) return null;
  const running = operation.status === 'running';
  const completed = operation.status === 'completed';
  const blocked = operation.status === 'blocked';
  const title = running
    ? `Cancelando ${operation.targetLabel} com segurança…`
    : completed
      ? `Fila de ${operation.targetLabel} cancelada e verificada`
      : blocked
        ? `Cancelamento de ${operation.targetLabel} bloqueado`
        : `Não foi possível concluir o cancelamento de ${operation.targetLabel}`;
  const detail = running
    ? `Verificando e cancelando fontes da fila há ${elapsedSeconds}s. Progresso confirmado: ${operation.progress}%. Esta tela consulta o estado salvo a cada 3 segundos; nenhuma publicação em andamento será interrompida de forma insegura.`
    : completed
      ? `${Number(operation.result?.cancelledItems ?? 0).toLocaleString('pt-BR')} publicação(ões) interrompida(s). Feche este aviso para não exibi-lo novamente.`
      : blocked
        ? 'Existe publicação já em processamento; nenhum item foi alterado. Aguarde a conclusão e tente outra vez.'
        : operation.error ?? 'A operação não pôde ser confirmada. O estado foi preservado para auditoria.';

  return (
    <section className={`queue-cancellation-progress is-${operation.status}`} role={running ? 'status' : 'alert'} aria-live="polite">
      <div className="queue-cancellation-progress-icon" aria-hidden="true">{running ? '×' : completed ? '✓' : '!'}</div>
      <div className="queue-cancellation-progress-content">
        <div><strong>{title}</strong><span>{running ? 'Em andamento' : completed ? '100%' : 'Atenção'}</span></div>
        <p>{detail}</p>
        {running && <div className="queue-cancellation-progress-track" aria-label={`Cancelamento em andamento: ${operation.progress}%`}><span style={{ width: `${Math.max(5, operation.progress)}%` }} /></div>}
      </div>
      {!running && <button type="button" className="queue-cancellation-progress-close" onClick={queue.dismissCancellationOperation} aria-label="Fechar aviso de cancelamento">×</button>}
    </section>
  );
}

function GenerationJobsPanel({ queue, canManage }: { queue: ReturnType<typeof usePublicationQueue>; canManage: boolean }) {
  return (
    <section className="generation-jobs-section queue-jobs-section" aria-labelledby="generation-jobs-title">
      <div className="panel generation-jobs-panel">
        <div className="panel-heading queue-heading">
          <div>
            <span className="section-kicker">Compositor</span>
            <h2 id="generation-jobs-title">Envios grandes do compositor</h2>
            <p className="queue-heading-description">Envios do compositor comum acima de 500 publicações. A programação em massa aparece no bloco acima, não aqui.</p>
          </div>
          <button type="button" className="button button-ghost" onClick={() => void queue.refreshGenerationJobs()} disabled={queue.generationJobsLoading} aria-busy={queue.generationJobsLoading}>{queue.generationJobsLoading ? 'Atualizando…' : 'Atualizar jobs'}</button>
        </div>

        {!queue.generationJobsLoaded && queue.generationJobsLoading ? <p className="muted-text">Carregando jobs recentes…</p> : queue.generationJobs.length === 0 ? <p className="muted-text">Nenhum job grande recente nesta organização.</p> : <div className="generation-job-list">
          {queue.generationJobs.map((job) => {
            const progress = generationJobProgress(job);
            const expectedItems = job.expected_items ?? 0;
            const canCancelJob = canManage && cancelableGenerationJobStatuses.has(job.status);
            const cancellingJob = queue.generationJobActionId === job.id;
            return <article className="generation-job-card" key={job.id}>
              <div className="generation-job-heading">
                <div>
                  <span className={`queue-status-chip queue-status-${job.status}`}>{statusLabel(job.status)}</span>
                  <h3>{job.name || 'Agendamento grande sem nome'}</h3>
                  <small>Criado em {formatShortDate(job.created_at)}{job.completed_at ? ` · Concluído em ${formatShortDate(job.completed_at)}` : ''}</small>
                </div>
                <div className="generation-job-actions">
                  <strong>{progress}%</strong>
                  {canCancelJob && <button type="button" className="button button-danger" onClick={() => void queue.cancelGenerationJob(job)} disabled={cancellingJob} aria-busy={cancellingJob}>{cancellingJob ? 'Cancelando…' : 'Cancelar job'}</button>}
                </div>
              </div>
              <div className="generation-job-progress" aria-label={`Progresso do job ${job.name || job.id}: ${progress}%`}><span style={{ width: `${progress}%` }} /></div>
              <dl className="generation-job-metrics">
                <div><dt>Esperadas</dt><dd>{expectedItems.toLocaleString('pt-BR')}</dd></div>
                <div><dt>Geradas</dt><dd>{job.generated_items.toLocaleString('pt-BR')}</dd></div>
                <div><dt>Falhas</dt><dd>{job.failed_items.toLocaleString('pt-BR')}</dd></div>
                <div><dt>Chunks</dt><dd>{job.chunk_count.toLocaleString('pt-BR')} · {job.chunk_size.toLocaleString('pt-BR')}/chunk</dd></div>
              </dl>
              {job.last_error_message && <p className="generation-job-error">{job.last_error_message}</p>}
            </article>;
          })}
        </div>}
      </div>
    </section>
  );
}

function ReferenceQueueView({
  queue,
  tab,
  setTab,
  canManage,
}: {
  queue: ReturnType<typeof usePublicationQueue>;
  tab: QueueAggregateTab;
  setTab: (tab: QueueAggregateTab) => void;
  canManage: boolean;
}) {
  const cards = useMemo(() => {
    if (!queue.summary) return [];
    const summaryRows = tab === 'account' ? queue.summary.accounts : tab === 'batch' ? queue.summary.batches : queue.summary.groups;
    return summaryRows.map((row) => {
      const title = tab === 'account' ? `@${row.username ?? 'perfil'}` : row.title ?? 'Sem nome';
      const pausedBatch = tab === 'batch' ? queue.pausedBatches.batches.find((candidate) => candidate.batchId === row.id) : null;
      return {
        id: row.id,
        initials: initials(title),
        title,
        subtitle: tab === 'account'
          ? row.display_name || 'Conta Instagram'
          : tab === 'group'
            ? `${row.profile_count ?? 0} conta(s)`
            : row.created_at ? `Criado em ${formatShortDate(row.created_at)}` : 'Lote de publicação',
        total: row.total,
        completed: row.completed,
        closed: row.closed ?? 0,
        errors: row.errors,
        suspended: row.suspended,
        pending: row.pending,
        processing: row.processing,
        active: row.active ?? row.pending + row.processing + row.errors + row.suspended,
        nextAt: row.next_at,
        tone: pausedBatch ? 'paused' : row.tone,
        pausedReason: pausedBatch?.reason ?? null,
        consecutiveFailures: pausedBatch?.consecutiveFailures,
        imageUrl: row.profile_picture_url ?? null,
      } satisfies AggregatedCard;
    });
  }, [queue.pausedBatches.batches, queue.summary, tab]);

  const totals = queue.summary?.totals ?? {
    total: 0,
    ok: 0,
    pending: 0,
    processing: 0,
    errors: 0,
    suspended: 0,
    active: 0,
    closed: 0,
    pendingArchive: 0,
    archived: 0,
    expiredLeases: 0,
    activeAccounts: 0,
    suspendedAccounts: 0,
    totalAccounts: 0,
    progress: 0,
  };
  const page = queue.summaryPages[tab];
  // O publicado é lido numa janela (padrão 24 h), não desde sempre: acima de
  // 7 dias o arquivo frio já apagou a linha da tabela quente e a contagem viria
  // incompleta. O rótulo carrega a janela para o número nunca ficar sem unidade.
  const historyHours = queue.summary?.historyHours ?? 24;
  const historyLabel = historyHours % 24 === 0
    ? `${historyHours / 24}d`
    : `${historyHours}h`;

  function cancellationTarget(card: AggregatedCard) {
    const scope: 'account' | 'batch' | 'group' = tab === 'account' ? 'account' : tab === 'batch' ? 'batch' : 'group';
    const activeItems = card.pending + card.processing + card.errors + card.suspended;
    return { scope, activeItems };
  }

  return (
    <section className="queue-reference-view" aria-labelledby="queue-reference-title">
      <div className="queue-reference-shell">
        <header className="queue-reference-header">
          <div>
            <h2 id="queue-reference-title">Fila de Postagem</h2>
            <p>{totals.total.toLocaleString('pt-BR')} itens em acompanhamento</p>
          </div>
          <QueueActions queue={queue} canManage={canManage} />
        </header>

        <div className="queue-reference-kpis" aria-label="Resumo da fila">
          <article><span>OK</span><strong>{totals.ok.toLocaleString('pt-BR')}</strong><small>publicadas · {historyLabel}</small></article>
          <article><span>PENDENTES</span><strong>{totals.pending.toLocaleString('pt-BR')}</strong><small>aguardando</small></article>
          <article className="queue-reference-kpi-error"><span>ERROS</span><strong>{totals.errors.toLocaleString('pt-BR')}</strong><small>precisam de atenção</small></article>
          <article><span>SUSPENSAS</span><strong>{totals.suspended.toLocaleString('pt-BR')}</strong><small>retomada manual</small></article>
          <article className="queue-reference-kpi-accounts"><span>CONTAS NA FILA</span><strong>{totals.activeAccounts}/{totals.totalAccounts}</strong><small>ativas / total</small></article>
        </div>

        <div className="queue-reference-progress">
          <div><span>Progresso geral · últimas {historyLabel}</span><strong>{totals.progress}%</strong></div>
          <div className="queue-reference-progress-track" aria-label={`Progresso geral: ${totals.progress}%`}><span style={{ width: `${totals.progress}%` }} /></div>
        </div>

        <div className="queue-reference-tabs" role="tablist" aria-label="Agrupamento da fila">
          <button type="button" className={tab === 'account' ? 'is-active' : ''} onClick={() => setTab('account')} role="tab" aria-selected={tab === 'account'}>Por conta <span>{queue.summaryLoadedScopes.account ? queue.summaryPages.account.totalCount : '…'}</span></button>
          <button type="button" className={tab === 'batch' ? 'is-active' : ''} onClick={() => setTab('batch')} role="tab" aria-selected={tab === 'batch'}>Por lote <span>{queue.summaryLoadedScopes.batch ? queue.summaryPages.batch.totalCount : '…'}</span></button>
          <button type="button" className={tab === 'group' ? 'is-active' : ''} onClick={() => setTab('group')} role="tab" aria-selected={tab === 'group'}>Por grupo <span>{queue.summaryLoadedScopes.group ? queue.summaryPages.group.totalCount : '…'}</span></button>
        </div>

        <div className="queue-reference-legend" aria-label="Legenda de estados">
          <span><i className="is-posting" /> <strong>Postando</strong> — publicação em andamento</span>
          <span><i className="is-waiting" /> <strong>Na fila</strong> — aguardando o próximo horário</span>
          <span><i className="is-error" /> <strong>Com erro</strong> — precisa de ação</span>
          <span><i className="is-paused" /> <strong>Pausado por limite de erros</strong> — lote bloqueado</span>
          <span><i className="is-suspended" /> <strong>Suspensa</strong> — perfil offline, retomada manual</span>
          <span><i className="is-done" /> <strong>Concluída</strong> — sem itens ativos</span>
        </div>

        {queue.summaryErrors[tab] && cards.length > 0 && <div className="queue-reference-stale" role="status">Exibindo a última página válida. {queue.summaryErrors[tab]} <button type="button" onClick={() => void queue.refreshSummary(tab)}>Tentar novamente</button></div>}
        {queue.summaryErrors[tab] && cards.length === 0 ? <div className="queue-reference-error" role="alert"><strong>Não foi possível carregar a fila</strong><p>{queue.summaryErrors[tab]}</p><button type="button" className="button button-ghost" onClick={() => void queue.refreshSummary(tab)}>Tentar novamente</button></div> : (!queue.summaryLoadedScopes[tab] || queue.summaryLoading) && cards.length === 0 ? <div className="queue-reference-loading" aria-label="Carregando resumo"><span /><span /><span /></div> : cards.length === 0 ? <div className="queue-reference-empty"><span aria-hidden="true">✓</span><h3>Fila operacional vazia</h3><p>Não há itens para exibir neste agrupamento.</p></div> : <div className="queue-reference-list">
          {cards.map((card) => {
            const percent = progressPercent(card.completed, card.total);
            const target = cancellationTarget(card);
            const cancelling = queue.queueActionId === `scope:${target.scope}:${card.id}`;
            const unsupportedUngroupedScope = target.scope === 'group' && card.id === 'none';
            return <article className={`queue-reference-row is-${card.tone}`} key={card.id}>
              <div className="queue-reference-avatar">{card.imageUrl ? <img src={card.imageUrl} alt="" /> : card.initials}</div>
              <div className="queue-reference-identity"><strong>{card.title}</strong><small>{card.subtitle}</small></div>
              <span className="queue-reference-status"><i />{statusToneLabel(card)}</span>
              <div className="queue-reference-row-progress"><div><span style={{ width: `${percent}%` }} /></div><small>{percent}%</small></div>
              <div className="queue-reference-next"><span>{card.tone === 'paused' ? 'Execução' : 'Próxima'}</span><strong>{card.tone === 'paused' ? 'bloqueada' : compactFuture(card.nextAt)}</strong></div>
              <div className="queue-reference-total"><strong>{card.completed} publicadas · {historyLabel}</strong><small>{card.active ? `${card.active} ativa(s)` : card.errors ? `${card.errors} erro(s)` : card.suspended ? `${card.suspended} suspensa(s)` : 'sem itens ativos'}{card.closed ? ` · ${card.closed} cancelada(s)` : ''}</small></div>
              <div className="queue-reference-row-actions">
                {!unsupportedUngroupedScope && <button
                  type="button"
                  className="button button-danger"
                  disabled={!canManage || !target.activeItems || cancelling}
                  aria-busy={cancelling}
                  onClick={() => void queue.cancelScope(target.scope, card.id, card.title)}
                >{cancelling ? 'Cancelando…' : target.scope === 'account' ? 'Cancelar fila' : target.scope === 'batch' ? 'Cancelar lote' : 'Cancelar grupo'}</button>}
              </div>
            </article>;
          })}
          {page.hasMore && <div className="queue-reference-pagination"><span>{Math.max(0, page.totalCount - cards.length)} linha(s) ainda não carregada(s)</span><button type="button" className="button button-ghost" disabled={queue.summaryLoading} onClick={() => void queue.refreshSummary(tab, true)}>{queue.summaryLoading ? 'Carregando…' : `Carregar mais ${Math.min(page.limit, page.totalCount - cards.length)}`}</button></div>}
        </div>}
      </div>
    </section>
  );
}

export default function QueueClient({ activeOrganization }: QueueClientProps) {
  const canManage = ['admin', 'operator'].includes(activeOrganization.role);
  const [aggregateTab, setAggregateTab] = useState<QueueAggregateTab>('account');
  const queue = usePublicationQueue({ initialBatches: [], groups: [], canManage, organizationId: activeOrganization.id, aggregateTab });

  return (
    <main className="standalone-page queue-page">
      <header className="queue-page-header">
        <div><span>{activeOrganization.name} · Operação</span><h1>Fila de publicação</h1></div>
        <div className="queue-hero-actions">
          <Link className="button button-ghost" href="/postagem" prefetch={false}>Nova postagem</Link>
        </div>
      </header>

      {queue.message && <p className={`inline-message ${queue.message.includes('cancelada') || queue.message.includes('devolvida') || queue.message.includes('liberado') ? 'inline-message-success' : ''}`} role="status">{queue.message}</p>}
      {!canManage && <p className="inline-message" role="alert">Seu papel permite acompanhar a fila, mas não executar ações operacionais.</p>}
      <QueueCancellationProgress queue={queue} />
      <PausedBatchAlert queue={queue} />

      <ReferenceQueueView queue={queue} tab={aggregateTab} setTab={setAggregateTab} canManage={canManage} />
      {/* Programação em massa: até aqui a tela da fila era cega para planos em
          geração — o lote existe, mas fica sem itens até o worker materializar,
          e a aba "Por lote" só mostra lote com item. Era o que fazia o usuário
          achar que o agendamento tinha sumido e reagendar por cima. */}
      <BulkPlanProgressFeed location="queue" />
      <details className="queue-jobs-disclosure"><summary>Envios grandes do compositor <span>{queue.generationJobs.length}</span></summary><GenerationJobsPanel queue={queue} canManage={canManage} /></details>
    </main>
  );
}
