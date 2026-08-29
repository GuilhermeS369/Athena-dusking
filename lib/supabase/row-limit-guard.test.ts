import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { POSTGREST_MAX_ROWS } from './paginate.ts';

/**
 * O PostgREST corta QUALQUER resposta da Data API em `max_rows`, inclusive RPC
 * `returns table`. Duas consequências que já custaram incidentes:
 *
 *  1. `.limit(N)` acima do teto é sempre um bug: o número mente, a resposta vem
 *     cortada no teto e ninguém percebe.
 *  2. Um `.select()` numa tabela cujo número de linhas cresce com o tamanho da
 *     organização, sem `.range()`/`.limit()`, é truncado em silêncio.
 *
 * Este teste varre o código de produção (app/ e lib/) atrás dos dois padrões.
 * Não é análise de AST: é uma varredura de texto deliberadamente conservadora,
 * feita para não passar despercebida em revisão. Quando um caso legítimo cair
 * aqui, adicione-o a ALLOWLIST com a justificativa — a ideia é forçar a decisão
 * consciente, não proibir o padrão.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCANNED_DIRECTORIES = ['app', 'lib'];
// Importado, não copiado: se o max_rows do projeto mudar, este teste acompanha
// em vez de passar a afirmar um número que deixou de ser verdade.
const ROW_CAP = POSTGREST_MAX_ROWS;

/** Tabelas e views cujo número de linhas cresce com perfis, vínculos ou fila. */
const SCALING_RELATIONS = [
  'instagram_profiles',
  'instagram_profiles_safe',
  'profile_group_members',
  'group_profile_export_rows',
  'publication_items',
  'twitter_profiles',
  'twitter_group_members',
  'twitter_media_group_members',
  'twitter_publication_items',
  'twitter_publication_attempts',
  'twitter_program_shortfalls',
  'twitter_connections',
  'zernio_connections',
];

/**
 * Exceções aprovadas: `<caminho>::<relação>` com o motivo pelo qual o corte é
 * aceitável ali. Toda entrada nova precisa de justificativa escrita.
 */
const ALLOWLIST = new Map<string, string>([
  [
    'lib/dashboard/server.ts::publication_items',
    'Caminho V1 da dashboard: a série de 370 dias não cabe em memória. Limitada explicitamente a 1000 e o corte é reportado em log; a correção definitiva é o DASHBOARD_V2_ENABLED.',
  ],
  [
    'app/api/internal/twitter-rollout-health/route.ts::twitter_publication_attempts',
    'Amostra de latência das tentativas mais recentes; o corte é intencional e o limite declara a verdade.',
  ],
  [
    'app/api/internal/twitter-rollout-health/route.ts::twitter_publication_items',
    'Hidratação por .in(id) sobre os ids da amostra de latência acima, que já é limitada a 1000.',
  ],

  // --- Leituras limitadas por uma página de cursor a montante (<= 101 itens) ---
  [
    'app/(painel)/x/galeria/page.tsx::twitter_media_group_members',
    '.in(asset_id) sobre a página de mídias já paginada por cursor.',
  ],
  [
    'app/api/x/media/route.ts::twitter_media_group_members',
    '.in(asset_id) sobre a página de mídias já paginada por cursor.',
  ],
  [
    'app/api/x/groups/route.ts::twitter_group_members',
    '.in(profile_id) sobre a página de perfis já paginada por cursor.',
  ],
  [
    'app/api/x/profiles/route.ts::twitter_group_members',
    '.in(profile_id) sobre a página de perfis já paginada por cursor.',
  ],
  [
    'app/api/x/profiles/route.ts::twitter_connections',
    '.in(id) sobre as conexões distintas de uma página de perfis.',
  ],
  [
    'app/api/x/logs/events/route.ts::twitter_profiles',
    'Hidratação de nomes para uma página de eventos já paginada por cursor.',
  ],
  [
    'app/api/x/logs/events/route.ts::twitter_connections',
    'Hidratação de nomes para uma página de eventos já paginada por cursor.',
  ],
  [
    'app/api/x/logs/incidents/[incidentId]/occurrences/route.ts::twitter_profiles',
    'Hidratação de nomes para uma página de ocorrências já paginada por cursor.',
  ],
  [
    'app/api/x/logs/incidents/[incidentId]/occurrences/route.ts::twitter_connections',
    'Hidratação de nomes para uma página de ocorrências já paginada por cursor.',
  ],

  // --- Leituras de um único recurso, ou de um lote reivindicado por RPC ---
  [
    'app/(painel)/x/perfis/[profileId]/page.tsx::twitter_group_members',
    'Vínculos de um único perfil: no máximo uma linha por grupo da organização.',
  ],
  [
    'app/api/x/media/complete/route.ts::twitter_media_group_members',
    'Vínculos de um único asset.',
  ],
  [
    'app/api/internal/twitter-preparation-run/route.ts::twitter_profiles',
    '.in(id) sobre o lote reivindicado no ciclo, limitado a 500 pela RPC de claim.',
  ],
  [
    'app/api/internal/twitter-sync-claims/route.ts::twitter_profiles',
    '.in(id) sobre as epochs reivindicadas no ciclo, limitadas pela RPC de claim.',
  ],
  [
    'lib/twitter/zernio-profiles.ts::twitter_profiles',
    '.in(id) sobre as epochs abertas de uma conexão, limitadas pelo slot limit da conta.',
  ],
]);

