import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBulkMetaRows,
  metaAppCapacity,
  metaBulkPlanMessage,
  parseMetaBulkTarget,
  resolveMetaBulkTarget,
  sortMetaAppsByFillOrder,
  type NamedMetaApp,
} from './meta-apps.ts';

function app(overrides: Partial<NamedMetaApp> & { label: string }): NamedMetaApp {
  return {
    id: `id-${overrides.label}`,
    app_id: '1571488531125130',
    active: true,
    instagram_slot_limit: 100,
    instagram_profile_count: 0,
    ...overrides,
  };
}

test('a vaga livre é o limite do app menos os perfis já conectados por ele', () => {
  const capacity = metaAppCapacity(app({ label: 'duskingapp', instagram_profile_count: 97 }));

  assert.equal(capacity.slotLimit, 100);
  assert.equal(capacity.usedSlots, 97);
  assert.equal(capacity.freeSlots, 3);
  assert.equal(capacity.connectable, true);
});

test('app cheio ou desativado não recebe conexão nova', () => {
  assert.equal(metaAppCapacity(app({ label: 'cheio', instagram_profile_count: 100 })).connectable, false);
  assert.equal(metaAppCapacity(app({ label: 'parado', active: false })).connectable, false);
});

test('contagem acima do limite não vira vaga negativa', () => {
  // Um app pode ter sido reduzido de 100 para 50 com 60 contas já dentro.
  const capacity = metaAppCapacity(app({ label: 'reduzido', instagram_slot_limit: 50, instagram_profile_count: 60 }));

  assert.equal(capacity.freeSlots, 0);
  assert.equal(capacity.connectable, false);
});

test('pedir mais do que cabe não gera nenhuma linha', () => {
  const plan = buildBulkMetaRows(app({ label: 'duskingapp', instagram_profile_count: 90 }), 13, 'GG Lexy');

  assert.equal(plan.blocked, true);
  assert.equal(plan.reason, 'insufficient_slots');
  assert.deepEqual(plan.rows, []);
  assert.equal(plan.freeSlots, 10);
  assert.match(metaBulkPlanMessage(plan, 'duskingapp'), /Não há vaga para essa API/);
});

test('pedido dentro da vaga gera uma linha app;grupo por conexão', () => {
  const plan = buildBulkMetaRows(app({ label: 'duskingapp', instagram_profile_count: 97 }), 3, 'GG Lexy');

  assert.equal(plan.blocked, false);
  assert.equal(plan.rows.length, 3);
  assert.equal(plan.text, 'duskingapp;GG Lexy\nduskingapp;GG Lexy\nduskingapp;GG Lexy');
});

test('sem grupo escolhido a linha tem só o nome do app', () => {
  const plan = buildBulkMetaRows(app({ label: 'duskingapp' }), 2, null);

  assert.equal(plan.text, 'duskingapp\nduskingapp');
});

test('usar exatamente a última vaga é permitido', () => {
  const plan = buildBulkMetaRows(app({ label: 'duskingapp', instagram_profile_count: 99 }), 1, null);

  assert.equal(plan.blocked, false);
  assert.equal(plan.rows.length, 1);
});

test('app cheio, desativado, quantidade zero e app ausente têm motivos distintos', () => {
  assert.equal(buildBulkMetaRows(app({ label: 'cheio', instagram_profile_count: 100 }), 1).reason, 'app_full');
  assert.equal(buildBulkMetaRows(app({ label: 'parado', active: false }), 1).reason, 'inactive_app');
  assert.equal(buildBulkMetaRows(app({ label: 'ok' }), 0).reason, 'invalid_quantity');
  assert.equal(buildBulkMetaRows(null, 5).reason, 'no_app_selected');
});

test('quantidade fracionada ou inválida é truncada antes de virar pedido', () => {
  assert.equal(buildBulkMetaRows(app({ label: 'ok' }), 2.9).rows.length, 2);
  assert.equal(buildBulkMetaRows(app({ label: 'ok' }), Number.NaN).reason, 'invalid_quantity');
  assert.equal(buildBulkMetaRows(app({ label: 'ok' }), -4).reason, 'invalid_quantity');
});

test('a gramática colada aceita só app ou app;grupo', () => {
  assert.equal(parseMetaBulkTarget('duskingapp').kind, 'valid');
  assert.equal(parseMetaBulkTarget('duskingapp;GG Lexy').kind, 'valid');
  assert.equal(parseMetaBulkTarget('duskingapp;').kind, 'invalid_format');
  assert.equal(parseMetaBulkTarget(';GG Lexy').kind, 'invalid_format');
  assert.equal(parseMetaBulkTarget('a;b;c').kind, 'invalid_format');
  assert.equal(parseMetaBulkTarget('').kind, 'empty');
});

test('o nome colado não é normalizado: caixa e espaço fazem parte do valor', () => {
  const apps = [app({ label: 'duskingapp' })];
  const groups = [{ id: 'g1', name: 'GG Lexy' }];

  assert.equal(resolveMetaBulkTarget(apps, groups, 'DuskingApp;GG Lexy').appStatus, 'missing');
  assert.equal(resolveMetaBulkTarget(apps, groups, 'duskingapp;gg lexy').groupStatus, 'missing');
  assert.equal(resolveMetaBulkTarget(apps, groups, 'duskingapp;GG Lexy').valid, true);
});

test('app cheio colado é reconhecido, mas recusado com o motivo certo', () => {
  const apps = [app({ label: 'duskingapp', instagram_profile_count: 100 })];
  const resolved = resolveMetaBulkTarget(apps, [], 'duskingapp');

  assert.equal(resolved.appStatus, 'full');
  assert.equal(resolved.valid, false);
  // O app precisa continuar exposto para a tela conseguir nomear o problema.
  assert.equal(resolved.app?.label, 'duskingapp');
});

test('app desativado colado é recusado sem virar "não encontrado"', () => {
  const resolved = resolveMetaBulkTarget([app({ label: 'parado', active: false })], [], 'parado');

  assert.equal(resolved.appStatus, 'inactive');
  assert.equal(resolved.valid, false);
});

test('nome duplicado é ambíguo e nunca resolve para um app', () => {
  const apps = [app({ label: 'igual', id: 'a' }), app({ label: 'igual', id: 'b' })];
  const resolved = resolveMetaBulkTarget(apps, [], 'igual');

  assert.equal(resolved.appStatus, 'duplicate');
  assert.equal(resolved.app, null);
  assert.equal(resolved.valid, false);
});

test('a ordem de preenchimento fecha um app antes de abrir o próximo', () => {
  const ordered = sortMetaAppsByFillOrder([
    app({ label: 'vazio', instagram_profile_count: 0 }),
    app({ label: 'cheio', instagram_profile_count: 100 }),
    app({ label: 'quase', instagram_profile_count: 98 }),
  ]);

  assert.deepEqual(ordered.map((item) => item.label), ['quase', 'vazio', 'cheio']);
});
