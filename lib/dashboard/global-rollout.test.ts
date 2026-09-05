import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { isDashboardV2Enabled } from './rollout.ts';

test('rollout global V2 respeita ativação, allowlist e kill switch', () => {
  assert.equal(isDashboardV2Enabled('org-a', {
    DASHBOARD_V2_ENABLED: 'true',
    DASHBOARD_V2_KILL_SWITCH: 'false',
    DASHBOARD_V2_ORGANIZATION_IDS: '',
  }), true);
  assert.equal(isDashboardV2Enabled('org-a', {
    DASHBOARD_V2_ENABLED: 'false',
    DASHBOARD_V2_KILL_SWITCH: 'false',
    DASHBOARD_V2_ORGANIZATION_IDS: 'org-a, org-b',
  }), true);
  assert.equal(isDashboardV2Enabled('org-a', {
    DASHBOARD_V2_ENABLED: 'true',
    DASHBOARD_V2_KILL_SWITCH: 'true',
    DASHBOARD_V2_ORGANIZATION_IDS: 'org-a',
  }), false);
});

test('dashboard V2 e refresh manual não reutilizam resposta analítica obsoleta', async () => {
  const [route, client, server] = await Promise.all([
    readFile(new URL('../../app/api/dashboard/analytics-v2/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../app/dashboard-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./server.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(route, /Cache-Control': 'private, no-store, max-age=0/);
  assert.match(route, /X-Dashboard-Version/);
  assert.match(client, /cache: 'no-store'/);
  // Depois de atualizar, a tela precisa buscar os agregados de novo: sem isto o
  // botão coleta métrica nova e continua mostrando a antiga.
  assert.match(client, /analyticsRevision/);
  assert.match(client, /setAnalyticsRevision\(\(revision\) => revision \+ 1\)/);
  // A pilha de até seis tarjas virou UM ícone com balão no hover (StatusChip).
  // As duas asserções abaixo protegem isso: existe um único ponto que decide a
  // mensagem, e nenhuma faixa de largura inteira voltou para o cabeçalho.
  assert.match(client, /dashboardCoverageStatus/);
  assert.equal(client.split('<StatusChip').length - 1, 1);
  assert.doesNotMatch(client, /analytics-refresh-status|analytics-status-line/);
  assert.match(server, /order\('metric_date', \{ ascending: false \}\)/);
  assert.match(server, /priorize os dias recentes/);
});
