import assert from 'node:assert/strict';
import test from 'node:test';

import { describeBulkPlanAttention, summarizeBulkPlanAttention } from './bulk-plan-attention.ts';

test('resume perfis removidos como indisponíveis e preserva a quantidade faltante', () => {
  const attention = summarizeBulkPlanAttention([
    {
      profile_id: 'profile-a', status: 'cancelled', slot_count: 41, generated_items: 0, ignored_items: 0, failed_items: 41,
      last_error_message: 'bulk_publication_horizon_conflict',
      instagram_profiles: { username: 'jozafh5', status: 'offline', deleted_at: '2026-08-18T11:20:17Z' },
    },
    {
      profile_id: 'profile-b', status: 'cancelled', slot_count: 41, generated_items: 0, ignored_items: 0, failed_items: 41,
      last_error_message: 'bulk_publication_horizon_conflict',
      instagram_profiles: { username: 'retainer2738484', status: 'offline', deleted_at: '2026-08-18T11:20:17Z' },
    },
  ], 'completed_with_errors');

  assert.deepEqual(attention, {
    missingPublications: '82',
    affectedProfiles: [
      { username: 'jozafh5', missingPublications: '41', reason: 'profile_unavailable' },
      { username: 'retainer2738484', missingPublications: '41', reason: 'profile_unavailable' },
    ],
    remainingAffectedProfiles: '0',
  });
  assert.equal(describeBulkPlanAttention(attention!, 'reel', '369', 'completed_with_errors'), '82 Reels não foram gerados porque @jozafh5 e @retainer2738484 ficaram indisponíveis durante a geração. As demais 369 publicações foram programadas normalmente.');
});

test('diferencia conflito de programação de perfil indisponível', () => {
  const attention = summarizeBulkPlanAttention([{
    profile_id: 'profile-a', status: 'failed', slot_count: 10, generated_items: 0, ignored_items: 0, failed_items: 10,
    last_error_message: 'bulk_publication_horizon_conflict',
    instagram_profiles: { username: 'ativo', status: 'online', deleted_at: null },
  }], 'completed_with_errors');

  assert.equal(attention?.affectedProfiles[0]?.reason, 'schedule_conflict');
  assert.match(describeBulkPlanAttention(attention!, 'reel', '20', 'completed_with_errors'), /pendência de programação/);
});
