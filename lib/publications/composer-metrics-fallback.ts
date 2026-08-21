import { emptyPublicationFormatCounts } from './composer.ts';
import type { ComposerFormat, PublicationFormatCounts } from './composer.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

export type ComposerMetricItem = {
  profile_id: string;
  format: ComposerFormat;
  status: 'waiting' | 'ready' | 'preparing' | 'publishing' | 'published';
  execute_at: string | null;
};

export type ComposerMetricRow = {
  profile_id: string;
  scheduled_post_count: number;
  scheduled_execute_ats: string[];
  scheduled_execute_ats_by_format: Record<ComposerFormat, string[]>;
  scheduled_counts: PublicationFormatCounts;
  published_counts: PublicationFormatCounts;
};

const composerFormats: ComposerFormat[] = ['reel', 'story', 'image', 'carousel'];
const composerMetricStatuses: ComposerMetricItem['status'][] = ['waiting', 'ready', 'preparing', 'publishing', 'published'];
const composerMetricPageSize = 1_000;

/**
 * Busca a fila inteira para não deixar a paginação padrão do PostgREST
 * transformar itens depois da primeira página em métricas 0/0.
 */
export async function fetchAllComposerMetricItems(
  supabase: SupabaseClient,
  organizationId: string,
  nowIso = new Date().toISOString(),
): Promise<ComposerMetricItem[]> {
  const buildQuery = () => supabase
    .from('publication_items')
    .select('id, profile_id, format, status, execute_at', { count: 'exact' })
    .eq('organization_id', organizationId)
    .in('status', composerMetricStatuses)
    .or(`execute_at.is.null,execute_at.gt.${nowIso},status.eq.published`)
    .order('id', { ascending: true });

  const firstPage = await buildQuery().range(0, composerMetricPageSize - 1);
  if (firstPage.error) throw firstPage.error;

  const items = (firstPage.data ?? []) as ComposerMetricItem[];
  const total = firstPage.count ?? items.length;
  for (let offset = composerMetricPageSize; offset < total; offset += composerMetricPageSize) {
    const page = await buildQuery().range(offset, offset + composerMetricPageSize - 1);
    if (page.error) throw page.error;
    const pageItems = (page.data ?? []) as ComposerMetricItem[];
    items.push(...pageItems);
    if (pageItems.length < composerMetricPageSize) break;
  }

  return items;
}

export function composerMetricsFromItems(
  profiles: Array<{ id: string }>,
  items: ComposerMetricItem[],
  now = Date.now(),
  horizonDays = 90,
): ComposerMetricRow[] {
  const horizon = now + horizonDays * 24 * 60 * 60 * 1000;
  const rows = new Map<string, ComposerMetricRow>(profiles.map((profile) => [profile.id, {
    profile_id: profile.id,
    scheduled_post_count: 0,
    scheduled_execute_ats: [] as string[],
    scheduled_execute_ats_by_format: Object.fromEntries(composerFormats.map((format) => [format, [] as string[]])) as Record<ComposerFormat, string[]>,
    scheduled_counts: emptyPublicationFormatCounts(),
    published_counts: emptyPublicationFormatCounts(),
  }]));

  for (const item of items) {
    const row = rows.get(item.profile_id);
    if (!row || !composerFormats.includes(item.format)) continue;
    if (item.status === 'published') {
      row.published_counts[item.format] += 1;
      row.published_counts.total += 1;
      continue;
    }
    const executeAt = item.execute_at ? new Date(item.execute_at).getTime() : Number.NaN;
    if (item.execute_at && (!Number.isFinite(executeAt) || executeAt <= now)) continue;
    row.scheduled_counts[item.format] += 1;
    row.scheduled_counts.total += 1;
    row.scheduled_post_count += 1;
    if (item.execute_at && executeAt <= horizon) {
      row.scheduled_execute_ats.push(item.execute_at);
      row.scheduled_execute_ats_by_format[item.format].push(item.execute_at);
    }
  }

  return [...rows.values()];
}
