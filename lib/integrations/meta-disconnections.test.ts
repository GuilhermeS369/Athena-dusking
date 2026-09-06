import assert from 'node:assert/strict';
import test from 'node:test';

import {
  groupPendingDisconnectionsByApp,
  orphanPendingDisconnections,
  orphanedUsernameList,
  describeDisconnection,
  pendingDisconnectionsByAppId,
  pendingUsernameList,
  selectIncident,
  selectionSummary,
  type MetaPendingDisconnection,
} from './meta-disconnections.ts';

function incident(
  overrides: Partial<MetaPendingDisconnection> & { username_snapshot: string },
): MetaPendingDisconnection {
  return {
    id: `inc-${overrides.username_snapshot}`,
    profile_id: `pro-${overrides.username_snapshot}`,
    meta_app_id: 'app-1',
    meta_app_label_snapshot: 'BIEL 04-09 1-IG',
    error_code: '190',
    error_message: 'Error validating access token: You cannot access the app till you log in to www.instagram.com',
    signal: 'checkpoint_required',
    detected_at: '2026-09-05T14:08:38.038599+00:00',
    ...overrides,
  };
}

test('a fila sai da queda mais recente para a mais antiga', () => {
  const grupos = groupPendingDisconnectionsByApp([
    incident({ username_snapshot: 'ana', detected_at: '2026-09-05T10:00:00+00:00' }),
    incident({ username_snapshot: 'zeca', detected_at: '2026-09-05T14:00:00+00:00' }),
    incident({ username_snapshot: 'bruno', detected_at: '2026-08-16T11:25:59+00:00' }),
  ]);

  assert.equal(grupos.length, 1);
  assert.deepEqual(grupos[0].incidents.map((item) => item.username_snapshot), ['zeca', 'ana', 'bruno']);
});

test('quedas do mesmo instante mantêm ordem estável', () => {
  // Uma leva inteira compartilha o segundo: 493 quedas num dia só. Sem
  // desempate por id, a lista trocaria de ordem entre um render e outro,
  // justamente enquanto alguém a percorre linha por linha.
  const mesmoInstante = '2026-09-05T14:08:38.038599+00:00';
  const primeiro = incident({ username_snapshot: 'zeca', id: 'inc-a', detected_at: mesmoInstante });
  const segundo = incident({ username_snapshot: 'ana', id: 'inc-b', detected_at: mesmoInstante });
  const ordem = (entrada: MetaPendingDisconnection[]) =>
    groupPendingDisconnectionsByApp(entrada)[0].incidents.map((item) => item.id);

  assert.deepEqual(ordem([primeiro, segundo]), ['inc-a', 'inc-b']);
  assert.deepEqual(ordem([segundo, primeiro]), ['inc-a', 'inc-b']);
});

test('a fração de segundo separa duas quedas do mesmo segundo', () => {
  // A comparação é lexicográfica sobre o timestamptz do Postgres; se ela
  // parasse no segundo, duas quedas consecutivas cairiam no desempate por id
  // e apareceriam fora de ordem.
  const grupos = groupPendingDisconnectionsByApp([
    incident({ username_snapshot: 'antes', id: 'inc-z', detected_at: '2026-09-05T14:08:38.038599+00:00' }),
    incident({ username_snapshot: 'depois', id: 'inc-a', detected_at: '2026-09-05T14:08:38.116071+00:00' }),
  ]);

  assert.deepEqual(grupos[0].incidents.map((item) => item.username_snapshot), ['depois', 'antes']);
});

test('o balde sem app fica por último: ele não tem cartão onde morar', () => {
  const grupos = groupPendingDisconnectionsByApp([
    incident({ username_snapshot: 'legado', meta_app_id: null, meta_app_label_snapshot: null }),
    incident({ username_snapshot: 'atual', meta_app_id: 'app-1' }),
  ]);

  assert.deepEqual(grupos.map((grupo) => grupo.metaAppId), ['app-1', null]);
});

test('o rótulo do grupo sobrevive a um app já descadastrado', () => {
  const grupos = groupPendingDisconnectionsByApp([
    incident({ username_snapshot: 'sem-rotulo', meta_app_label_snapshot: null }),
    incident({ username_snapshot: 'com-rotulo', meta_app_label_snapshot: 'LAURINHA 04-09 1-IG' }),
  ]);

  assert.equal(grupos[0].appLabelSnapshot, 'LAURINHA 04-09 1-IG');
});

