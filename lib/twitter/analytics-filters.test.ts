import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { filterTwitterAnalyticsResources } from './analytics-filters.ts';

const resources = [
  {
    id: 'post-a',
    profileId: 'profile-a',
    resourceType: 'post' as const,
    occurredAt: '2026-08-23T02:30:00.000Z',
  },
  {
    id: 'post-b',
    profileId: 'profile-b',
    resourceType: 'post' as const,
    occurredAt: '2026-08-23T03:30:00.000Z',
  },
  { id: 'profile-a', profileId: 'profile-a', resourceType: 'profile' as const },
  { id: 'profile-b', profileId: 'profile-b', resourceType: 'profile' as const },
];
const groups = [{ id: 'group-a', profileIds: ['profile-a'] }];

test('filtros combinam perfil, grupo e tipo de métrica', () => {
  const result = filterTwitterAnalyticsResources(resources, groups, {
    profileId: 'profile-a',
    groupId: 'group-a',
    fromDate: '',
    toDate: '',
    metricType: 'post',
  });

  assert.deepEqual(
    result.map((resource) => resource.id),
    ['post-a'],
  );
});

test('período usa a data civil de São Paulo e não UTC', () => {
  const result = filterTwitterAnalyticsResources(resources, groups, {
    profileId: '',
    groupId: '',
    fromDate: '2026-08-22',
    toDate: '2026-08-22',
    metricType: 'post',
  });

  assert.deepEqual(
    result.map((resource) => resource.id),
    ['post-a'],
  );
});

test('período de posts não oculta leitura de perfil quando tipo é todos', () => {
  const result = filterTwitterAnalyticsResources(resources, groups, {
    profileId: '',
    groupId: '',
    fromDate: '2026-08-22',
    toDate: '2026-08-22',
    metricType: 'all',
  });

  assert.deepEqual(
    result.map((resource) => resource.id),
    ['post-a', 'profile-a', 'profile-b'],
  );
});

test('tela escalável carrega conexões, grupos e não chama o provedor diretamente', async () => {
  const [page, client, resourcesRoute] = await Promise.all([
    readFile(
      new URL('../../app/(painel)/x/analises/page.tsx', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../../app/x/twitter-analytics-client.tsx', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../../app/api/x/analytics/resources/route.ts', import.meta.url),
      'utf8',
    ),
  ]);

  assert.match(page, /twitter_groups/);
  assert.match(page, /twitter_group_members/);
  assert.match(page, /twitter_connections/);
  assert.match(page, /analytics_enabled/);
  assert.match(page, /can_fetch_analytics/);
  assert.match(page, /twitter_profile_follower_daily_metrics/);
  assert.doesNotMatch(page, /twitter_publication_items/);
  assert.match(client, /Buscar Zernio ou @perfil/);
  assert.match(client, /Pendências de ontem/);
  assert.match(client, /Forçar nova coleta/);
  assert.match(client, /version: 2/);
  assert.match(client, /targets/);
  assert.match(client, /\/api\/x\/analytics\/resources/);
  assert.match(resourcesRoute, /twitter_publication_items/);
  assert.match(resourcesRoute, /twitter_post_analytics_current/);
  assert.match(resourcesRoute, /nextCursor/);
  assert.doesNotMatch(client, /zernio\.com|\/v1\//);
});
