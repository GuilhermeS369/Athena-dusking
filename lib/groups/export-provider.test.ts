import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { filterExportRowsByProvider, parseGroupExportProvider } from './export-provider.ts';

const groupExport = readFileSync('app/api/groups/[groupId]/export/route.ts', 'utf8');
const allExport = readFileSync('app/api/groups/export-all/route.ts', 'utf8');
const groupsClient = readFileSync('app/grupos/groups-client.tsx', 'utf8');
const groupsPage = readFileSync('app/(painel)/grupos/page.tsx', 'utf8');

const rows = [
  { profile_id: 'meta-1', row_kind: 'current' },
  { profile_id: 'zernio-1', row_kind: 'current' },
  { profile_id: 'zernio-1', row_kind: 'fallen' },
  { profile_id: 'desconhecido', row_kind: 'fallen' },
];
const zernioIds = new Set(['zernio-1', 'zernio-sem-grupo']);

test('sem parâmetro a rota não recorta; valor desconhecido é erro, não "tudo"', () => {
  assert.deepEqual(parseGroupExportProvider(null), { ok: true, provider: null });
  assert.deepEqual(parseGroupExportProvider(''), { ok: true, provider: null });
  assert.deepEqual(parseGroupExportProvider('meta_official'), { ok: true, provider: 'meta_official' });
  assert.deepEqual(parseGroupExportProvider('zernio'), { ok: true, provider: 'zernio' });
  assert.deepEqual(parseGroupExportProvider('Zernio'), { ok: false });
  assert.deepEqual(parseGroupExportProvider('meta'), { ok: false });
});

test('provider=zernio traz só as linhas de perfis Zernio, atuais e caídas', () => {
  assert.deepEqual(filterExportRowsByProvider(rows, 'zernio', zernioIds), [rows[1], rows[2]]);
});

test('provider=meta_official traz o resto, inclusive perfil que a leitura de provedores não viu', () => {
  assert.deepEqual(filterExportRowsByProvider(rows, 'meta_official', zernioIds), [rows[0], rows[3]]);
});

test('os dois recortes são uma partição: nenhuma linha some nem aparece duas vezes', () => {
  const meta = filterExportRowsByProvider(rows, 'meta_official', zernioIds);
  const zernio = filterExportRowsByProvider(rows, 'zernio', zernioIds);
  assert.equal(meta.length + zernio.length, rows.length);
  assert.equal(meta.filter((row) => zernio.includes(row)).length, 0);
  assert.equal(filterExportRowsByProvider(rows, null, zernioIds), rows);
});

test('as duas rotas recortam pelo mesmo parâmetro e leem os ids Zernio paginando por id', () => {
  for (const route of [groupExport, allExport]) {
    assert.match(route, /parseGroupExportProvider\(new URL\(request\.url\)\.searchParams\.get\('provider'\)\)/);
    assert.match(route, /status: 400/);
    assert.match(route, /\.from\('instagram_profiles_safe'\)\s+\.select\('id'\)\s+\.eq\('organization_id', organizationId\)\s+\.eq\('provider', 'zernio'\)\s+\.order\('id', \{ ascending: true \}\)\s+\.range\(from, to\)/);
    assert.match(route, /filterExportRowsByProvider\(data, providerParam\.provider, zernioProfileIds\)/);
    assert.doesNotMatch(route, /rows: data/);
  }
});

test('a tela pede Meta na exportação normal e Zernio na seção Zernio', () => {
  assert.match(groupsPage, /select\('id, username, display_name, profile_picture_url, status, provider'\)/);
  assert.match(groupsClient, /\/api\/groups\/\$\{group\.id\}\/export\?provider=\$\{provider\}/);
  assert.match(groupsClient, /\/api\/groups\/export-all\?provider=\$\{provider\}/);
  assert.match(groupsClient, /onClick=\{\(\) => exportAllGroups\('meta_official'\)\}/);
  assert.match(groupsClient, /onClick=\{\(\) => exportAllGroups\('zernio'\)\}/);
  assert.match(groupsClient, /onClick=\{\(\) => exportGroup\(group, 'meta_official'\)\}/);
  assert.match(groupsClient, /onClick=\{\(\) => exportGroup\(zernioModalGroup, 'zernio'\)\}/);
  // Nenhuma chamada de exportação ficou sem recorte.
  assert.doesNotMatch(groupsClient, /fetch\('\/api\/groups\/export-all'\)/);
});