test('queda de app descadastrado não some da tela: cai no balde dos órfãos', () => {
  // O pior desfecho seria sumir — é justamente a vaga que ninguém vai liberar,
  // porque ninguém sabe que ela existe.
  const orfaos = orphanPendingDisconnections([
    incident({ username_snapshot: 'no-app-vivo', meta_app_id: 'app-1' }),
    incident({
      username_snapshot: 'credencial-global',
      meta_app_id: null,
      detected_at: '2026-08-16T11:25:59+00:00',
    }),
    incident({
      username_snapshot: 'app-descadastrado',
      meta_app_id: 'app-sumido',
      detected_at: '2026-09-05T14:00:00+00:00',
    }),
  ], new Set(['app-1']));

  // O balde também respeita a ordem da tela: queda mais recente primeiro.
  assert.deepEqual(
    orfaos.map((item) => item.username_snapshot),
    ['app-descadastrado', 'credencial-global'],
  );
});

test('o índice por app entrega a fila pronta para o cartão', () => {
  const indice = pendingDisconnectionsByAppId([
    incident({ username_snapshot: 'um', meta_app_id: 'app-1' }),
    incident({ username_snapshot: 'dois', meta_app_id: 'app-2' }),
    incident({ username_snapshot: 'tres', meta_app_id: 'app-1' }),
  ]);

  assert.equal(indice.get('app-1')?.length, 2);
  assert.equal(indice.get('app-2')?.length, 1);
  assert.equal(indice.get('app-3'), undefined);
});

test('o texto copiado sai sem arroba: a busca do Meta Developers quer o nome puro', () => {
  const texto = pendingUsernameList([
    incident({ username_snapshot: 'ana' }),
    incident({ username_snapshot: 'bruno' }),
  ]);

  assert.equal(texto, 'ana\nbruno');
  assert.doesNotMatch(texto, /@/);
});

test('a seleção sabe distinguir vazia, parcial e completa', () => {
  const fila = [
    incident({ username_snapshot: 'ana' }),
    incident({ username_snapshot: 'bruno' }),
  ];

  const vazia = selectionSummary(fila, new Set());
  assert.equal(vazia.allSelected, false);
  assert.equal(vazia.partiallySelected, false);

  const parcial = selectionSummary(fila, new Set(['inc-ana']));
  assert.equal(parcial.selectedCount, 1);
  assert.equal(parcial.allSelected, false);
  assert.equal(parcial.partiallySelected, true);

  const cheia = selectionSummary(fila, new Set(['inc-ana', 'inc-bruno']));
  assert.equal(cheia.allSelected, true);
  assert.equal(cheia.partiallySelected, false);
});

test('marcação de outro app não conta como seleção desta fila', () => {
  // O estado de seleção é global (uma tela, vários cartões abertos). Sem este
  // recorte, o botão de um app mostraria o número marcado no vizinho.
  const fila = [incident({ username_snapshot: 'ana' })];
  const resumo = selectionSummary(fila, new Set(['inc-de-outro-app']));

  assert.equal(resumo.selectedCount, 0);
  assert.equal(resumo.allSelected, false);
});

test('fila vazia não é "tudo selecionado"', () => {
  const resumo = selectionSummary([], new Set());

  assert.equal(resumo.allSelected, false);
  assert.equal(resumo.partiallySelected, false);
});

test('clicar no nome marca a linha', () => {
  const marcado = selectIncident(new Set(), 'inc-ana');

  assert.equal(marcado.has('inc-ana'), true);
  assert.equal(marcado.size, 1);
});

test('clicar de novo para recopiar NÃO desmarca', () => {
  // O clique não alterna de propósito: perder o nome no meio do caminho e
  // voltar para copiar outra vez é comum, e desfazer o trabalho nesse momento
  // seria o pior desfecho. Quem desmarca é o checkbox.
  const uma = selectIncident(new Set(), 'inc-ana');
  const duas = selectIncident(uma, 'inc-ana');

  assert.equal(duas.has('inc-ana'), true);
  assert.equal(duas.size, 1);
});

test('marcar de novo devolve o mesmo conjunto, sem render à toa', () => {
  const uma = selectIncident(new Set(), 'inc-ana');

  assert.equal(selectIncident(uma, 'inc-ana'), uma);
});

