import assert from 'node:assert/strict';
import test from 'node:test';

import { tokenFingerprint } from './token-crypto.ts';

test('fingerprint de token é determinístico, normalizado e separado por domínio', () => {
  const previousKey = process.env.TOKEN_ENCRYPTION_KEY;
  try {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const first = tokenFingerprint(' chave-secreta ', 'zernio');
    const second = tokenFingerprint('chave-secreta', 'zernio');
    const anotherDomain = tokenFingerprint('chave-secreta', 'meta');

    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(first, second);
    assert.notEqual(first, anotherDomain);
    assert.equal(first.includes('chave-secreta'), false);
  } finally {
    if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
  }
});
