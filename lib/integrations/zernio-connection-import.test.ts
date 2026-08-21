import assert from 'node:assert/strict';
import test from 'node:test';

import { parseZernioConnectionImport } from './zernio-connection-import.ts';

test('pareia nomes e API keys pela ordem das linhas', () => {
  const draft = parseZernioConnectionImport('Conta A\nConta B', 'sk_1234567890\nsk_0987654321');
  assert.equal(draft.valid, true);
  assert.deepEqual(draft.rows.map(({ label, apiKey }) => ({ label, apiKey })), [
    { label: 'Conta A', apiKey: 'sk_1234567890' },
    { label: 'Conta B', apiKey: 'sk_0987654321' },
  ]);
});

test('bloqueia quantidades divergentes sem expor as chaves', () => {
  const draft = parseZernioConnectionImport('Conta A\nConta B', 'sk_1234567890');
  assert.equal(draft.valid, false);
  assert.equal(draft.nameCount, 2);
  assert.equal(draft.apiKeyCount, 1);
  assert.match(draft.issues[0]?.message ?? '', /2 nome\(s\) e 1 API key\(s\)/);
});

test('rejeita nomes duplicados sem diferenciar maiúsculas de minúsculas', () => {
  const draft = parseZernioConnectionImport('Conta Ágata\nconta ágata', 'sk_1234567890\nsk_0987654321');
  assert.equal(draft.valid, false);
  assert.match(draft.issues.map((issue) => issue.message).join('\n'), /Nome repetido/);
});

test('não desloca o pareamento quando há linha vazia no meio', () => {
  const draft = parseZernioConnectionImport('Conta A\n\nConta C', 'sk_1234567890\nsk_0987654321\nsk_1122334455');
  assert.equal(draft.valid, false);
  assert.match(draft.issues.map((issue) => issue.message).join('\n'), /Informe o nome da conta nesta linha/);
  assert.equal(draft.rows[2]?.label, 'Conta C');
});