test('marcar uma linha preserva as outras já marcadas', () => {
  const antes = new Set(['inc-bruno']);
  const depois = selectIncident(antes, 'inc-ana');

  assert.deepEqual([...depois].sort(), ['inc-ana', 'inc-bruno']);
  // O conjunto original não é mutado: o React compara por referência.
  assert.deepEqual([...antes], ['inc-bruno']);
});

test('queda mostra o código do erro; remoção pedida não inventa erro nenhum', () => {
  const queda = describeDisconnection(incident({ username_snapshot: 'caiu' }));
  assert.equal(queda.verb, 'caiu');
  assert.equal(queda.badge, 'erro 190');
  assert.equal(queda.isFall, true);

  const removido = describeDisconnection(incident({
    username_snapshot: 'removido',
    signal: 'operator_requested',
    error_code: null,
    error_message: null,
  }));
  assert.equal(removido.verb, 'removido');
  assert.equal(removido.badge, 'removido');
  assert.equal(removido.isFall, false);
});

test('queda sem código legível ainda se descreve como queda', () => {
  // O código é opcional no banco desde a migration 391. Uma queda sem ele não
  // pode virar "erro undefined" na tela nem se disfarçar de remoção pedida.
  for (const vazio of [null, '', '   ']) {
    const semCodigo = describeDisconnection(incident({ username_snapshot: 'x', error_code: vazio }));
    assert.equal(semCodigo.badge, 'queda');
    assert.equal(semCodigo.verb, 'caiu');
    assert.equal(semCodigo.isFall, true);
  }
});

test('remoção pedida ignora um código de erro que tenha sobrado na linha', () => {
  // Defesa contra dado sujo: o sinal é a fonte da verdade, não a presença do
  // campo. Uma linha marcada como remoção não pode ser exibida como queda só
  // porque alguém preencheu error_code.
  const removido = describeDisconnection(incident({
    username_snapshot: 'x',
    signal: 'operator_requested',
    error_code: '190',
  }));

  assert.equal(removido.badge, 'removido');
  assert.equal(removido.isFall, false);
});

test('quedas órfãs saem agrupadas pelo app de origem', () => {
  // Quem percorre esta lista está com o Meta Developers aberto e resolve um app
  // por vez. Ordenar por data espalharia as 63 da PeachySara no meio das 44 da
  // Lari, e a pessoa teria de pular linha a linha.
  const ordenadas = orphanPendingDisconnections([
    incident({ username_snapshot: 'a', meta_app_label_snapshot: 'Lari Lote 2', detected_at: '2026-09-05T10:00:00Z' }),
    incident({ username_snapshot: 'b', meta_app_label_snapshot: 'PeachySara Lote 1', detected_at: '2026-09-05T12:00:00Z' }),
    incident({ username_snapshot: 'c', meta_app_label_snapshot: 'Lari Lote 2', detected_at: '2026-09-05T14:00:00Z' }),
    incident({ username_snapshot: 'd', meta_app_label_snapshot: 'PeachySara Lote 1', detected_at: '2026-09-05T09:00:00Z' }),
  ], new Set());

  // Blocos por app, e dentro de cada bloco a queda mais recente primeiro.
  assert.deepEqual(ordenadas.map((i) => i.username_snapshot), ['c', 'a', 'b', 'd']);
});

test('queda sem rótulo de app vai para o fim', () => {
  // Não há app para abrir: deixá-la no meio interrompe a leitura de um bloco.
  const ordenadas = orphanPendingDisconnections([
    incident({ username_snapshot: 'sem', meta_app_label_snapshot: null, detected_at: '2026-09-05T23:00:00Z' }),
    incident({ username_snapshot: 'com', meta_app_label_snapshot: 'Zulu Lote 9', detected_at: '2026-09-05T01:00:00Z' }),
  ], new Set());

  assert.deepEqual(ordenadas.map((i) => i.username_snapshot), ['com', 'sem']);
});

test('lista de nomes dos órfãos sai sem arroba, um por linha', () => {
  // Mesmo destino da lista de quedas: a busca do painel da Meta e o campo de
  // conexão. A arroba fica na tela e nunca no clipboard.
  const texto = orphanedUsernameList([
    { username: 'bellalewis15624' },
    { username: 'hazelmiller29242' },
  ]);

  assert.equal(texto, 'bellalewis15624\nhazelmiller29242');
  assert.equal(texto.includes('@'), false);
});
