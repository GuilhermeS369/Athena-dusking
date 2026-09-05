import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBulkMetaRows,
  metaAppCapacity,
  metaBulkPlanMessage,
  parseMetaBulkTarget,
  resolveMetaBulkTarget,
  sortMetaAppsByFillOrder,
  sortMetaAppsByLabel,
  sortMetaAppsByPendingRemoval,
  type NamedMetaApp,
} from './meta-apps.ts';

function app(overrides: Partial<NamedMetaApp> & { label: string }): NamedMetaApp {
  return {
    id: `id-${overrides.label}`,
    app_id: '1571488531125130',
    active: true,
    instagram_slot_limit: 100,
    instagram_profile_count: 0,
    transferred_out_count: 0,
    pending_slot_release_count: 0,
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

test('a ordem alfabética do select do Bulk Meta ignora vaga e lê número como número', () => {
  const ordered = sortMetaAppsByLabel([
    app({ label: 'BIEL 10-IG', instagram_profile_count: 0 }),
    app({ label: 'duskingapp', instagram_profile_count: 98 }),
    app({ label: 'BIEL 2-IG', instagram_profile_count: 100 }),
    app({ label: 'Chrys', instagram_profile_count: 0, active: false }),
  ]);

  assert.deepEqual(ordered.map((item) => item.label), ['BIEL 2-IG', 'BIEL 10-IG', 'Chrys', 'duskingapp']);
});

test('queda ainda não confirmada continua ocupando a vaga do app', () => {
  // O caso medido em 05/09/2026: a tela mostrava 13 vagas livres em "BIEL 1",
  // e as 13 estavam ocupadas por conexões que o Athena tinha desistido mas o
  // painel da Meta ainda guardava.
  const capacity = metaAppCapacity(app({
    label: 'BIEL 04-09 1-IG',
    instagram_profile_count: 87,
    pending_slot_release_count: 13,
  }));

  assert.equal(capacity.activeProfiles, 87);
  assert.equal(capacity.trappedSlots, 13);
  assert.equal(capacity.usedSlots, 100);
  assert.equal(capacity.freeSlots, 0);
  assert.equal(capacity.connectable, false);
});

test('ocupação acima do limite aparece inteira, mas a vaga livre para em zero', () => {
  const capacity = metaAppCapacity(app({
    label: 'estourado',
    instagram_profile_count: 96,
    pending_slot_release_count: 13,
  }));

  assert.equal(capacity.usedSlots, 109);
  assert.equal(capacity.freeSlots, 0);
});

test('o Bulk Meta recusa a lista quando a vaga está presa, e diz onde destravar', () => {
  const cheio = app({ label: 'Igor Lote 1', instagram_profile_count: 73, pending_slot_release_count: 27 });
  const plan = buildBulkMetaRows(cheio, 10);

  assert.equal(plan.blocked, true);
  assert.equal(plan.reason, 'app_full');
  assert.equal(plan.rows.length, 0);
  assert.equal(plan.trappedSlots, 27);

  const message = metaBulkPlanMessage(plan, cheio.label);
  assert.match(message, /27 vaga\(s\) estão presas/);
  assert.match(message, /Meta Developers/);
  // "Cadastre outro app" some quando o espaço já existe: ele só precisa ser
  // liberado. Mandar criar app novo aqui seria o conselho errado.
  assert.doesNotMatch(message, /Cadastre outro app/);
});

test('app sem queda pendente mantém a mensagem antiga de app cheio', () => {
  const cheio = app({ label: 'lotado de verdade', instagram_profile_count: 100 });
  const message = metaBulkPlanMessage(buildBulkMetaRows(cheio, 5), cheio.label);

  assert.match(message, /Cadastre outro app da Meta/);
  assert.doesNotMatch(message, /presas/);
});

test('a ordem de preenchimento leva em conta a vaga presa', () => {
  // "quase cheio" tem menos vaga REAL que "meio vazio" mesmo tendo menos
  // perfis vivos; é ele que deve ser oferecido primeiro para fechar um app
  // por vez, em vez de espalhar contas.
  const ordered = sortMetaAppsByFillOrder([
    app({ label: 'meio vazio', instagram_profile_count: 50 }),
    app({ label: 'quase cheio', instagram_profile_count: 40, pending_slot_release_count: 55 }),
  ]);

  assert.deepEqual(ordered.map((item) => item.label), ['quase cheio', 'meio vazio']);
});

test('a tela de controle sobe quem tem conta caída e mantém A-Z nos dois blocos', () => {
  const ordered = sortMetaAppsByPendingRemoval([
    app({ label: 'Zeca', instagram_profile_count: 10 }),
    app({ label: 'Bruna', instagram_profile_count: 10, pending_slot_release_count: 19 }),
    app({ label: 'Ana', instagram_profile_count: 10 }),
    app({ label: 'Yuna', instagram_profile_count: 10, pending_slot_release_count: 1 }),
  ]);

  assert.deepEqual(ordered.map((item) => item.label), ['Bruna', 'Yuna', 'Ana', 'Zeca']);
});

test('o bloco de cima ignora o volume: 63 e 1 são a mesma situação', () => {
  // Ordenar por quantidade quebraria o alfabeto, que é o que torna 28 apps
  // percorríveis quando a limpeza acontece em várias sessões.
  const ordered = sortMetaAppsByPendingRemoval([
    app({ label: 'Tia Lau', pending_slot_release_count: 1 }),
    app({ label: 'PeachySara', pending_slot_release_count: 63 }),
  ]);

  assert.deepEqual(ordered.map((item) => item.label), ['PeachySara', 'Tia Lau']);
});

test('a ordem alfabética é numérica: BIEL 2 antes de BIEL 10', () => {
  const ordered = sortMetaAppsByPendingRemoval([
    app({ label: 'BIEL 10', pending_slot_release_count: 3 }),
    app({ label: 'BIEL 2', pending_slot_release_count: 3 }),
  ]);

  assert.deepEqual(ordered.map((item) => item.label), ['BIEL 2', 'BIEL 10']);
});

test('vaga presa zerada devolve o app para o bloco de baixo', () => {
  // É o que acontece assim que a limpeza é confirmada: o app sai da fila de
  // trabalho na hora, sem esperar recarregar a página.
  const ordered = sortMetaAppsByPendingRemoval([
    app({ label: 'Zeca', pending_slot_release_count: 0 }),
    app({ label: 'Ana', pending_slot_release_count: 0 }),
  ]);

  assert.deepEqual(ordered.map((item) => item.label), ['Ana', 'Zeca']);
});

test('a ordem de preenchimento do Bulk Meta não mudou', () => {
  // Duas perguntas diferentes: aqui é "onde conecto o próximo celular", e a
  // resposta continua sendo o app de menos vaga livre — não o alfabeto.
  const ordered = sortMetaAppsByFillOrder([
    app({ label: 'Ana', instagram_profile_count: 10 }),
    app({ label: 'Zeca', instagram_profile_count: 95 }),
  ]);

  assert.deepEqual(ordered.map((item) => item.label), ['Zeca', 'Ana']);
});

test('perfil movido para outro app continua ocupando vaga no app de origem', () => {
  // A conta sai da contagem do Athena na hora, mas a conexão continua no painel
  // da Meta: ela só some de lá quando alguém apagar. Contar a vaga como livre
  // mandaria celular para um app que não tem espaço — o mesmo estrago que a
  // migration 389 corrigiu para a queda por checkpoint.
  const capacidade = metaAppCapacity(app({
    label: 'origem',
    instagram_slot_limit: 100,
    instagram_profile_count: 90,
    transferred_out_count: 10,
  }));

  assert.equal(capacidade.activeProfiles, 90);
  assert.equal(capacidade.trappedSlots, 10);
  assert.equal(capacidade.usedSlots, 100);
  assert.equal(capacidade.freeSlots, 0);
});

test('queda e transferência somam na mesma vaga presa', () => {
  const capacidade = metaAppCapacity(app({
    label: 'misto',
    instagram_slot_limit: 100,
    instagram_profile_count: 80,
    pending_slot_release_count: 7,
    transferred_out_count: 6,
  }));

  assert.equal(capacidade.trappedSlots, 13);
  // 80 publicando + 13 presas = 93 das 100. Sem somar a transferência, a tela
  // ofereceria 13 vagas onde existem 7.
  assert.equal(capacidade.usedSlots, 93);
  assert.equal(capacidade.freeSlots, 7);
});

test('app com API bloqueada não recebe conexão, mesmo vazio', () => {
  // O caso perigoso é justamente o app vazio: ele tem cem vagas livres e é o
  // pior destino possível, porque a conta entraria e não publicaria enquanto o
  // bloqueio durasse.
  const bloqueado = app({
    label: 'bloqueado',
    instagram_profile_count: 0,
    api_block_until: new Date(Date.now() + 30 * 60_000).toISOString(),
  });

  assert.equal(metaAppCapacity(bloqueado).apiBlocked, true);
  assert.equal(metaAppCapacity(bloqueado).connectable, false);
  assert.equal(buildBulkMetaRows(bloqueado, 5).reason, 'api_blocked');
  assert.equal(buildBulkMetaRows(bloqueado, 5).rows.length, 0);
});

test('janela vencida deixa de bloquear sem ninguém limpar nada', () => {
  // É isto que dispensa a sonda de desbloqueio: a pergunta é feita ao relógio.
  const expirado = app({
    label: 'expirado',
    api_block_until: new Date(Date.now() - 60_000).toISOString(),
  });

  assert.equal(metaAppCapacity(expirado).apiBlocked, false);
  assert.equal(metaAppCapacity(expirado).connectable, true);
  assert.equal(buildBulkMetaRows(expirado, 5).rows.length, 5);
});

test('linha colada apontando para app bloqueado não vira link de conexão', () => {
  // Sem isto a tela montaria o link e só o servidor recusaria — depois de a
  // pessoa já ter clicado e autorizado no Instagram.
  const bloqueado = app({
    label: 'Lari Lote 1 / 04-09-IG',
    api_block_until: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  const resolvido = resolveMetaBulkTarget([bloqueado], [], 'Lari Lote 1 / 04-09-IG');

  assert.equal(resolvido.appStatus, 'api_blocked');
  assert.equal(resolvido.valid, false);
});

test('app saudável com o mesmo nome de lote segue conectável', () => {
  const saudavel = app({ label: 'Lari Lote 1 / 05-09-IG' });
  const resolvido = resolveMetaBulkTarget([saudavel], [], 'Lari Lote 1 / 05-09-IG');

  assert.equal(resolvido.appStatus, 'found');
  assert.equal(resolvido.valid, true);
});
