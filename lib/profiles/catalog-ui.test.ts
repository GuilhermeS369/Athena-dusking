import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync('app/(painel)/perfis/page.tsx', 'utf8');
const clientSource = readFileSync('app/perfis/profiles-client.tsx', 'utf8');
const apiSource = readFileSync('app/api/profiles/route.ts', 'utf8');
const nextConfigSource = readFileSync('next.config.mjs', 'utf8');

test('bootstrap de perfis usa catálogo paginado sem leituras completas antigas', () => {
  assert.match(pageSource, /getInstagramProfilesCatalogPage/);
  assert.doesNotMatch(pageSource, /get_profiles_analytics_summary/);
  assert.doesNotMatch(pageSource, /from\('profile_group_members'\)/);
  assert.match(clientSource, /initialCatalog/);
  assert.match(clientSource, /\/api\/profiles\?/);
});

test('otimização preserva os fluxos existentes de conexão e Bulk Zernio', () => {
  assert.match(clientSource, /buildBulkZernioRows/);
  assert.match(clientSource, /resolveZernioBulkTarget/);
  assert.match(clientSource, /\/api\/integrations\/zernio\/start\?returnTo=%2Fperfis/);
  assert.match(clientSource, /\/api\/integrations\/meta\/start\?returnTo=%2Fperfis/);
  assert.match(clientSource, /refreshBulkZernioConnections/);
});

test('cards limitados usam miniaturas cacheáveis e navegação por cursor', () => {
  assert.match(clientSource, /from 'next\/image'/);
  assert.match(clientSource, /loading="lazy"/);
  assert.match(clientSource, /sizes="52px"/);
  assert.match(nextConfigSource, /hostname: '\*\*\.cdninstagram\.com'/);
  assert.match(clientSource, /loadNextCatalogPage/);
  assert.match(clientSource, /loadPreviousCatalogPage/);
});

test('seleção em massa não baixa ids para representar "todos deste filtro"', () => {
  // O modo filtro tem de viajar como filtro + exceções. Se algum dia o cliente
  // passar a montar a lista de ids, a paginação por cursor perde o sentido.
  assert.match(clientSource, /buildBulkDeleteRequest/);
  assert.match(clientSource, /selectAllMatchingFilter/);
  assert.match(clientSource, /profileSelectionCount\(selection, profileCounters\.filteredTotal\)/);
  assert.doesNotMatch(clientSource, /setSelectedProfileIds/);
});

test('exclusão em massa exige confirmação digitada e acompanha a fila', () => {
  assert.match(clientSource, /isBulkDeleteConfirmed\(bulkDeleteConfirmation\)/);
  assert.match(clientSource, /\/api\/profiles\/bulk-delete/);
  assert.match(clientSource, /\/api\/profiles\/removal-progress/);
  assert.match(clientSource, /dryRun: true/);
});

test('ordenação por métrica chega ao servidor em vez de reordenar a página', () => {
  assert.match(clientSource, /params\.set\('sort', selectedSort\)/);
  assert.match(apiSource, /searchParams\.get\('sort'\)/);
  assert.doesNotMatch(clientSource, /\.sort\(\(a, b\) => b\.publication_metrics/);
});

test('API paginada evita recarregar todo o contexto de organizações', () => {
  assert.match(apiSource, /auth\.getSession\(\)/);
  assert.match(apiSource, /ACTIVE_ORGANIZATION_COOKIE/);
  assert.doesNotMatch(apiSource, /getOrganizationContext/);
  assert.match(pageSource, /getInstagramProfilesCatalogPage/);
});
