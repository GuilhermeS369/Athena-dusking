import assert from 'node:assert/strict';
import test from 'node:test';

import { TWITTER_MEDIA_MAX_BYTES, validateTwitterMedia } from './media.ts';

test('mídia X aceita formatos previstos e limita 512 MB', () => {
  assert.deepEqual(validateTwitterMedia({ type: 'image/jpeg', size: 10 }), { valid: true, kind: 'image' });
  assert.deepEqual(validateTwitterMedia({ type: 'image/gif', size: 10 }), { valid: true, kind: 'gif' });
  assert.deepEqual(validateTwitterMedia({ type: 'video/quicktime', size: TWITTER_MEDIA_MAX_BYTES }), { valid: true, kind: 'video' });
  assert.equal(validateTwitterMedia({ type: 'video/mp4', size: TWITTER_MEDIA_MAX_BYTES + 1 }).valid, false);
  assert.equal(validateTwitterMedia({ type: 'image/svg+xml', size: 10 }).valid, false);
});
