export type BulkRolloutRole = 'admin' | 'operator' | 'viewer';

export function bulkPublishingEnabled(role: BulkRolloutRole | string | undefined) {
  const rollout = (process.env.BULK_PUBLICATION_ROLLOUT ?? 'all').trim().toLowerCase();
  if (rollout === 'off') return false;
  if (rollout === 'admins') return role === 'admin';
  if (rollout === 'managers') return role === 'admin' || role === 'operator';
  return rollout === 'all';
}
