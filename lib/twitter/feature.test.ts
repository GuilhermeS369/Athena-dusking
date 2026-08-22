import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

import { isTwitterAnalyticsEnabled, isTwitterModuleEnabled } from './feature.ts';

test('módulo fica desligado por padrão e aceita canário explícito', () => {
  assert.equal(isTwitterModuleEnabled('org-a', {}), false);
  assert.equal(isTwitterModuleEnabled('org-a', {
    TWITTER_MODULE_ENABLED: 'false',
    TWITTER_CANARY_ORGANIZATION_IDS: 'org-b,org-a',
  }), true);
});

test('analytics exige flag e organização canário ao mesmo tempo', () => {
  assert.equal(isTwitterAnalyticsEnabled('org-a', {
    TWITTER_ANALYTICS_ENABLED: 'true',
    TWITTER_CANARY_ORGANIZATION_IDS: 'org-a',
  }), true);
  assert.equal(isTwitterAnalyticsEnabled('org-b', {
    TWITTER_ANALYTICS_ENABLED: 'true',
    TWITTER_CANARY_ORGANIZATION_IDS: 'org-a',
  }), false);
  assert.equal(isTwitterAnalyticsEnabled('org-b', {
    TWITTER_MODULE_ENABLED: 'true',
    TWITTER_ANALYTICS_ENABLED: 'true',
    TWITTER_CANARY_ORGANIZATION_IDS: 'org-a',
  }), true);
});

async function routeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? routeFiles(join(directory, entry.name)) : Promise.resolve(entry.name === 'route.ts' ? [join(directory, entry.name)] : [])));
  return nested.flat();
}

test('todas as APIs públicas X exigem contexto canário, exceto webhook assinado', async () => {
  const apiDirectory = fileURLToPath(new URL('../../app/api/x/', import.meta.url));
  const routes = await routeFiles(apiDirectory);
  for (const route of routes) {
    const source = await readFile(route, 'utf8');
    if (route.endsWith(join('zernio', 'webhook', 'route.ts'))) {
      assert.match(source, /verifyTwitterZernioWebhook/, route);
    } else {
      assert.match(source, /getTwitterRequestContext/, route);
    }
  }
});

test('páginas X e operações pagas de analytics reaplicam os gates por organização', async () => {
  const [layout, page, quote, confirm, context] = await Promise.all([
    readFile(new URL('../../app/(painel)/x/layout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/(painel)/x/analises/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/x/analytics/quote/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/x/analytics/confirm/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('./request-context.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(layout, /isTwitterModuleEnabled/);
  assert.match(layout, /notFound\(\)/);
  assert.match(context, /isTwitterModuleEnabled/);
  assert.match(page, /isTwitterAnalyticsEnabled/);
  assert.match(quote, /isTwitterAnalyticsEnabled/);
  assert.match(confirm, /isTwitterAnalyticsEnabled/);
});
