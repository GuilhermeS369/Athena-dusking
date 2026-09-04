import assert from 'node:assert/strict';
import test from 'node:test';

import { dashboardCoverageNotes, type DashboardCoverageSummary } from './coverage-notes.ts';

function coverage(overrides: Partial<DashboardCoverageSummary> = {}): DashboardCoverageSummary {
  return {
    selected_profiles: 1103,
    profiles_with_metrics: 1051,
    partial_profiles: 0,
    first_metric_date: '2026-08-30',
    last_metric_date: '2026-08-30',
    ...overrides,
  };
}

test('perfil que publicou e está sem métrica é o único alarme da tela', () => {
  // Números reais de 30/08/2026, período "Hoje": 1051 de 1103 com métrica, mas
  // só 10 perfis publicaram sem receber métrica — 42 não publicaram nada.
  const notes = dashboardCoverageNotes({
    coverage: coverage({ profiles_with_publications: 1061, profiles_pending_collection: 10 }),
    periodEndDate: '2026-08-30',
    todayDate: '2026-08-30',
  });

  const alerts = notes.filter((note) => note.tone === 'alert');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /10 perfis publicaram/);
  assert.doesNotMatch(alerts[0].message, /1051|1103/, 'a fração antiga não deve voltar como alarme');
});

test('cobertura sem pendência de coleta não gera alarme nenhum', () => {
  const notes = dashboardCoverageNotes({
    coverage: coverage({ profiles_with_metrics: 1061, profiles_with_publications: 1061, profiles_pending_collection: 0 }),
    periodEndDate: '2026-08-29',
    todayDate: '2026-08-30',
  });
  assert.deepEqual(notes.filter((note) => note.tone === 'alert'), []);
});

test('período que termina hoje avisa que o dado ainda está maturando', () => {
  const notes = dashboardCoverageNotes({
    coverage: coverage({ profiles_with_publications: 1061, profiles_pending_collection: 0 }),
    periodEndDate: '2026-08-30',
    todayDate: '2026-08-30',
  });
  assert.deepEqual(notes.filter((note) => note.tone === 'alert'), []);
  assert.match(notes.map((note) => note.message).join(' '), /sobem ao longo do dia/);
});

test('período fechado sem coleta recente vira alerta, não nota informativa', () => {
  const notes = dashboardCoverageNotes({
    coverage: coverage({ last_metric_date: '2026-08-27', profiles_with_publications: 1061, profiles_pending_collection: 0 }),
    periodEndDate: '2026-08-29',
    todayDate: '2026-08-30',
  });
  const alerts = notes.filter((note) => note.tone === 'alert');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /2026-08-27/);
});

test('perfis sem publicação só aparecem quando explicam um vazio na tela', () => {
  const comVazio = dashboardCoverageNotes({
    coverage: coverage({ profiles_with_publications: 1061, profiles_pending_collection: 0 }),
    periodEndDate: '2026-08-29',
    todayDate: '2026-08-30',
  });
  assert.match(comVazio.map((note) => note.message).join(' '), /42 de 1103 perfis não publicaram/);

  const semVazio = dashboardCoverageNotes({
    coverage: coverage({ profiles_with_metrics: 1103, profiles_with_publications: 1061, profiles_pending_collection: 0 }),
    periodEndDate: '2026-08-29',
    todayDate: '2026-08-30',
  });
  assert.doesNotMatch(semVazio.map((note) => note.message).join(' '), /não publicaram/);
});

test('sem a migração 339 aplicada, o texto antigo continua valendo', () => {
  const notes = dashboardCoverageNotes({
    coverage: coverage(),
    periodEndDate: '2026-08-29',
    todayDate: '2026-08-30',
  });
  assert.match(notes[0].message, /Cobertura parcial: 1051\/1103/);
});

test('singular e plural saem corretos nas duas notas', () => {
  const notes = dashboardCoverageNotes({
    coverage: coverage({ selected_profiles: 2, profiles_with_metrics: 0, profiles_with_publications: 1, profiles_pending_collection: 1 }),
    periodEndDate: '2026-08-29',
    todayDate: '2026-08-30',
  });
  const texto = notes.map((note) => note.message).join(' ');
  assert.match(texto, /1 perfil publicou neste período e ainda está sem métrica/);
  assert.match(texto, /1 de 2 perfil não publicou/);
});

test('a dashboard diz quantos perfis realmente publicam, sem esconder o historico', () => {
  // 04/09/2026: a migracao da Zernio para a Meta deixou a frota dividida. Somar
  // o historico dos dois grupos num numero so fazia a tela sugerir uma operacao
  // inteira em pe, quando a maioria nao publicava.
  const notes = dashboardCoverageNotes({
    coverage: coverage(),
    periodEndDate: '2026-09-03',
    todayDate: '2026-09-04',
    profiles: [
      ...Array.from({ length: 120 }, () => ({ status: 'online' })),
      ...Array.from({ length: 1445 }, () => ({ status: 'reauthorization_required' })),
    ],
  });

  const capacidade = notes.find((note) => note.message.includes('online'));
  assert.ok(capacidade, 'deveria existir um aviso de capacidade');
  assert.equal(capacidade.tone, 'alert');
  assert.match(capacidade.message, /120 de 1565/);
  assert.match(capacidade.message, /1445 aguardam reconexão pela API da Meta/);
  // O historico continua somando: o aviso explica, nao filtra.
  assert.match(capacidade.message, /continua somando/);
});

test('frota inteira online nao gera aviso de capacidade', () => {
  const notes = dashboardCoverageNotes({
    coverage: coverage(),
    periodEndDate: '2026-09-03',
    todayDate: '2026-09-04',
    profiles: Array.from({ length: 40 }, () => ({ status: 'online' })),
  });

  assert.equal(notes.some((note) => note.message.includes('aguardam reconexão')), false);
});

test('sem a lista de perfis os avisos antigos seguem intactos', () => {
  const semLista = dashboardCoverageNotes({ coverage: coverage(), periodEndDate: '2026-09-03', todayDate: '2026-09-04' });
  const listaVazia = dashboardCoverageNotes({ coverage: coverage(), periodEndDate: '2026-09-03', todayDate: '2026-09-04', profiles: [] });

  assert.deepEqual(semLista, listaVazia);
  assert.equal(semLista.some((note) => note.message.includes('aguardam reconexão')), false);
});
