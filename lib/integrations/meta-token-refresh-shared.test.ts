import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * A renovação de token precisa existir UMA vez.
 *
 * Ela nasceu duplicada: o worker de renovação reimplementou a chamada à Meta em
 * vez de chamar `refreshMetaProfileToken`, e a razão não foi descuido — o
 * módulo importava pelo alias `@/`, que o node não resolve ao rodar um script
 * direto. As duas cópias já divergiram no primeiro dia: uma insistia na
 * gravação e a outra tratava `reauthorization_required`; nenhuma fazia as duas.
 *
 * Estes testes protegem a condição que permite compartilhar: o módulo tem de
 * carregar tanto no bundler do Next quanto no node puro.
 */

const source = readFileSync(new URL('./meta-token-refresh.ts', import.meta.url), 'utf8');

/**
 * Percorre o grafo de importes a partir da raiz e devolve todo módulo local
 * alcançável. Listar os arquivos à mão não serviria: o modo de falha real é
 * alguém acrescentar uma dependência nova amanhã, e uma lista fixa não veria.
 */
function reachableLocalModules(entry: URL) {
  const visited = new Map<string, string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = current.pathname;
    if (visited.has(key)) continue;

    const contents = readFileSync(current, 'utf8');
    visited.set(key, contents);

    for (const match of contents.matchAll(/from '(\.[^']+)'/g)) {
      queue.push(new URL(match[1], current));
    }
  }

  return visited;
}

const nodeLoadableModules = reachableLocalModules(new URL('./meta-token-refresh.ts', import.meta.url));

test('nenhum módulo alcançável usa o alias @/, que o node não resolve', () => {
  // Estes arquivos são COPIADOS para a VPS, que não é um checkout git e não
  // acompanha o repositório sozinha. Um alias `@/` acrescentado aqui não
  // quebraria nada no Next — quebraria a renovação de token em produção, em
  // silêncio, no próximo ciclo do worker.
  const offenders = [...nodeLoadableModules]
    .filter(([, contents]) => /from '@\//.test(contents))
    .map(([path]) => path);

  assert.deepEqual(offenders, []);
});

test('todo import relativo do conjunto carrega extensão .ts', () => {
  // Sem a extensão o node não resolve o arquivo, mesmo sem alias nenhum.
  const offenders: string[] = [];

  for (const [path, contents] of nodeLoadableModules) {
    for (const match of contents.matchAll(/from '(\.[^']+)'/g)) {
      if (!match[1].endsWith('.ts')) offenders.push(`${path} → ${match[1]}`);
    }
  }

  assert.deepEqual(offenders, []);
});

test('o conjunto copiado para a VPS é o esperado', () => {
  // Se este teste falhar, o grafo cresceu: há arquivo novo que precisa ser
  // enviado para a VPS junto, senão o worker de lá quebra ao importar.
  const names = [...nodeLoadableModules.keys()]
    .map((path) => path.split('/').pop())
    .sort();

  assert.deepEqual(names, [
    'admin.ts',
    'meta-oauth.ts',
    'meta-token-refresh.ts',
    'meta-token-renewal.ts',
    'token-crypto.ts',
  ]);
});

test('o módulo carrega de fato sob o node puro, sem bundler', async () => {
  // O teste que importa: o de cima é leitura de texto, este é a prova.
  const module = await import('./meta-token-refresh.ts');

  assert.equal(typeof module.refreshMetaProfileToken, 'function');
  assert.equal(typeof module.refreshMetaProfileTokens, 'function');
});

test('a gravação do token novo insiste antes de desistir', () => {
  // A Meta já emitiu o token quando chegamos aqui: ele só existe em memória e
  // não pode ir para log. Uma indisponibilidade momentânea do PostgREST não
  // pode custar a credencial de um perfil.
  assert.match(source, /const SAVE_ATTEMPTS = \d+;/);
  assert.match(source, /for \(let attempt = 1; attempt <= SAVE_ATTEMPTS/);
  assert.match(source, /TOKEN NOVO PERDIDO/);
});

test('a renovação bem-sucedida tira o perfil de "reautorizar"', () => {
  // Sem isto, um perfil renovado continua pedindo reconexão na tela enquanto o
  // token está perfeitamente vivo — e o operador clica em Reautorizar à toa.
  assert.match(source, /reauthorization_required' \? \{ status: 'no_data' \}/);
});

test('só erro de autorização marca o perfil, nunca uma indisponibilidade', () => {
  assert.match(source, /response\.status === 401\s*\|\|\s*response\.status === 403/);
  assert.match(source, /payload\.error\?\.code === 190/);
  assert.match(source, /\.\.\.\(reauthorization \? \{ status: 'reauthorization_required' \} : \{\}\)/);
});
