import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Dashboard X usa projeções locais, filtros e fallback sem consultar a Zernio', async () => {
  const [route, client, css] = await Promise.all([
    readFile(new URL('../../app/api/x/analytics/dashboard/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../app/dashboard-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/x/twitter-dashboard.module.css', import.meta.url), 'utf8'),
  ]);

  assert.match(route, /twitter_profile_follower_daily_metrics/);
  assert.match(route, /twitter_post_analytics_current/);
  assert.match(route, /twitter_analytics_snapshots/);
  assert.match(route, /connectionId/);
  assert.match(route, /profileId/);
  assert.match(route, /groupId/);
  assert.match(route, /start/);
  assert.match(route, /end/);
  assert.match(route, /metric/);
  assert.match(route, /pagination/);
  assert.match(route, /summary/);
  assert.match(route, /coverage/);
  assert.match(route, /followerSeries/);
  assert.match(route, /ranking/);
  assert.match(route, /topPosts/);
  assert.match(route, /Cache-Control': 'private, no-store/);
  assert.doesNotMatch(route, /zernio\.com|ZERNIO_API|\/v1\/analytics|follower-stats|fetch\s*\(/i);

  assert.match(client, /\/api\/x\/analytics\/dashboard/);
  assert.match(client, /TwitterDashboard/);
  assert.match(client, /Dados exclusivamente locais/);
  assert.match(client, /Evolução de seguidores/);
  assert.match(client, /Ranking de perfis/);
  assert.match(client, /Posts com melhor desempenho/);
  assert.doesNotMatch(client, /\/api\/x\/analytics\/snapshots/);
  assert.match(css, /\.kpis/);
  assert.match(css, /@media/);
});

test('Dashboard X preserva o fluxo e endpoint V2 do Instagram', async () => {
  const client = await readFile(new URL('../../app/dashboard-client.tsx', import.meta.url), 'utf8');
  assert.match(client, /\/api\/dashboard\/analytics-v2/);
  assert.match(client, /selectedPlatform !== 'instagram'/);
  // O botão "atualizar" saiu: a coleta acontece em três horários fixos e a tela
  // apenas informa (migration 387). O que este teste protege segue igual — a
  // metade do Instagram não pode ser engolida pela do X.
  assert.match(client, /CollectionIndicator/);
  // O ranking virou `RankingCard` na reconstrução de 05/09/2026 (o seletor de
  // métrica por cartão saiu; agora quem manda é a aba do topo). O que este
  // teste protege continua sendo o mesmo: a metade do Instagram não pode ser
  // engolida pela do X.
  assert.match(client, /RankingCard/);
  assert.match(client, /TopPostsCard/);
  assert.match(client, /DashboardAreaChart/);
});
