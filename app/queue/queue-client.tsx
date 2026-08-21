'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

import { BulkPlanProgressFeed } from '@/app/components/bulk-plan-progress-list';
import type { Batch, Organization, QueueAggregateTab, QueueGroup, QueueItem, QueueProfile, QueueViewMode } from './publication-queue-types';
import { operationalQueueMetric } from './queue-summary';
import { usePublicationQueue } from './use-publication-queue';
import {
  attemptsLabel,
  batchItemStatuses,
  batchScheduleSummary,
  batchStatusSummary,
  cancelableGenerationJobStatuses,
  formatShortDate,
  generationJobProgress,
  initialQueueItemsPerBatch,
  isQueueItemCancelable,
  providerDescription,
  providerLabel,
  queueFormats,
  queueItemMessage,
  queueItemsIncrement,
  queuePreviewUrl,
  rescheduleSummary,
  sortQueueItemsBySchedule,
  statusLabel,
} from './publication-queue-utils';

type QueueClientProps = {
  activeOrganization: Organization;
  profiles: QueueProfile[];
  groups: QueueGroup[];
  batches: Batch[];
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
  tone: 'posting' | 'error' | 'suspended' | 'done' | 'idle';
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

function allItems(batches: Batch[]) {
  return batches.flatMap((batch) => batchItemStatuses(batch).map((item) => ({ batch, item })));
}

function cardFromItems(id: string, title: string, subtitle: string, items: QueueItem[]): AggregatedCard {
  const metric = operationalQueueMetric(items);
  const errors = items.filter((item) => item.status === 'failed').length;
  const suspended = items.filter((item) => item.status === 'suspended').length;
  const processing = items.filter((item) => ['preparing', 'publishing'].includes(item.status)).length;
  const pending = items.filter((item) => ['waiting', 'ready'].includes(item.status)).length;
  const nextAt = items
    .map((item) => item.execute_at)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0] ?? null;
  return {
    id,
    initials: initials(title),
    title,
    subtitle,
    total: metric.total,
    completed: metric.completed,
    closed: metric.closed,
    errors,
    suspended,
    pending,
    processing,
    active: metric.active,
    nextAt,
    tone: errors > 0 ? 'error' : processing > 0 ? 'posting' : pending > 0 ? 'idle' : suspended > 0 ? 'suspended' : 'done',
  };
}

function statusToneLabel(card: AggregatedCard) {
  if (card.tone === 'error') return 'Com erro';
  if (card.tone === 'posting') return 'Postando';
  if (card.tone === 'suspended') return 'Suspenso';
  if (card.tone === 'done') return 'Concluído';
  return 'Na fila';
}

function progressPercent(completed: number, total: number) {
  if (!total) return 0;
  return Math.round((completed / total) * 100);
}

