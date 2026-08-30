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
