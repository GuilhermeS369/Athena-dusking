import assert from 'node:assert/strict';
import test from 'node:test';

import { dashboardCoverageStatus, type DashboardCoverageSummary } from './coverage-notes.ts';

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
  const status = dashboardCoverageStatus({
    coverage: coverage({ profiles_with_publications: 1061, profiles_pending_collection: 10 }),
    periodEndDate: '2026-08-30',
    todayDate: '2026-08-30',
  });

  assert.equal(status.note?.tone, 'alert');
  assert.match(status.note!.message, /10 perfis publicaram/);
  assert.doesNotMatch(status.note!.message, /1051|1103/, 'a fração antiga não deve voltar como alarme');
});

test('cobertura sem pendência de coleta não gera aviso nenhum', () => {
  const status = dashboardCoverageStatus({
    coverage: coverage({ profiles_with_metrics: 1061, profiles_with_publications: 1061, profiles_pending_collection: 0 }),
    periodEndDate: '2026-08-29',
    todayDate: '2026-08-30',
  });
  assert.equal(status.note, null);
});

test('período que termina hoje não vira aviso: a dica do dia corrente é fixa', () => {
  // Antes isto acendia uma tarja "as métricas de hoje sobem ao longo do dia" em
  // TODA visita ao período padrão — um aviso permanente, que é o mesmo que
  // nenhum aviso, só que ocupando espaço.
  const status = dashboardCoverageStatus({
    coverage: coverage({ profiles_with_publications: 1061, profiles_pending_collection: 0 }),
    periodEndDate: '2026-08-30',
    todayDate: '2026-08-30',
  });
  assert.equal(status.note, null);
});

test('período fechado sem coleta recente vira o único alerta', () => {
  const status = dashboardCoverageStatus({
    coverage: coverage({ last_metric_date: '2026-08-27', profiles_with_publications: 1061, profiles_pending_collection: 0 }),
    periodEndDate: '2026-08-29',
    todayDate: '2026-08-30',
  });
  assert.equal(status.note?.tone, 'alert');
  assert.match(status.note!.message, /2026-08-27/);
});

test('coleta pendente tem precedência sobre coleta parada', () => {
  // Os dois problemas podem coexistir. A tela mostra um: o que se resolve
  // sozinho vem primeiro porque ele explica o outro na maioria das vezes.
  const status = dashboardCoverageStatus({
    coverage: coverage({ last_metric_date: '2026-08-27', profiles_with_publications: 1061, profiles_pending_collection: 4 }),
    periodEndDate: '2026-08-29',
    todayDate: '2026-08-30',
  });
  assert.match(status.note!.message, /4 perfis publicaram/);
});

test('perfis que não publicaram no período deixaram de virar mensagem', () => {
  const status = dashboardCoverageStatus({
    coverage: coverage({ profiles_with_publications: 1061, profiles_pending_collection: 0 }),
    periodEndDate: '2026-08-29',
    todayDate: '2026-08-30',
  });
  assert.equal(status.note, null);
});

test('sem a migração 339 aplicada, a tela cala em vez de mostrar a fração antiga', () => {
  // `profiles_pending_collection` chega indefinido enquanto a 339 não roda. O
  // texto "Cobertura parcial: 1051/1103" que vivia aqui misturava três
  // situações diferentes e não dizia o que fazer com nenhuma delas.
  const status = dashboardCoverageStatus({
    coverage: coverage(),
    periodEndDate: '2026-08-30',
    todayDate: '2026-08-30',
  });
  assert.equal(status.note, null);
});

test('singular sai correto no aviso de coleta pendente', () => {
  const status = dashboardCoverageStatus({
    coverage: coverage({ selected_profiles: 2, profiles_with_metrics: 0, profiles_with_publications: 1, profiles_pending_collection: 1 }),
    periodEndDate: '2026-08-29',
    todayDate: '2026-08-30',
  });
  assert.match(status.note!.message, /1 perfil publicou e ainda está sem métrica/);
});

test('capacidade da frota é número fixo, não aviso', () => {
  // 04/09/2026: a migração da Zernio para a Meta deixou a frota dividida. Isso
  // é permanente enquanto durar a religação, e o que é permanente não pode
  // ocupar a faixa de alertas.
  const status = dashboardCoverageStatus({
    coverage: coverage({ last_metric_date: '2026-09-03', profiles_pending_collection: 0 }),
    periodEndDate: '2026-09-03',
    todayDate: '2026-09-04',
    profiles: [
      ...Array.from({ length: 120 }, () => ({ status: 'online' })),
      ...Array.from({ length: 1445 }, () => ({ status: 'reauthorization_required' })),
    ],
  });

  assert.deepEqual(status.capacity, { online: 120, offline: 1445, total: 1565 });
  assert.equal(status.note, null);
});

test('frota inteira online não produz indicador de capacidade', () => {
  const status = dashboardCoverageStatus({
    coverage: coverage(),
    periodEndDate: '2026-09-03',
    todayDate: '2026-09-04',
    profiles: Array.from({ length: 40 }, () => ({ status: 'online' })),
  });
  assert.equal(status.capacity, null);
});

test('sem a lista de perfis não há indicador de capacidade', () => {
  const semLista = dashboardCoverageStatus({ coverage: coverage(), periodEndDate: '2026-09-03', todayDate: '2026-09-04' });
  const listaVazia = dashboardCoverageStatus({ coverage: coverage(), periodEndDate: '2026-09-03', todayDate: '2026-09-04', profiles: [] });

  assert.deepEqual(semLista, listaVazia);
  assert.equal(semLista.capacity, null);
});
