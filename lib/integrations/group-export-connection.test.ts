import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync('supabase/migrations/408_group_export_shows_the_connection.sql', 'utf8');
const groupExport = readFileSync('app/api/groups/[groupId]/export/route.ts', 'utf8');
const allExport = readFileSync('app/api/groups/export-all/route.ts', 'utf8');
const groupsClient = readFileSync('app/grupos/groups-client.tsx', 'utf8');

test('a coluna da planilha resolve o rótulo pelo provedor, não por coalesce', () => {
  assert.match(migration, /case profile\.provider::text\s+when 'zernio' then connection\.label\s+when 'meta_official' then coalesce\(\s+meta_app\.label,/);
  assert.match(migration, /end as connection_label,/);
  assert.match(migration, /left join public\.meta_apps meta_app\s+on meta_app\.id = profile\.meta_app_id\s+and meta_app\.organization_id = profile\.organization_id/);
  assert.doesNotMatch(migration, /coalesce\(connection\.label/);
});

test('perfil solto do app sai com o app que tinha, marcado, e não como "Não informado"', () => {
  assert.match(migration, /coalesce\(\s*meta_app\.label,[\s\S]*?profile\.orphaned_from_meta_app_label \|\| ' \(sem app\)'/);
});

test('renomear a coluna exige derrubar a view, e sem cascade', () => {
  // A instrução em si, não a explicação acima dela: sem cascade, um dependente
  // futuro derruba o push em vez de sumir junto.
  const dropStatement = migration.match(/^drop view .*$/m);
  assert.ok(dropStatement);
  assert.equal(dropStatement[0], 'drop view if exists public.group_profile_export_rows;');
  // O nome antigo só pode sobreviver na explicação escrita, nunca como coluna.
  assert.doesNotMatch(migration, / as zernio_connection_label/);
  assert.match(migration, /grant select on public\.group_profile_export_rows to authenticated, service_role/);
});

test('as duas linhas de queda também entregam a conexão sob o nome novo', () => {
  assert.match(migration, /incident\.connection_label_snapshot as connection_label/);
  assert.match(migration, /incident\.meta_app_label_snapshot as connection_label/);
});

test('os dois consumidores leem a coluna nova e nenhum ficou para trás', () => {
  for (const route of [groupExport, allExport]) {
    assert.match(route, /select\('group_id, group_name, group_consumption_mode, row_kind, username, connection_label,/);
    assert.doesNotMatch(route, /zernio_connection_label/);
  }
});

test('o cabeçalho diz "Conexão" e a célula vem da coluna nova', () => {
  const headers = groupsClient.match(/const exportHeaders = \[([\s\S]*?)\];/);
  assert.ok(headers);
  assert.match(headers[1], /'Conexão'/);
  assert.doesNotMatch(headers[1], /'Zernio'/);
  assert.match(groupsClient, /row\.connection_label \?\? 'Não informado'/);
  assert.doesNotMatch(groupsClient, /zernio_connection_label/);
});

test('cabeçalho, largura e corpo continuam com o mesmo número de colunas', () => {
  const headers = groupsClient.match(/const exportHeaders = \[([\s\S]*?)\];/)![1].split(',').length;
  const widths = groupsClient.match(/const exportColumnWidths = \[([\s\S]*?)\];/)![1].split(',').length;
  const bodyStart = groupsClient.indexOf('const body = rows.map((row) => [');
  const bodyEnd = groupsClient.indexOf(']);', bodyStart);
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart);
  const body = groupsClient.slice(bodyStart, bodyEnd).split('\n').slice(1).filter((entry) => entry.trim().length > 0).length;
  assert.equal(headers, widths);
  assert.equal(headers, body);
});
