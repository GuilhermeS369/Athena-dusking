import assert from 'node:assert/strict';
import test from 'node:test';

import { bulkPublishingEnabled } from './bulk-feature.ts';

test('rollout padrão mantém compatibilidade e libera todos os papéis', () => {
  delete process.env.BULK_PUBLICATION_ROLLOUT;
  assert.equal(bulkPublishingEnabled('viewer'), true);
});

test('rollout pode restringir a administradores ou gestores', () => {
  process.env.BULK_PUBLICATION_ROLLOUT = 'admins';
  assert.equal(bulkPublishingEnabled('admin'), true);
  assert.equal(bulkPublishingEnabled('operator'), false);
  process.env.BULK_PUBLICATION_ROLLOUT = 'managers';
  assert.equal(bulkPublishingEnabled('operator'), true);
  assert.equal(bulkPublishingEnabled('viewer'), false);
  delete process.env.BULK_PUBLICATION_ROLLOUT;
});

test('rollout off funciona como rollback imediato de criação', () => {
  process.env.BULK_PUBLICATION_ROLLOUT = 'off';
  assert.equal(bulkPublishingEnabled('admin'), false);
  delete process.env.BULK_PUBLICATION_ROLLOUT;
});