function QueueFilters({
  queue,
  profiles,
  groups,
}: {
  queue: ReturnType<typeof usePublicationQueue>;
  profiles: QueueProfile[];
  groups: QueueGroup[];
}) {
  return (
    <div className="queue-toolbar queue-toolbar-expanded">
        <select aria-label="Filtrar por status" value={queue.queueFilter} onChange={(event) => queue.setQueueFilter(event.target.value as typeof queue.queueFilter)}>
        <option value="all">Todos os status</option>
        <option value="scheduled">Agendados</option>
        <option value="processing">Em processamento</option>
          <option value="failed">Com falha</option>
          <option value="acknowledged_failed">Falhas confirmadas</option>
        <option value="suspended">Suspensos</option>
        <option value="published">Publicados</option>
      </select>
      <select aria-label="Filtrar por formato" value={queue.queueFormatFilter} onChange={(event) => queue.setQueueFormatFilter(event.target.value as typeof queue.queueFormatFilter)}>
        <option value="all">Todos os formatos</option>
        {queueFormats.map((format) => <option key={format.value} value={format.value}>{format.label}</option>)}
      </select>
      <select aria-label="Filtrar por execução" value={queue.queueTimingFilter} onChange={(event) => queue.setQueueTimingFilter(event.target.value as typeof queue.queueTimingFilter)}>
        <option value="all">Imediatas e agendadas</option>
        <option value="immediate">Imediatas</option>
        <option value="scheduled">Agendadas</option>
      </select>
      <select aria-label="Filtrar por perfil" value={queue.queueProfileFilter} onChange={(event) => queue.setQueueProfileFilter(event.target.value)}>
        <option value="all">Todos os perfis</option>
        {profiles.map((profile) => <option key={profile.id} value={profile.id}>@{profile.username}</option>)}
      </select>
      <select aria-label="Filtrar por grupo de perfis" value={queue.queueGroupFilter} onChange={(event) => queue.setQueueGroupFilter(event.target.value)}>
        <option value="all">Todos os grupos</option>
        <option value="none">Sem grupo</option>
        {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select>
      <button type="button" className="button button-ghost" onClick={queue.clearFilters}>Limpar</button>
    </div>
  );
}

function QueueActions({ queue, canManage }: { queue: ReturnType<typeof usePublicationQueue>; canManage: boolean }) {
  const visibleFailedIds = allItems(queue.visibleBatches)
    .map(({ item }) => item)
    .filter((item) => item.status === 'failed' && !(item.publication_failure_acknowledgements?.length))
    .map((item) => item.id);
  return (
    <div className="queue-reference-actions">
      <button type="button" onClick={() => void queue.refreshAll(true)} disabled={queue.refreshing || queue.generationJobsLoading} aria-busy={queue.refreshing || queue.generationJobsLoading}><span aria-hidden="true">↻</span>{queue.refreshing ? 'Atualizando…' : 'Recarregar'}</button>
      <button type="button" onClick={() => void queue.runQueueAction('process')} disabled={!canManage || queue.queueActionId === 'queue:process'} aria-busy={queue.queueActionId === 'queue:process'}><span aria-hidden="true">▶</span>{queue.queueActionId === 'queue:process' ? 'Processando…' : 'Processar'}</button>
      <button type="button" onClick={() => void queue.runQueueAction('release_stuck')} disabled={!canManage || queue.queueActionId === 'queue:release_stuck' || !(queue.summary?.totals.expiredLeases ?? 0)}><span aria-hidden="true">↯</span>Tirar travadas ({queue.summary?.totals.expiredLeases ?? 0})</button>
      <button type="button" onClick={() => void queue.runQueueAction('clear_completed')} disabled={!canManage || queue.queueActionId === 'queue:clear_completed' || !(queue.summary?.totals.ok ?? 0)}><span aria-hidden="true">✓</span>{queue.queueActionId === 'queue:clear_completed' ? 'Arquivando…' : 'Limpar concluídas'}</button>
      <button type="button" onClick={() => void queue.acknowledgeFailures('', visibleFailedIds)} disabled={!canManage || queue.queueActionId === 'failures:visible' || !visibleFailedIds.length}><span aria-hidden="true">✓</span>{queue.queueActionId === 'failures:visible' ? 'Confirmando…' : `Limpar falhas (${visibleFailedIds.length})`}</button>
      <button type="button" className="queue-reference-action-danger" onClick={() => void queue.cancelVisibleBatches()} disabled={!canManage || queue.queueActionId === 'visible:cancel'}><span aria-hidden="true">×</span>Cancelar</button>
      <button type="button" onClick={queue.clearFilters}><span aria-hidden="true">⌫</span>Limpar</button>
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
            <span className="section-kicker">Agendamentos grandes</span>
            <h2 id="generation-jobs-title">Geração assíncrona</h2>
            <p className="queue-heading-description">Acompanhe os envios acima de 500 publicações enquanto a VPS transforma o plano em lotes e itens da fila.</p>
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

function ClassicQueueList({ queue, canManage, profiles }: { queue: ReturnType<typeof usePublicationQueue>; canManage: boolean; profiles: QueueProfile[] }) {
  return (
    <section className="queue-section queue-classic-section" id="publication-queue">
      {queue.visibleBatches.length === 0 ? <div className="panel empty-state"><span className="empty-state-icon" aria-hidden="true">➤</span><h2>Nenhuma publicação neste filtro</h2><p>As publicações criadas em Postagem aparecerão com o progresso de cada etapa.</p></div> : <div className="queue-list">{queue.visibleBatches.map((batch) => {
        const orderedItems = sortQueueItemsBySchedule(batchItemStatuses(batch));
        const displayLimit = queue.queueItemDisplayLimits[batch.id] ?? initialQueueItemsPerBatch;
        const displayedItems = orderedItems.slice(0, displayLimit);
        const remainingItemsCount = Math.max(0, orderedItems.length - displayedItems.length);
        const statuses = batchStatusSummary({ ...batch, publication_items: orderedItems });
        const author = batch.created_by_name?.trim() || batch.created_by_email || 'Autor não identificado';
        const visibleCancelableIds = displayedItems.filter(isQueueItemCancelable).map((item) => item.id);
        const fullBatch = queue.batches.find((candidate) => candidate.id === batch.id);
        const entireCancelableCount = batchItemStatuses(fullBatch ?? batch).filter(isQueueItemCancelable).length;
        const unacknowledgedFailureCount = batchItemStatuses(fullBatch ?? batch).filter((item) => item.status === 'failed' && !(item.publication_failure_acknowledgements?.length)).length;
        const circuitBreaker = batch.publication_batch_circuit_breakers?.[0] ?? null;
        return <article className={`panel queue-card ${statuses.some(({ status }) => status === 'failed') ? 'queue-card-has-errors' : ''}`} key={batch.id}>
          <div className="queue-card-heading">
            <span className="section-kicker">Lote de publicação</span>
            <h3>{batch.name || 'Publicação sem nome'}</h3>
            <p className="queue-schedule-summary">{batchScheduleSummary({ ...batch, publication_items: orderedItems })}</p>
            <small className="queue-author">Por <strong>{author}</strong></small>
            <small>Criado em {formatShortDate(batch.created_at)} · Horário de São Paulo</small>
            <div className="queue-status-summary">{statuses.map(({ status, count }) => <span key={status} className={`queue-status-chip queue-status-${status}`}>{count} {statusLabel(status).toLocaleLowerCase('pt-BR')}</span>)}</div>
            {circuitBreaker?.paused_at && <p className="queue-error-preview"><strong>Lote pausado após {circuitBreaker.consecutive_failures} falhas consecutivas.</strong> {circuitBreaker.paused_reason}</p>}
            <div className="queue-batch-actions">
              {circuitBreaker?.paused_at && <button type="button" className="button button-primary" disabled={!canManage || queue.queueActionId === `continue:${batch.id}`} onClick={() => void queue.continueBatch(batch.id)}>{queue.queueActionId === `continue:${batch.id}` ? 'Continuando…' : 'Continuar lote'}</button>}
              <button type="button" className="button button-danger" disabled={!canManage || !entireCancelableCount || queue.queueActionId === `batch:${batch.id}:entire_batch`} onClick={() => void queue.cancelBatch(batch.id, 'entire_batch')}>{queue.queueActionId === `batch:${batch.id}:entire_batch` ? 'Cancelando lote…' : 'Cancelar lote inteiro'}</button>
               <button type="button" className="button button-ghost" disabled={!canManage || !visibleCancelableIds.length || queue.queueActionId === `batch:${batch.id}:visible_items`} onClick={() => void queue.cancelBatch(batch.id, 'visible_items', visibleCancelableIds)}>{queue.queueActionId === `batch:${batch.id}:visible_items` ? 'Cancelando…' : `Cancelar ${visibleCancelableIds.length} item(ns) exibido(s)`}</button>
               <button type="button" className="button button-ghost" disabled={!canManage || !unacknowledgedFailureCount || queue.queueActionId === `failures:${batch.id}`} onClick={() => void queue.acknowledgeFailures(batch.id)}>{queue.queueActionId === `failures:${batch.id}` ? 'Confirmando falhas…' : `Limpar falhas (${unacknowledgedFailureCount})`}</button>
            </div>
          </div>
          <div className="queue-items">{displayedItems.map((item) => {
            const profile = item.profile ?? profiles.find((candidate) => candidate.id === item.profile_id) ?? null;
            const media = (item.publication_item_media ?? []).slice().sort((left, right) => left.position - right.position);
            const message = queueItemMessage(item);
            const recovered = rescheduleSummary(item);
            return <div className={`queue-item queue-item-${item.status}`} key={item.id}>
              <button type="button" className="queue-item-details" onClick={() => queue.openPublicationDetails(item.id)}>
                <span className="queue-media-summary">{media.slice(0, 3).map(({ media_assets: asset }, index) => {
                  const url = queuePreviewUrl(asset);
                  return <span className="queue-media-thumb" key={asset?.id ?? index}>{url ? <img src={url} alt={asset?.original_name ?? 'Mídia'} /> : asset?.kind === 'video' ? '▶' : '▣'}</span>;
                })}{media.length > 3 && <span className="queue-media-more">+{media.length - 3}</span>}</span>
                <span className="queue-item-info">
                  <strong><span className={`queue-status-dot queue-status-${item.status}`} />@{profile?.username ?? 'perfil'} · {statusLabel(item.status)} · {queueFormats.find((format) => format.value === item.format)?.label ?? item.format}</strong>
                  <span className={`queue-provider-badge queue-provider-${profile?.provider ?? 'meta_official'}`}>{providerLabel(profile?.provider)}</span>
                  <span className="queue-provider-detail">{providerDescription(profile)}</span>
                  <time>{item.execute_at ? formatShortDate(item.execute_at) : 'Execução imediata'}</time>
                  {(item.attempt_count ?? 0) > 0 && <span className="queue-attempt">Tentativas: {attemptsLabel(item)}</span>}
                  {recovered && <small className="queue-reschedule-preview">{recovered}</small>}
                  {message && <small className="queue-error-preview" title={item.last_error_message ?? undefined}>{message}</small>}
                </span>
              </button>
              <div className="queue-item-actions">
                {item.status === 'suspended' && <button type="button" onClick={() => void queue.resumeBatchProfile(batch.id, item.profile_id)} disabled={!canManage || profile?.status !== 'online' || queue.queueActionId === `resume:${batch.id}:${item.profile_id}`}>{queue.queueActionId === `resume:${batch.id}:${item.profile_id}` ? 'Retomando…' : profile?.status === 'online' ? 'Retomar lote/perfil' : 'Perfil offline'}</button>}
                {item.status === 'failed' && <button type="button" onClick={() => void queue.handleQueueAction(item.id, 'retry')} disabled={!canManage || queue.queueActionId === item.id}>Retentar</button>}
                {isQueueItemCancelable(item) && <button type="button" className="danger-action" onClick={() => void queue.handleQueueAction(item.id, 'cancel')} disabled={!canManage || queue.queueActionId === item.id}>Cancelar</button>}
              </div>
            </div>;
          })}{remainingItemsCount > 0 && <div className="queue-items-pagination"><span>{remainingItemsCount} item(ns) oculto(s) neste lote</span><button type="button" className="button button-ghost" onClick={() => queue.setQueueItemDisplayLimits((current) => ({ ...current, [batch.id]: displayLimit + queueItemsIncrement }))}>Ver mais {Math.min(queueItemsIncrement, remainingItemsCount)}</button></div>}</div>
        </article>;
      })}</div>}
      {queue.queueLoaded && (queue.hasMoreBatches ? <div className="queue-load-more"><button type="button" className="button button-ghost" onClick={() => void queue.refreshQueue(true)} disabled={queue.loadingMoreBatches} aria-busy={queue.loadingMoreBatches}>{queue.loadingMoreBatches ? 'Carregando…' : 'Ver mais 10 lotes'}</button></div> : <p className="queue-end-message" role="status">Não há mais lotes para mostrar.</p>)}
    </section>
  );
}

function ReferenceQueueView({
  queue,
  profiles,
  groups,
  tab,
  setTab,
  canManage,
}: {
  queue: ReturnType<typeof usePublicationQueue>;
  profiles: QueueProfile[];
  groups: QueueGroup[];
  tab: QueueAggregateTab;
  setTab: (tab: QueueAggregateTab) => void;
  canManage: boolean;
}) {
  const cards = useMemo(() => {
    if (queue.summary) {
      const summaryRows = tab === 'account' ? queue.summary.accounts : tab === 'batch' ? queue.summary.batches : queue.summary.groups;
      return summaryRows.map((row) => {
        const title = tab === 'account' ? `@${row.username ?? 'perfil'}` : row.title ?? 'Sem nome';
        const profile = tab === 'account' ? profiles.find((candidate) => candidate.id === row.id) : null;
        return {
          id: row.id,
          initials: initials(title),
          title,
          subtitle: tab === 'account'
            ? row.display_name || providerLabel(profile?.provider)
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
          tone: row.tone,
          imageUrl: row.profile_picture_url ?? profile?.profile_picture_url ?? null,
        } satisfies AggregatedCard;
      });
    }
    const loadedItems = allItems(queue.visibleBatches);
    if (tab === 'account') {
      return profiles.map((profile) => ({ ...cardFromItems(profile.id, `@${profile.username}`, profile.display_name || providerLabel(profile.provider), loadedItems.filter(({ item }) => item.profile_id === profile.id).map(({ item }) => item)), imageUrl: profile.profile_picture_url })).filter((card) => card.total > 0);
    }
    if (tab === 'batch') {
      return queue.visibleBatches.map((batch) => cardFromItems(batch.id, batch.name || 'Sem campanha', batchScheduleSummary(batch), batchItemStatuses(batch))).filter((card) => card.total > 0);
    }
    const groupCards = groups.map((group) => {
      const profileIds = new Set((group.profile_group_members ?? []).map((member) => member.profile_id));
      return cardFromItems(group.id, group.name, `${profileIds.size} perfil(is)`, loadedItems.filter(({ item }) => profileIds.has(item.profile_id)).map(({ item }) => item));
    });
    const groupedProfileIds = new Set(groups.flatMap((group) => (group.profile_group_members ?? []).map((member) => member.profile_id)));
    const ungrouped = cardFromItems('none', 'Sem grupo', 'Perfis fora de pastas', loadedItems.filter(({ item }) => !groupedProfileIds.has(item.profile_id)).map(({ item }) => item));
    return [...groupCards, ungrouped].filter((card) => card.total > 0);
  }, [groups, profiles, queue.visibleBatches, tab]);

  const loadedItems = allItems(queue.visibleBatches).map(({ item }) => item);
  const totals = queue.summary?.totals ?? {
    total: loadedItems.filter((item) => !['cancelled', 'removed', 'ignored'].includes(item.status)).length,
    ok: loadedItems.filter((item) => item.status === 'published').length,
    pending: loadedItems.filter((item) => ['waiting', 'ready'].includes(item.status)).length,
    processing: loadedItems.filter((item) => ['preparing', 'publishing'].includes(item.status)).length,
    errors: loadedItems.filter((item) => item.status === 'failed').length,
    suspended: loadedItems.filter((item) => item.status === 'suspended').length,
    active: loadedItems.filter((item) => ['waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'].includes(item.status)).length,
    closed: loadedItems.filter((item) => ['cancelled', 'removed', 'ignored'].includes(item.status)).length,
    archived: 0,
    expiredLeases: 0,
    activeAccounts: new Set(loadedItems.filter((item) => !['published', 'cancelled', 'removed', 'ignored'].includes(item.status)).map((item) => item.profile_id)).size,
    suspendedAccounts: new Set(loadedItems.filter((item) => item.status === 'suspended').map((item) => item.profile_id)).size,
    totalAccounts: new Set(loadedItems.filter((item) => !['cancelled', 'removed', 'ignored'].includes(item.status)).map((item) => item.profile_id)).size,
    progress: progressPercent(loadedItems.filter((item) => item.status === 'published').length, loadedItems.filter((item) => !['cancelled', 'removed', 'ignored'].includes(item.status)).length),
  };

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
          <article><span>OK</span><strong>{totals.ok.toLocaleString('pt-BR')}</strong><small>publicadas</small></article>
          <article><span>PENDENTES</span><strong>{totals.pending.toLocaleString('pt-BR')}</strong><small>aguardando</small></article>
          <article className="queue-reference-kpi-error"><span>ERROS</span><strong>{totals.errors.toLocaleString('pt-BR')}</strong><small>precisam de atenção</small></article>
          <article><span>SUSPENSAS</span><strong>{totals.suspended.toLocaleString('pt-BR')}</strong><small>retomada manual</small></article>
          <article><span>CONTAS NA FILA</span><strong>{totals.activeAccounts}/{totals.totalAccounts}</strong><small>ativas / total</small></article>
        </div>

        <div className="queue-reference-progress">
          <div><span>Progresso geral</span><strong>{totals.progress}%</strong></div>
          <div className="queue-reference-progress-track" aria-label={`Progresso geral: ${totals.progress}%`}><span style={{ width: `${totals.progress}%` }} /></div>
        </div>

        <div className="queue-reference-tabs" role="tablist" aria-label="Agrupamento da fila">
          <button type="button" className={tab === 'account' ? 'is-active' : ''} onClick={() => setTab('account')} role="tab" aria-selected={tab === 'account'}>Por conta <span>{queue.summary?.accounts.length ?? profiles.length}</span></button>
          <button type="button" className={tab === 'batch' ? 'is-active' : ''} onClick={() => setTab('batch')} role="tab" aria-selected={tab === 'batch'}>Por lote <span>{queue.summary?.batches.length ?? queue.visibleBatches.length}</span></button>
          <button type="button" className={tab === 'group' ? 'is-active' : ''} onClick={() => setTab('group')} role="tab" aria-selected={tab === 'group'}>Por grupo <span>{queue.summary?.groups.length ?? groups.length}</span></button>
        </div>

        <div className="queue-reference-legend" aria-label="Legenda de estados">
          <span><i className="is-posting" /> <strong>Postando</strong> — publicação em andamento</span>
          <span><i className="is-waiting" /> <strong>Na fila</strong> — aguardando o próximo horário</span>
          <span><i className="is-error" /> <strong>Com erro</strong> — precisa de ação</span>
          <span><i className="is-suspended" /> <strong>Suspensa</strong> — perfil offline, retomada manual</span>
          <span><i className="is-done" /> <strong>Concluída</strong> — sem itens ativos</span>
        </div>

        {queue.summaryLoading && !queue.summary ? <div className="queue-reference-loading" aria-label="Carregando resumo"><span /><span /><span /></div> : cards.length === 0 ? <div className="queue-reference-empty"><span aria-hidden="true">✓</span><h3>Fila operacional vazia</h3><p>Não há itens para exibir neste agrupamento.</p></div> : <div className="queue-reference-list">
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
              <div className="queue-reference-next"><span>Próxima</span><strong>{compactFuture(card.nextAt)}</strong></div>
              <div className="queue-reference-total"><strong>{card.completed} publicadas</strong><small>{card.active ? `${card.active} ativa(s)` : card.errors ? `${card.errors} erro(s)` : card.suspended ? `${card.suspended} suspensa(s)` : 'sem itens ativos'}{card.closed ? ` · ${card.closed} cancelada(s)` : ''}</small></div>
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
        </div>}
      </div>
    </section>
  );
}

function PublicationDetailsModal({
  queue,
  profiles,
  canManage,
}: {
  queue: ReturnType<typeof usePublicationQueue>;
  profiles: QueueProfile[];
  canManage: boolean;
}) {
  const selectedQueueItem = queue.selectedQueueItem;
  const selectedQueueMedia = selectedQueueItem?.item.publication_item_media?.slice().sort((left, right) => left.position - right.position) ?? [];
  const activeQueueMedia = selectedQueueMedia[queue.selectedMediaIndex] ?? null;
  const activeQueueAsset = activeQueueMedia?.media_assets ?? null;
  const activeQueueAssetUrl = activeQueueAsset?.signed_url ?? null;
  const selectedQueueEvents = selectedQueueItem?.item.publication_item_events?.slice().sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()) ?? [];
  const selectedLatestFailure = selectedQueueEvents.find((event) => event.event_type === 'failed' && event.error_message);
  const selectedProfile = selectedQueueItem
    ? selectedQueueItem.item.profile ?? profiles.find((profile) => profile.id === selectedQueueItem.item.profile_id) ?? null
    : null;

  if (!selectedQueueItem) return null;

  return (
    <div className="publication-details-backdrop" role="presentation" onMouseDown={() => queue.setSelectedQueueItemId(null)}>
      <section className="publication-details-modal" role="dialog" aria-modal="true" aria-labelledby="publication-details-title" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><span className="section-kicker">Detalhes da publicação</span><h2 id="publication-details-title">{selectedQueueItem.batch.name || 'Publicação sem nome'}</h2></div><button type="button" className="modal-close" onClick={() => queue.setSelectedQueueItemId(null)} aria-label="Fechar detalhes">×</button></header>
        <div className="publication-details-content">
          <div className="publication-media-viewer">
            {activeQueueAssetUrl && activeQueueAsset?.kind === 'image' ? <img src={activeQueueAssetUrl} alt={activeQueueAsset.original_name} /> : activeQueueAsset?.kind === 'video' && activeQueueAssetUrl ? <video controls src={activeQueueAssetUrl} /> : <span>{activeQueueAsset?.kind === 'video' ? '▶ Vídeo selecionado' : 'Mídia indisponível'}</span>}
            {selectedQueueMedia.length > 1 && <div className="publication-media-navigation"><button type="button" onClick={() => queue.setSelectedMediaIndex((index) => Math.max(0, index - 1))} disabled={queue.selectedMediaIndex === 0}>←</button><span>{queue.selectedMediaIndex + 1} de {selectedQueueMedia.length}</span><button type="button" onClick={() => queue.setSelectedMediaIndex((index) => Math.min(selectedQueueMedia.length - 1, index + 1))} disabled={queue.selectedMediaIndex === selectedQueueMedia.length - 1}>→</button></div>}
            <div className="publication-media-strip">{selectedQueueMedia.map(({ media_assets: asset }, index) => { const url = asset?.signed_url ?? null; return <button key={asset?.id ?? index} type="button" className={index === queue.selectedMediaIndex ? 'media-strip-active' : ''} onClick={() => queue.setSelectedMediaIndex(index)}>{url && asset?.kind === 'image' ? <img src={url} alt={asset.original_name} /> : asset?.kind === 'video' ? '▶' : '▣'}</button>; })}</div>
          </div>
          <div className="publication-details-meta">
            <dl className="summary-list">
              <div><dt>Status</dt><dd>{statusLabel(selectedQueueItem.item.status)}</dd></div>
              <div><dt>Perfil</dt><dd>{selectedQueueItem.item.profile?.username ? `@${selectedQueueItem.item.profile.username}` : profiles.find((profile) => profile.id === selectedQueueItem.item.profile_id)?.username ? `@${profiles.find((profile) => profile.id === selectedQueueItem.item.profile_id)?.username}` : 'Perfil não identificado'}</dd></div>
              <div><dt>Provedor</dt><dd><span className={`queue-provider-badge queue-provider-${selectedQueueItem.item.profile?.provider ?? 'meta_official'}`}>{providerLabel(selectedQueueItem.item.profile?.provider)}</span><small className="queue-provider-detail queue-provider-detail-modal">{providerDescription(selectedQueueItem.item.profile)}</small></dd></div>
              <div><dt>Formato</dt><dd>{queueFormats.find((option) => option.value === selectedQueueItem.item.format)?.label}</dd></div>
              <div><dt>Programação</dt><dd>{selectedQueueItem.item.execute_at ? formatShortDate(selectedQueueItem.item.execute_at) : 'Execução imediata'}</dd></div>
              <div><dt>Criado por</dt><dd>{selectedQueueItem.batch.created_by_name?.trim() || selectedQueueItem.batch.created_by_email || 'Autor não identificado'}</dd></div>
              <div><dt>Criada em</dt><dd>{formatShortDate(selectedQueueItem.item.created_at ?? selectedQueueItem.batch.created_at)}</dd></div>
              <div><dt>Atualizada em</dt><dd>{formatShortDate(selectedQueueItem.item.updated_at ?? selectedQueueItem.batch.updated_at)}</dd></div>
              {selectedQueueItem.item.published_at && <div><dt>Publicada em</dt><dd>{formatShortDate(selectedQueueItem.item.published_at)}</dd></div>}
              {selectedQueueItem.item.cancelled_at && <div><dt>Cancelada em</dt><dd>{formatShortDate(selectedQueueItem.item.cancelled_at)}</dd></div>}
              {selectedQueueItem.item.suspended_at && <div><dt>Suspensa em</dt><dd>{formatShortDate(selectedQueueItem.item.suspended_at)}</dd></div>}
              {(selectedQueueItem.item.attempt_count ?? 0) > 0 && <div><dt>Tentativas</dt><dd>{attemptsLabel(selectedQueueItem.item)}</dd></div>}
            </dl>
            {activeQueueAsset && <div className="media-file-details"><strong>Arquivo {queue.selectedMediaIndex + 1}</strong><span>{activeQueueAsset.original_name}</span><small>{activeQueueAsset.kind === 'video' ? 'Vídeo' : 'Imagem'} · {activeQueueAsset.mime_type} · {(activeQueueAsset.size_bytes / 1024 / 1024).toFixed(1)} MB</small></div>}
            {selectedQueueItem.item.caption && <div className="publication-caption"><strong>Legenda</strong><p>{selectedQueueItem.item.caption}</p></div>}
            {(selectedQueueItem.item.last_error_message || selectedLatestFailure) && <div className="publication-error"><strong>Última falha registrada</strong>{(selectedQueueItem.item.last_error_code || selectedLatestFailure?.error_code) && <small>Código: {selectedQueueItem.item.last_error_code ?? selectedLatestFailure?.error_code}</small>}<p>{selectedQueueItem.item.last_error_message ?? selectedLatestFailure?.error_message}</p>{selectedQueueItem.item.publication_failure_acknowledgements?.length ? <small>Falha confirmada em {formatShortDate(selectedQueueItem.item.publication_failure_acknowledgements[0].acknowledged_at)}.</small> : null}</div>}
            {selectedQueueItem.item.status === 'suspended' && <div className="publication-error"><strong>Publicação suspensa</strong><p>{selectedQueueItem.item.suspension_reason || 'O perfil ficou offline. A retomada deverá ser feita manualmente para este lote e perfil.'}</p></div>}
            {selectedQueueItem.item.status === 'suspended' && <button type="button" className="button button-primary" disabled={!canManage || selectedProfile?.status !== 'online' || queue.queueActionId === `resume:${selectedQueueItem.batch.id}:${selectedQueueItem.item.profile_id}`} onClick={() => void queue.resumeBatchProfile(selectedQueueItem.batch.id, selectedQueueItem.item.profile_id)}>{queue.queueActionId === `resume:${selectedQueueItem.batch.id}:${selectedQueueItem.item.profile_id}` ? 'Retomando…' : selectedProfile?.status === 'online' ? 'Retomar este lote para o perfil' : 'Coloque o perfil online para retomar'}</button>}
            <section className="publication-timeline"><strong>Histórico de eventos</strong>{selectedQueueEvents.length ? <ol>{selectedQueueEvents.map((event) => <li key={event.id}><span className={`timeline-event timeline-${event.event_type}`}>{event.event_type === 'retry_requested' ? 'Retentativa solicitada' : event.event_type === 'processing_started' ? 'Processamento iniciado' : event.event_type === 'processing_deferred' ? 'Processamento adiado' : event.event_type === 'queued' ? 'Adicionada à fila' : statusLabel(event.status)}</span><time dateTime={event.created_at}>{formatShortDate(event.created_at)}</time>{event.actor_label && <small>Por {event.actor_label}</small>}{event.error_message && <p>{event.error_message}</p>}</li>)}</ol> : <p>O histórico será registrado para as próximas ações desta publicação.</p>}</section>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function QueueClient({ activeOrganization, profiles, groups, batches }: QueueClientProps) {
  const canManage = ['admin', 'operator'].includes(activeOrganization.role);
  const [viewMode, setViewMode] = useState<QueueViewMode>('lumora');
  const [aggregateTab, setAggregateTab] = useState<QueueAggregateTab>('account');
  const queue = usePublicationQueue({ initialBatches: batches, groups, canManage });

  useEffect(() => {
    const savedMode = window.localStorage.getItem('athena.queue.viewMode');
    if (savedMode === 'classic') setViewMode('classic');
  }, []);

  function changeViewMode(mode: QueueViewMode) {
    setViewMode(mode);
    window.localStorage.setItem('athena.queue.viewMode', mode);
  }

  return (
    <main className="standalone-page queue-page">
      <header className="queue-page-header">
        <div><span>{activeOrganization.name} · Operação</span><h1>Fila de publicação</h1></div>
        <div className="queue-hero-actions">
          <Link className="button button-ghost" href="/postagem" prefetch={false}>Nova postagem</Link>
          <div className="queue-view-switch" role="group" aria-label="Modelo de visualização"><button type="button" className={viewMode === 'lumora' ? 'is-active' : ''} onClick={() => changeViewMode('lumora')}>Novo</button><button type="button" className={viewMode === 'classic' ? 'is-active' : ''} onClick={() => changeViewMode('classic')}>Clássico</button></div>
        </div>
      </header>

      {queue.message && <p className={`inline-message ${queue.message.includes('cancelada') || queue.message.includes('devolvida') || queue.message.includes('liberado') ? 'inline-message-success' : ''}`} role="status">{queue.message}</p>}
      {!canManage && <p className="inline-message" role="alert">Seu papel permite acompanhar a fila, mas não executar ações operacionais.</p>}
      <QueueCancellationProgress queue={queue} />

      {viewMode === 'lumora'
        ? <><ReferenceQueueView queue={queue} profiles={profiles} groups={groups} tab={aggregateTab} setTab={setAggregateTab} canManage={canManage} /><details className="queue-jobs-disclosure"><summary>Geração assíncrona e jobs grandes <span>{queue.generationJobs.length}</span></summary><GenerationJobsPanel queue={queue} canManage={canManage} /></details></>
        : <section className="queue-classic-view"><div className="panel queue-classic-controls"><div><span className="section-kicker">Visualização clássica</span><h2>Lotes detalhados</h2><p>Filtros, publicações individuais e ações por lote.</p></div><QueueFilters queue={queue} profiles={profiles} groups={groups} /></div><ClassicQueueList queue={queue} canManage={canManage} profiles={profiles} /><GenerationJobsPanel queue={queue} canManage={canManage} /></section>}
      <BulkPlanProgressFeed location="queue" />
      <PublicationDetailsModal queue={queue} profiles={profiles} canManage={canManage} />
    </main>
  );
}
