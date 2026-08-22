import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('logs X exibem contexto financeiro e evidências usando somente dados locais', async () => {
  const source = await readFile(
    new URL('../../app/(painel)/x/logs/page.tsx', import.meta.url),
    'utf8',
  );

  for (const expected of [
    'twitter_operation_logs',
    'twitter_item_holds',
    'twitter_wallet_reservations',
    'twitter_reservation_events',
    'twitter_wallet_ledger',
    'Perfil',
    'Conexão',
    'Categoria',
    'Request ID',
    'Post ID',
    'Timeline de reserva e ledger',
    'Ver evidências',
  ]) {
    assert.ok(source.includes(expected), expected);
  }

  assert.doesNotMatch(source, /zernio|ZERNIO|\/v1\//);
});

test('viewer não recebe controles de reconciliação financeira', async () => {
  const source = await readFile(
    new URL('../../app/(painel)/x/logs/page.tsx', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /const canResolve = context\.activeOrganization\.role !== "viewer"/,
  );
  assert.match(source, /log\.attempt_id &&\s+canResolve/);
  assert.match(source, /log\.status === "outcome_unknown" && canResolve/);
});

test('reconciliação explica que não repete a chamada externa', async () => {
  const source = await readFile(
    new URL('../../app/x/twitter-log-resolution.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /Esta ação não\s+repete a chamada original/);
  assert.match(source, /justification: j/);
});
