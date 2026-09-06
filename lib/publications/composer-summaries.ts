import {
  ComposerFormat,
  emptyScheduledCountsByFormat,
  emptyPublicationFormatCounts,
  ProfilePublicationMetrics,
  PublicationFormatCounts,
  ScheduledCountsByFormat,
} from '@/lib/publications/composer';

/**
 * Leitura da resposta de /api/publications/composer/summaries.
 *
 * Estas funções viviam em app/(painel)/postagem/page.tsx, quando as contagens
 * eram agregadas no SSR para a organização inteira. Desde 06/09/2026 elas são
 * lidas sob demanda, por destino — a agregação da organização inteira passou a
 * estourar o `statement_timeout` do banco — e quem interpreta o JSON agora é o
 * cliente. O código é o mesmo; mudou de lado, não de comportamento.
 */

export type ComposerSummaryRow = {
  scheduled_post_count: number | null;
  scheduled_counts: unknown;
  published_counts: unknown;
  scheduled_by_time: unknown;
  scheduled_by_format_and_time: unknown;
};

export type ComposerProfileSummary = {
  scheduled_post_count: number;
  metrics: ProfilePublicationMetrics;
  scheduled_by_time: Record<string, number>;
  scheduled_by_format_and_time: ScheduledCountsByFormat;
};

const composerFormats: ComposerFormat[] = ['reel', 'story', 'image', 'carousel'];

export function formatCountsFromJson(value: unknown): PublicationFormatCounts {
  const counts = emptyPublicationFormatCounts();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return counts;
  const record = value as Record<string, unknown>;
  for (const format of composerFormats) {
    const count = Number(record[format] ?? 0);
    counts[format] = Number.isFinite(count) ? count : 0;
  }
  const total = Number(record.total ?? composerFormats.reduce((sum, format) => sum + counts[format], 0));
  counts.total = Number.isFinite(total) ? total : 0;
  return counts;
}

export function timeCountsFromJson(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const counts: Record<string, number> = {};
  for (const [time, raw] of Object.entries(value as Record<string, unknown>)) {
    const count = Number(raw ?? 0);
    if (Number.isFinite(count)) counts[time] = count;
  }
  return counts;
}

/**
 * Normaliza garantindo as quatro chaves de formato. A RPC já devolve todas, mas
 * o compositor lê `scheduled_by_format_and_time[formato][horário]` sem checar o
 * nível do meio: um formato ausente aqui viraria TypeError no seletor.
 */
export function formatTimeCountsFromJson(value: unknown): ScheduledCountsByFormat {
  const counts = emptyScheduledCountsByFormat();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return counts;
  const record = value as Record<string, unknown>;
  for (const format of composerFormats) {
    counts[format] = timeCountsFromJson(record[format]);
  }
  return counts;
}

export function composerSummaryFromRow(row: ComposerSummaryRow): ComposerProfileSummary {
  return {
    scheduled_post_count: row.scheduled_post_count ?? 0,
    metrics: {
      scheduled: formatCountsFromJson(row.scheduled_counts),
      published: formatCountsFromJson(row.published_counts),
    },
    scheduled_by_time: timeCountsFromJson(row.scheduled_by_time),
    scheduled_by_format_and_time: formatTimeCountsFromJson(row.scheduled_by_format_and_time),
  };
}
