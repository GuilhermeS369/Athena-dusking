export const BULK_PROFILE_RENDER_BATCH = 80;

export type BulkProfileFormat = 'image' | 'reel' | 'story';

export type BulkProfileMetricCounts = Record<BulkProfileFormat, number>;

export type BulkProfileListItem = {
  id: string;
  username: string;
  display_name?: string | null;
  publication_metrics?: {
    scheduled: BulkProfileMetricCounts;
    published: BulkProfileMetricCounts;
  };
};

export type BulkProfileQueueMetric = {
  published: number;
  scheduled: number;
  total: number;
  remaining: number;
  progress: number;
};

export function bulkProfileRenderLimit(
  currentLimit: number,
  totalProfiles: number,
  batchSize = BULK_PROFILE_RENDER_BATCH,
) {
  const safeTotal = Math.max(0, Math.trunc(totalProfiles));
  const safeBatch = Math.max(1, Math.trunc(batchSize));
  const safeCurrent = Math.max(0, Math.trunc(currentLimit));
  return Math.min(safeTotal, Math.max(safeBatch, safeCurrent + safeBatch));
}

export function selectAllBulkProfileIds(currentIds: string[], filteredIds: string[]) {
  return [...new Set([...currentIds, ...filteredIds])];
}

export function bulkProfileQueueMetric(
  profile: BulkProfileListItem,
  format: BulkProfileFormat,
): BulkProfileQueueMetric {
  const published = Math.max(0, Math.trunc(profile.publication_metrics?.published[format] ?? 0));
  const scheduled = Math.max(0, Math.trunc(profile.publication_metrics?.scheduled[format] ?? 0));
  const total = published + scheduled;
  return {
    published,
    scheduled,
    total,
    remaining: scheduled,
    progress: total === 0 ? 0 : Math.min(100, (published / total) * 100),
  };
}

export function filterBulkProfiles<T extends BulkProfileListItem>(
  profiles: T[],
  search: string,
  groupMemberIds: ReadonlySet<string> | null,
) {
  const query = search.trim().toLocaleLowerCase('pt-BR');
  return profiles.filter((profile) => (
    (!groupMemberIds || groupMemberIds.has(profile.id))
    && (!query || `${profile.username} ${profile.display_name ?? ''}`.toLocaleLowerCase('pt-BR').includes(query))
  ));
}

/**
 * Mantém perfis sem histórico/fila no topo e, depois, prioriza quem possui
 * menos publicações restantes. O desempate explícito evita saltos visuais.
 */
export function sortBulkProfilesByQueue<T extends BulkProfileListItem>(
  profiles: T[],
  format: BulkProfileFormat,
) {
  return profiles.slice().sort((left, right) => {
    const leftMetric = bulkProfileQueueMetric(left, format);
    const rightMetric = bulkProfileQueueMetric(right, format);
    const leftEmpty = leftMetric.total === 0;
    const rightEmpty = rightMetric.total === 0;
    if (leftEmpty !== rightEmpty) return leftEmpty ? -1 : 1;
    if (leftMetric.remaining !== rightMetric.remaining) return leftMetric.remaining - rightMetric.remaining;
    if (leftMetric.total !== rightMetric.total) return leftMetric.total - rightMetric.total;
    const usernameOrder = left.username.localeCompare(right.username, 'pt-BR', { sensitivity: 'base' });
    return usernameOrder || left.id.localeCompare(right.id);
  });
}

/** Seleciona um intervalo sobre a ordem lógica completa, inclusive fora do DOM. */
export function selectBulkProfileRange(
  currentIds: string[],
  orderedIds: string[],
  targetId: string,
  anchorId: string | null,
  shiftKey: boolean,
) {
  if (!shiftKey || !anchorId) {
    return currentIds.includes(targetId)
      ? currentIds.filter((id) => id !== targetId)
      : [...currentIds, targetId];
  }
  const anchorIndex = orderedIds.indexOf(anchorId);
  const targetIndex = orderedIds.indexOf(targetId);
  if (anchorIndex < 0 || targetIndex < 0) {
    return currentIds.includes(targetId)
      ? currentIds.filter((id) => id !== targetId)
      : [...currentIds, targetId];
  }
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return [...new Set([...currentIds, ...orderedIds.slice(start, end + 1)])];
}

export type BulkProfileSelection = {
  ids: string[];
  anchorId: string | null;
};

/**
 * Atualiza seleção e âncora no mesmo estado. A âncora continua válida quando
 * uma troca de formato apenas reordena os mesmos perfis; se um filtro a
 * ocultar, usa o último perfil selecionado que ainda está visível.
 */
export function toggleBulkProfileSelection(
  current: BulkProfileSelection,
  orderedIds: string[],
  targetId: string,
  shiftKey: boolean,
): BulkProfileSelection {
  const anchorId = current.anchorId && orderedIds.includes(current.anchorId)
    ? current.anchorId
    : current.ids.slice().reverse().find((id) => orderedIds.includes(id)) ?? null;
  return {
    ids: selectBulkProfileRange(current.ids, orderedIds, targetId, anchorId, shiftKey),
    anchorId: targetId,
  };
}

export function bulkPublicationProjection(
  durationDays: string,
  intervalMinutes: string,
  profileCount: number,
  scheduleMode: 'interval' | 'daily_time' = 'interval',
) {
  try {
    const days = BigInt(durationDays);
    const profiles = BigInt(Math.max(0, Math.trunc(profileCount)));
    if (days < BigInt(1)) {
      return { slotsPerProfile: BigInt(0), expectedPublications: BigInt(0) };
    }
    if (scheduleMode === 'daily_time') {
      return { slotsPerProfile: days, expectedPublications: days * profiles };
    }
    const interval = BigInt(intervalMinutes);
    if (interval < BigInt(1)) return { slotsPerProfile: BigInt(0), expectedPublications: BigInt(0) };
    const slotsPerProfile = (days * BigInt(1440)) / interval;
    return { slotsPerProfile, expectedPublications: slotsPerProfile * profiles };
  } catch {
    return { slotsPerProfile: BigInt(0), expectedPublications: BigInt(0) };
  }
}
