import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { isLegacySchedulingEnabled, LEGACY_SCHEDULING_DISABLED_MESSAGE } from './legacy-scheduling.ts';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

function withFlag(value: string | undefined, run: () => void) {
  const previous = process.env.LEGACY_SCHEDULING_ENABLED;
  if (value === undefined) delete process.env.LEGACY_SCHEDULING_ENABLED;
  else process.env.LEGACY_SCHEDULING_ENABLED = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.LEGACY_SCHEDULING_ENABLED;
    else process.env.LEGACY_SCHEDULING_ENABLED = previous;
  }
}

test('sem a variável, os modos antigos de agendar ficam desligados', () => {
  withFlag(undefined, () => assert.equal(isLegacySchedulingEnabled(), false));
});

test('só a string exata "true" religa', () => {
  withFlag('true', () => assert.equal(isLegacySchedulingEnabled(), true));
  for (const value of ['', 'false', '0', '1', 'TRUE', 'True', ' true', 'true ', 'on', 'yes']) {
    withFlag(value, () => assert.equal(isLegacySchedulingEnabled(), false, `"${value}" não liga`));
  }
});

test('o aviso manda para a postagem contínua, na tela de Grupos', () => {
  assert.match(LEGACY_SCHEDULING_DISABLED_MESSAGE, /desativada/);
  assert.match(LEGACY_SCHEDULING_DISABLED_MESSAGE, /postagem contínua/);
  assert.match(LEGACY_SCHEDULING_DISABLED_MESSAGE, /Grupos/);
});

// Rotas que CRIAM publicação pelos modos antigos (postar agora, programar,
// programar em massa). Cada POST consulta a flag antes de tocar no banco.
const blockedCreationRoutes = [
  'app/api/publications/route.ts',
  'app/api/publication-generation-jobs/route.ts',
  'app/api/bulk-publications/confirm/route.ts',
  'app/api/bulk-publications/review/route.ts',
];

function postHandler(source: string) {
  const start = source.indexOf('export async function POST(');
  assert.ok(start >= 0, 'a rota tem POST');
  return source.slice(start);
}

for (const path of blockedCreationRoutes) {
  test(`${path}: o POST responde 410 pela flag antes de qualquer acesso ao banco`, () => {
    const post = postHandler(read(path));
    const guard = post.indexOf('if (!isLegacySchedulingEnabled())');
    assert.ok(guard >= 0, 'o POST consulta isLegacySchedulingEnabled()');

    const guardBlock = post.slice(guard, post.indexOf('}', post.indexOf('status: 410', guard)));
    assert.match(guardBlock, /LEGACY_SCHEDULING_DISABLED_MESSAGE/);
    assert.match(guardBlock, /status: 410/);

    // getOrganizationContext lê sessão e organizações no Supabase; o cliente e
    // as RPCs vêm depois. Nenhum deles pode aparecer antes do desvio.
    for (const databaseAccess of ['getOrganizationContext(', 'createSupabaseServerClient(', 'createSupabaseAdminClient(', '.rpc(', '.from(']) {
      const first = post.indexOf(databaseAccess);
      if (first >= 0) assert.ok(first > guard, `${databaseAccess} vem depois do desvio pela flag`);
    }
  });
}

function routeFiles(directory: string): string[] {
  return readdirSync(new URL(directory, root), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === 'route.ts' ? [path] : [];
  });
}

test('toda rota de painel que chama uma RPC de criação dos modos antigos está na lista barrada', () => {
  // Fora do alcance: workers (internal), postagem contínua (groups) e o módulo
  // X/Twitter (x), que tem flags próprias.
  const outOfScope = ['app/api/internal/', 'app/api/groups/', 'app/api/x/'];
  const creationRpc = /queue_publication_batch|create_publication_generation_job|create_bulk_(daily_|sequential_)?rotation_plan/;
  const creators = routeFiles('app/api')
    .filter((path) => !outOfScope.some((prefix) => path.startsWith(prefix)))
    .filter((path) => creationRpc.test(read(path)));

  assert.ok(creators.length >= 3, 'a varredura encontrou as rotas de criação');
  for (const path of creators) {
    assert.ok(blockedCreationRoutes.includes(path), `${path} cria publicação pelos modos antigos e precisa consultar a flag`);
  }
});

test('leitura, cancelamento, continuar lote e a prévia de mídias dos Grupos não passam pela flag', () => {
  const openRoutes = [
    'app/api/publications/[itemId]/route.ts',
    'app/api/publications/cancel/route.ts',
    'app/api/publications/queue-actions/route.ts',
    'app/api/publications/action-blocks/route.ts',
    'app/api/publications/batch/[batchId]/cancel/route.ts',
    'app/api/publications/batch/[batchId]/continue/route.ts',
    'app/api/publications/batch/[batchId]/profiles/[profileId]/resume/route.ts',
    'app/api/publication-generation-jobs/[jobId]/route.ts',
    'app/api/bulk-publications/route.ts',
    'app/api/bulk-publications/[planId]/route.ts',
    'app/api/bulk-publications/media/route.ts',
    'app/api/bulk-publications/origins/route.ts',
    'app/api/agenda-items/route.ts',
  ];
  for (const path of openRoutes) {
    assert.doesNotMatch(read(path), /isLegacySchedulingEnabled/, `${path} continua aberta`);
  }

  // Nas rotas barradas, só o POST desvia: a fila e a lista de jobs seguem legíveis.
  for (const path of ['app/api/publications/route.ts', 'app/api/publication-generation-jobs/route.ts']) {
    const source = read(path);
    const get = source.slice(source.indexOf('export async function GET('), source.indexOf('export async function POST('));
    assert.doesNotMatch(get, /isLegacySchedulingEnabled/, `GET de ${path} continua aberto`);
  }
});

test('o menu esconde a Postagem do Instagram e a flag chega ao cliente por prop do servidor', () => {
  const layout = read('app/(painel)/layout.tsx');
  assert.match(layout, /legacySchedulingEnabled=\{isLegacySchedulingEnabled\(\)\}/);

  const shell = read('app/components/app-shell.tsx');
  assert.match(shell, /instagramNavigation\.filter\(\(item\) => item\.href !== '\/postagem'\)/);
  assert.doesNotMatch(shell, /process\.env/);
  // A entrada do X/Twitter não depende desta flag.
  assert.doesNotMatch(shell, /twitterNavigation\.filter/);

  for (const path of ['app/components/legacy-scheduling-context.tsx', 'app/agenda/agenda-client.tsx', 'app/queue/queue-client.tsx', 'app/dashboard-client.tsx']) {
    assert.doesNotMatch(read(path), /process\.env|NEXT_PUBLIC_LEGACY/, `${path} não lê ambiente no cliente`);
  }
});

test('a tela de Postagem mostra o aviso com link para Grupos antes de carregar o compositor', () => {
  const page = read('app/(painel)/postagem/page.tsx');
  const guard = page.indexOf('if (!isLegacySchedulingEnabled()) return <LegacySchedulingDisabledNotice />');
  assert.ok(guard >= 0, 'a página desvia pela flag');
  assert.ok(page.indexOf('<PublishingPageContent />') > guard, 'o desvio vem antes do compositor');
  assert.match(page, /href="\/grupos"/);
  // O compositor antigo continua no arquivo.
  assert.match(page, /<PublishingClient/);
});
