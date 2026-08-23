import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Dashboard X respeita rollout e lê somente snapshots locais',async()=>{
  const[page,client,route]=await Promise.all([
    readFile(new URL('../../app/(painel)/page.tsx',import.meta.url),'utf8'),
    readFile(new URL('../../app/dashboard-client.tsx',import.meta.url),'utf8'),
    readFile(new URL('../../app/api/x/analytics/snapshots/route.ts',import.meta.url),'utf8'),
  ]);
  assert.match(page,/isTwitterModuleEnabled/);
  assert.match(client,/twitterEnabled\?<option value="twitter"/);
  assert.match(client,/selectedPlatform==='instagram'/);
  assert.match(client,/Abrir Análises X/);
  assert.match(route,/twitter_analytics_snapshots/);
  assert.match(route,/twitter_analytics_jobs/);
  assert.match(route,/snapshots\.error\|\|jobs\.error/);
  assert.doesNotMatch(`${client}\n${route}`,/\/v1\/analytics|zernio\.com|ZERNIO_API/);
});
