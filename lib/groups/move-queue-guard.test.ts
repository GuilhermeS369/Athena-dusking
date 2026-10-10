import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { describeBlockedMove, splitProfilesByOpenQueue } from './move-queue-guard.ts';

test('perfil sem fila passa mesmo que outros do pedido tenham fila', () => {
  const result = splitProfilesByOpenQueue(['a', 'b', 'c'], [
    { profile_id: 'b', open_items: 76, active_horizons: 1 },
  ]);
  assert.deepEqual(result.movableProfileIds, ['a', 'c']);
  assert.deepEqual(result.blockedProfileIds, ['b']);
  assert.equal(result.blockedOpenItems, 76);
});

test('reserva de plano ativa sem item aberto também barra', () => {
  const result = splitProfilesByOpenQueue(['a'], [{ profile_id: 'a', open_items: 0, active_horizons: 1 }]);
  assert.deepEqual(result.blockedProfileIds, ['a']);
  assert.deepEqual(result.movableProfileIds, []);
  assert.equal(result.blockedOpenItems, 0);
});

test('sem linhas, todo mundo passa; contagem como texto do PostgREST é somada', () => {
  assert.deepEqual(splitProfilesByOpenQueue(['a', 'b'], null).movableProfileIds, ['a', 'b']);
  const result = splitProfilesByOpenQueue(['a', 'b'], [
    { profile_id: 'a', open_items: '10', active_horizons: '0' },
    { profile_id: 'b', open_items: '5', active_horizons: '0' },
  ]);
  assert.equal(result.blockedOpenItems, 15);
});

test('a frase diz quantos e manda cancelar a fila', () => {
  assert.match(describeBlockedMove(1, 1, 76), /Este perfil ainda tem fila aberta \(76 post\(s\) na fila\)/);
  assert.match(describeBlockedMove(3, 3, 0), /os 3 selecionados ainda têm fila aberta \(plano em massa ativo\)/);
});

test('a rota confere a fila antes de mover e só move quem passou', () => {
  const route = readFileSync(new URL('../../app/api/groups/[groupId]/members/move/route.ts', import.meta.url), 'utf8');
  const check = route.indexOf("rpc('get_profiles_with_open_publication_queue'");
  const move = route.indexOf("rpc('move_profile_group_members'");
  assert.ok(check > 0 && move > check, 'a conferência vem antes da movimentação');
  assert.match(route, /p_profile_ids: movableProfileIds/);
  assert.match(route, /nada foi movido/);
});
