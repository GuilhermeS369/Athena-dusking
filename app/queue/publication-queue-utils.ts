import { PUBLICATION_MAX_ATTEMPTS } from '@/lib/publications/attempts';

import type { Batch, IntegrationProvider, PublicationGenerationJob, QueueAsset, QueueItem, QueueProfile } from './publication-queue-types';

export const initialQueueItemsPerBatch = 5;
export const queueItemsIncrement = 5;
export const cancelableQueueStatuses = new Set(['waiting', 'ready', 'preparing', 'publishing', 'failed']);
export const activeGenerationJobStatuses = new Set(['queued', 'processing']);
export const cancelableGenerationJobStatuses = new Set(['queued', 'processing', 'paused', 'failed']);
export const activeQueueStatuses = new Set(['waiting', 'ready', 'preparing', 'publishing']);
export const terminalQueueStatuses = new Set(['published', 'cancelled', 'removed']);

export const queueFormats: Array<{ value: QueueItem['format']; label: string; short: string }> = [
  { value: 'image', label: 'Imagem', short: 'IMG' },
  { value: 'reel', label: 'Reel', short: 'REEL' },
  { value: 'story', label: 'Story', short: 'STORY' },
  { value: 'carousel', label: 'Carrossel', short: 'CAR' },
];

export function statusLabel(value: string) {
  const labels: Record<string, string> = {
    queued: 'Na fila',
    waiting: 'Agendado',
    ready: 'Pronto',
    preparing: 'Preparando',
    publishing: 'Publicando',
    processing: 'Processando',
    paused: 'Pausado',
    suspended: 'Suspenso',
    published: 'Publicado',
    failed: 'Falhou',
    removed: 'Mídia apagada',
    completed: 'Concluído',
    completed_with_errors: 'Concluído com falhas',
    cancelled: 'Cancelado',
  };
  return labels[value] ?? value;
}

export function providerLabel(provider: IntegrationProvider | null | undefined) {
  return provider === 'zernio' ? 'Zernio' : 'API Oficial';
}

export function providerDescription(profile: QueueProfile | null | undefined) {
  if (!profile) return 'Provedor não carregado';
  if (profile.provider !== 'zernio') return 'Instagram Graph API oficial';
  return profile.zernio_connection_label
    ? `Conta Zernio: ${profile.zernio_connection_label}`
    : profile.zernio_account_id
      ? `Social account: ${profile.zernio_account_id}`
      : 'Conta Zernio vinculada';
}

export function formatShortDate(value: string | null | undefined) {
  if (!value) return 'Não informado';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function batchItemStatuses(batch: Batch) {
  return batch.publication_items ?? [];
}

export function batchScheduleSummary(batch: Batch) {
  const schedule = batchItemStatuses(batch)
    .map((item) => item.execute_at)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime());
  if (!schedule.length) return 'Execução imediata';
  if (schedule.length === 1) return `Programada para ${formatShortDate(schedule[0])}`;
  return `Programadas de ${formatShortDate(schedule[0])} até ${formatShortDate(schedule.at(-1))}`;
}

export function batchStatusSummary(batch: Batch) {
  const counts = batchItemStatuses(batch).reduce<Record<string, number>>((summary, item) => {
    summary[item.status] = (summary[item.status] ?? 0) + 1;
    return summary;
  }, {});
  return Object.entries(counts).map(([status, count]) => ({ status, count }));
}

export function isQueueItemCancelable(item: QueueItem) {
  return cancelableQueueStatuses.has(item.status);
}

export function queueItemDateValue(value: string | null | undefined, fallback = Number.POSITIVE_INFINITY) {
  if (!value) return fallback;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? fallback : time;
}

export function sortQueueItemsBySchedule(items: QueueItem[]) {
  return items.slice().sort((left, right) => {
    const scheduledDiff = queueItemDateValue(left.execute_at) - queueItemDateValue(right.execute_at);
    if (scheduledDiff !== 0) return scheduledDiff;

    const createdDiff = queueItemDateValue(left.created_at, 0) - queueItemDateValue(right.created_at, 0);
    if (createdDiff !== 0) return createdDiff;

    return left.id.localeCompare(right.id);
  });
}

export function uniqueBatches(nextBatches: Batch[]) {
  const seen = new Set<string>();
  return nextBatches.filter((batch) => {
    if (seen.has(batch.id)) return false;
    seen.add(batch.id);
    return true;
  });
}

export function generationJobProgress(job: PublicationGenerationJob) {
  const expectedItems = Math.max(job.expected_items ?? 0, job.generated_items + job.failed_items, 1);
  const processedItems = Math.min(expectedItems, job.generated_items + job.failed_items);
  return Math.round((processedItems / expectedItems) * 100);
}

export function queueItemMediaDeleted(item: QueueItem) {
  return item.status === 'removed'
    || item.last_error_code === 'media_deleted'
    || (item.publication_item_media ?? []).some((media) => media.media_assets?.status === 'deleted' || Boolean(media.media_assets?.deleted_at));
}

export function queueItemMessage(item: QueueItem) {
  if (queueItemMediaDeleted(item)) return 'Mídia apagada.';
  const message = item.last_error_message?.trim();
  if (!message) return null;
  const diagnosticIndex = message.indexOf(' — Diagnóstico Zernio:');
  const compact = diagnosticIndex >= 0 ? message.slice(0, diagnosticIndex) : message;
  return compact.length > 260 ? `${compact.slice(0, 257).trimEnd()}…` : compact;
}

export function queueAssetUrl(asset: QueueAsset | null) {
  return asset?.signed_url ?? null;
}

export function queueAssetThumbnailUrl(asset: QueueAsset | null) {
  return asset?.thumbnail_url ?? null;
}

export function queuePreviewUrl(asset: QueueAsset | null) {
  return asset?.kind === 'video' ? queueAssetThumbnailUrl(asset) : queueAssetUrl(asset);
}

export function rescheduleSummary(item: QueueItem) {
  const event = item.publication_item_events
    ?.slice()
    .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
    .find((candidate) => candidate.error_code === 'missed_schedule_recovered');
  if (!event) return null;

  const previous = typeof event.metadata.previous_execute_at === 'string' ? event.metadata.previous_execute_at : null;
  const current = typeof event.metadata.rescheduled_execute_at === 'string' ? event.metadata.rescheduled_execute_at : item.execute_at;
  return `Reagendado automaticamente: ${formatShortDate(previous)} → ${formatShortDate(current)}.`;
}

export function attemptsLabel(item: QueueItem) {
  return `${item.attempt_count ?? 0} de ${PUBLICATION_MAX_ATTEMPTS}`;
}