function listSourceFiles(directory: string): string[] {
  const absolute = path.join(REPO_ROOT, directory);
  const files: string[] = [];

  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(full);
    }
  };

  walk(absolute);
  return files;
}

const SOURCE_FILES = SCANNED_DIRECTORIES.flatMap(listSourceFiles);

function repoPath(file: string) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

/**
 * Substitui o conteúdo dos comentários por espaços, preservando os offsets (e
 * portanto os números de linha). Sem isto, um comentário explicando por que
 * `.limit(5000)` era um bug seria reportado como o próprio bug.
 */
function blankComments(source: string): string {
  const out = source.split('');
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        index += source[index] === '\\' ? 2 : 1;
      }
      index += 1;
      continue;
    }

    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') { out[index] = ' '; index += 1; }
      continue;
    }

    if (char === '/' && source[index + 1] === '*') {
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] !== '\n') out[index] = ' ';
        index += 1;
      }
      out[index] = ' ';
      out[index + 1] = ' ';
      index += 2;
      continue;
    }

    index += 1;
  }

  return out.join('');
}

const SOURCE_BY_PATH = new Map(
  SOURCE_FILES.map((file) => [file, blankComments(readFileSync(file, 'utf8'))]),
);

/**
 * Devolve o texto da cadeia iniciada em `start`, parando quando a expressão que
 * a contém termina. Acompanha profundidade de parênteses/colchetes e ignora o
 * conteúdo de strings, para não cortar no meio de um `.select('a, b')`.
 */
function readChain(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (char === '\\') { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '(' || char === '[' || char === '{') { depth += 1; continue; }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      // Fechou a expressão que continha a cadeia.
      if (depth < 0) return source.slice(start, index);
      continue;
    }
    if (depth === 0 && (char === ';' || char === '\n' && /^\s*[^.\s)]/.test(source.slice(index + 1, index + 40)))) {
      return source.slice(start, index);
    }
  }

  return source.slice(start);
}

test('nenhum .limit() acima do teto de linhas do PostgREST', () => {
  const offenders: string[] = [];

  for (const file of SOURCE_FILES) {
    const source = SOURCE_BY_PATH.get(file)!;
    for (const match of source.matchAll(/\.limit\(\s*([\d_]+)\s*\)/g)) {
      const value = Number(match[1].replace(/_/g, ''));
      if (value <= ROW_CAP) continue;
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${repoPath(file)}:${line} → .limit(${value})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `.limit(N) com N > ${ROW_CAP} é sempre um bug: o PostgREST corta a resposta em ${ROW_CAP} linhas e o número passa uma segurança que não existe. Use fetchAllRows (se o consumidor precisa do total) ou declare um limite honesto.\n${offenders.join('\n')}`,
  );
});

test('consultas em tabelas que escalam com a organização declaram paginação', () => {
  const offenders: string[] = [];

  for (const file of SOURCE_FILES) {
    const source = SOURCE_BY_PATH.get(file)!;
    const relative = repoPath(file);

    for (const match of source.matchAll(/\.from\(\s*["']([a-z_]+)["']/g)) {
      const relation = match[1];
      if (!SCALING_RELATIONS.includes(relation)) continue;
      if (ALLOWLIST.has(`${relative}::${relation}`)) continue;

      const chain = readChain(source, match.index);
      const bounded = /\.range\(/.test(chain)
        || /\.limit\(/.test(chain)
        || /\.maybeSingle\(/.test(chain)
        || /\.single\(/.test(chain)
        || /head:\s*true/.test(chain)
        || /count:\s*['"]exact['"]/.test(chain)
        // Mutações (update/delete/insert/upsert) não sofrem teto de linhas.
        || /\.(update|delete|insert|upsert)\(/.test(chain);

      if (bounded) continue;
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${relative}:${line} → .from('${relation}') sem .range()/.limit()`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Estas consultas leem tabelas cujo número de linhas cresce com o tamanho da organização e não declaram paginação, então o PostgREST as corta em ${ROW_CAP} linhas sem erro. Envolva em fetchAllRows (lib/supabase/paginate.ts) com .order() determinístico + .range(), use cursor limit+1 se for lista para o cliente, ou registre a exceção em ALLOWLIST com a justificativa.\n${offenders.join('\n')}`,
  );
});
