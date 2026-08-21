export type BulkPlanAttentionReason = 'profile_unavailable' | 'schedule_conflict' | 'generation_failed';

export type BulkPlanAttention = {
  missingPublications: string;
  affectedProfiles: Array<{
    username: string;
    missingPublications: string;
    reason: BulkPlanAttentionReason;
  }>;
  remainingAffectedProfiles: string;
};

type ChunkProfile = {
  username: string | null;
  status: string | null;
  deleted_at: string | null;
} | null | Array<{
  username: string | null;
  status: string | null;
  deleted_at: string | null;
}>;

export type BulkPlanAttentionChunk = {
  profile_id: string;
  status: string;
  slot_count: number | string;
  generated_items: number | string;
  ignored_items: number | string;
  failed_items: number | string;
  last_error_message: string | null;
  instagram_profiles: ChunkProfile;
};

const MAX_VISIBLE_PROFILES = 5;
const terminalPlanStatuses = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);

function integer(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function missingItems(chunk: BulkPlanAttentionChunk) {
  const failed = integer(chunk.failed_items);
  if (failed > 0) return failed;
  return Math.max(0, integer(chunk.slot_count) - integer(chunk.generated_items) - integer(chunk.ignored_items));
}

function reasonFor(chunk: BulkPlanAttentionChunk): BulkPlanAttentionReason {
  const profile = Array.isArray(chunk.instagram_profiles) ? chunk.instagram_profiles[0] ?? null : chunk.instagram_profiles;
  const unavailable = profile !== null
    && (profile.deleted_at !== null || profile.status !== 'online');
  if (unavailable) return 'profile_unavailable';
  if (chunk.last_error_message === 'bulk_publication_horizon_conflict') return 'schedule_conflict';
  return 'generation_failed';
}

export function summarizeBulkPlanAttention(
  chunks: BulkPlanAttentionChunk[],
  planStatus: string,
): BulkPlanAttention | null {
  const profiles = new Map<string, { username: string; missing: number; reason: BulkPlanAttentionReason }>();

  for (const chunk of chunks) {
    const terminal = ['failed', 'cancelled'].includes(chunk.status);
    const pausedUnavailable = chunk.status === 'paused' && reasonFor(chunk) === 'profile_unavailable';
    if (!terminal && !pausedUnavailable) continue;
    if (chunk.last_error_message === 'Cancelado pela fila operacional.') continue;

    const missing = missingItems(chunk);
    if (missing === 0) continue;

    const reason = reasonFor(chunk);
    const existing = profiles.get(chunk.profile_id);
    const profile = Array.isArray(chunk.instagram_profiles) ? chunk.instagram_profiles[0] ?? null : chunk.instagram_profiles;
    const username = profile?.username?.trim() || 'perfil sem nome';
    if (existing) {
      existing.missing += missing;
      if (reason === 'profile_unavailable') existing.reason = reason;
    } else {
      profiles.set(chunk.profile_id, { username, missing, reason });
    }
  }

  if (!profiles.size) return null;
  const entries = [...profiles.values()].sort((left, right) => right.missing - left.missing || left.username.localeCompare(right.username, 'pt-BR'));
  const missing = entries.reduce((total, entry) => total + entry.missing, 0);
  return {
    missingPublications: String(missing),
    affectedProfiles: entries.slice(0, MAX_VISIBLE_PROFILES).map((entry) => ({
      username: entry.username,
      missingPublications: String(entry.missing),
      reason: entry.reason,
    })),
    remainingAffectedProfiles: String(Math.max(0, entries.length - MAX_VISIBLE_PROFILES)),
  };
}

function listUsernames(attention: BulkPlanAttention) {
  const names = attention.affectedProfiles.map((profile) => `@${profile.username}`);
  const overflow = Number(attention.remainingAffectedProfiles);
  if (overflow > 0) names.push(`e mais ${overflow}`);
  if (names.length <= 1) return names[0] ?? 'um perfil';
  return `${names.slice(0, -1).join(', ')} e ${names.at(-1)}`;
}

export function describeBulkPlanAttention(
  attention: BulkPlanAttention,
  format: 'image' | 'reel' | 'story',
  generatedPublications: string,
  planStatus: string,
) {
  const missing = Number(attention.missingPublications).toLocaleString('pt-BR');
  const generated = Number(generatedPublications).toLocaleString('pt-BR');
  const publication = format === 'reel' ? 'Reels' : format === 'story' ? 'Stories' : 'publicações';
  const names = listUsernames(attention);
  const allUnavailable = attention.affectedProfiles.every((profile) => profile.reason === 'profile_unavailable');

  if (!terminalPlanStatuses.has(planStatus)) {
    return allUnavailable
      ? `${missing} ${publication} aguardam porque ${names} ${attention.affectedProfiles.length === 1 ? 'ficou indisponível' : 'ficaram indisponíveis'} durante a geração.`
      : `${missing} ${publication} exigem atenção em ${names} antes da geração continuar.`;
  }
  if (allUnavailable) {
    return `${missing} ${publication} não foram gerados porque ${names} ${attention.affectedProfiles.length === 1 ? 'ficou indisponível' : 'ficaram indisponíveis'} durante a geração. As demais ${generated} publicações foram programadas normalmente.`;
  }
  return `${missing} ${publication} não foram gerados devido a uma pendência de programação em ${names}. As demais ${generated} publicações foram programadas normalmente.`;
}
