import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { POSTGREST_MAX_ROWS } from './paginate.ts';

/**
 * O PostgREST corta QUALQUER resposta da Data API em `max_rows`, inclusive RPC
 * `returns table`, e não garante ordem entre páginas quando a ordenação empata.
 * Quatro consequências, todas já pagas em incidente:
 *
 *  1. `.limit(N)` acima do teto é sempre um bug: o número mente, a resposta vem
 *     cortada no teto e ninguém percebe.
 *  2. Um `.select()` numa tabela cujo número de linhas cresce com o tamanho da
 *     organização, sem `.range()`/`.limit()`, é truncado em silêncio.
 *  3. Paginar por `.range()` sem ordem TOTAL faz páginas consecutivas repetirem
 *     linhas e perderem outras. É o pior dos quatro, porque não falta dado: vem
 *     a quantidade certa de linhas erradas.
 *  4. Uma paginação que a varredura não consegue atribuir a uma tabela é um
 *     ponto cego — as regras 1 a 3 simplesmente não a alcançam.
 *
 * POR QUE A REGRA 3 EXISTE. Em 30/08/2026 um script de reparo paginou
 * `profile_analytics_daily_metrics` ordenando só por `metric_date`, que não é
 * único. Medido na janela de 30 dias de uma organização: 7.151 linhas lidas,
 * 6.942 distintas — 209 repetidas e 209 nunca vistas. Como cada linha perdida
 * virava um "dia faltando" inexistente, o script relatou 166 dias de lacuna
 * onde havia 7. No mesmo dia, medições da fila paginando `publication_items`
 * por `execute_at` (449 itens dividem o mesmo instante numa onda de
 * agendamento em massa) leram 11.332 linhas com 11.241 distintas, e as
 * conclusões tiradas dali — vazão de pico, capacidade provada — estavam
 * erradas nas duas pontas.
 *
 * POR QUE A REGRA 4 EXISTE. Nenhuma das outras teria pego aquele script: ele
 * chamava `.from(table)` com variável, dentro de um helper genérico, e toda a
 * varredura se ancora em `.from('literal')`. A regra 4 recusa o ponto cego em
 * vez de fingir que o adivinha.
 *
 * ESCOPO, e por que ele não é o mesmo para todas. A varredura cobre `app/`,
 * `lib/` e `scripts/`. As regras de ORDENAÇÃO (3 e 4) valem em todos, sem
 * exceção — o incidente foi num script de uso único, então isentá-los
 * derrotaria o propósito. A regra 2 só cobra `scripts/` nos entrypoints do
 * `package.json`: aplicá-la a todo o diretório produziria 83 acusações em 48
 * scripts de incidente já executados, e 48 justificativas escritas em massa
 * transformariam a ALLOWLIST em texto de fachada.
 *
 * Não é análise de AST: é uma varredura de texto deliberadamente conservadora,
 * feita para não passar despercebida em revisão. Quando um caso legítimo cair
 * aqui, registre-o na ALLOWLIST correspondente com a justificativa — a ideia é
 * forçar a decisão consciente, não proibir o padrão. As exceções das regras 1,
 * 3 e 4 são chaveadas por caminho + contagem, não por número de linha: linha
 * muda a cada edição acima, e a contagem é o que faz uma ocorrência NOVA no
 * mesmo arquivo ainda cair.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCANNED_DIRECTORIES = ['app', 'lib', 'scripts'];
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

  // Analytics do Instagram: uma linha por perfil por dia (ou por post), então
  // crescem mais rápido que a própria tabela de perfis. Foi paginando uma
  // delas sem ordem total que o backfill de 30/08/2026 se corrompeu.
  'profile_analytics_daily_metrics',
  'profile_analytics_current',
  'profile_analytics_snapshots',
  'profile_follower_daily_snapshots',
  'profile_post_analytics_snapshots',
  'profile_analytics_sync_runs',
  'profile_analytics_refresh_job_items',

  // Analytics e cadastros do módulo X, pelo mesmo critério.
  'twitter_profile_follower_daily_metrics',
  'twitter_post_analytics_current',
  'twitter_analytics_snapshots',
  'twitter_wallets',
  'twitter_media_assets',
  'twitter_rate_cards',
];

/**
 * Chave efetiva de cada relação vigiada, **sem** `organization_id` — quase toda
 * consulta já o fixa por `.eq()`, e a checagem de ordem total trata coluna
 * fixada por igualdade como coberta.
 *
 * Serve à regra de ordenação: paginar por `.range()` sem ordem total faz
 * páginas consecutivas repetirem linhas e perderem outras. Medido em produção
 * em 30/08/2026, `profile_analytics_daily_metrics` numa janela de 30 dias:
 * ordenando só por `metric_date`, 7.151 linhas lidas e 6.942 distintas — 209
 * repetidas e 209 nunca vistas. Ordenando pela chave completa, 7.151/7.151.
 * No mesmo dia, `publication_items` ordenado só por `execute_at` (449 itens
 * dividem o mesmo instante numa onda de agendamento em massa): 11.332 lidas,
 * 11.241 distintas.
 */
const RELATION_KEYS = new Map<string, string[]>([
  ['instagram_profiles', ['id']],
  ['instagram_profiles_safe', ['id']],
  ['profile_group_members', ['group_id', 'profile_id']],
  ['publication_items', ['id']],
  ['twitter_profiles', ['id']],
  ['twitter_group_members', ['group_id', 'profile_id']],
  ['twitter_media_group_members', ['group_id', 'asset_id']],
  ['twitter_publication_items', ['id']],
  ['twitter_publication_attempts', ['id']],
  ['twitter_program_shortfalls', ['program_id', 'profile_id']],
  ['twitter_connections', ['id']],
  ['zernio_connections', ['id']],
  ['profile_analytics_daily_metrics', ['profile_id', 'provider', 'metric_date']],
  ['profile_analytics_current', ['profile_id']],
  ['profile_analytics_snapshots', ['id']],
  ['profile_follower_daily_snapshots', ['profile_id', 'provider', 'snapshot_date']],
  ['profile_post_analytics_snapshots', ['id']],
  ['profile_analytics_sync_runs', ['id']],
  ['profile_analytics_refresh_job_items', ['job_id', 'profile_id']],
  ['twitter_profile_follower_daily_metrics', ['profile_id', 'metric_date']],
  ['twitter_post_analytics_current', ['publication_item_id']],
  ['twitter_analytics_snapshots', ['id']],
  ['twitter_wallets', ['identity_id']],
  ['twitter_media_assets', ['id']],
  ['twitter_rate_cards', ['id']],
  // `group_profile_export_rows` fica de fora de propósito: a view (migration
  // 205) não expõe chave única nenhuma, então não há chave a exigir. A decisão
  // sobre a ordem dela está escrita na própria rota de exportação.
]);

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

  // --- Carteiras e mídias X hidratadas a partir de um conjunto já limitado ---
  [
    'app/(painel)/x/zernio/page.tsx::twitter_wallets',
    '.in(identity_id) sobre as identidades distintas de pageConnections, cortada em 100 conexões. A carteira é 1 linha por identidade.',
  ],
  [
    'app/api/x/integrations/zernio/connections/route.ts::twitter_wallets',
    '.in(identity_id) sobre as identidades de uma página de cursor de conexões. 1 linha por identidade.',
  ],
  [
    'app/api/x/profiles/route.ts::twitter_wallets',
    '.in(identity_id) sobre as identidades das conexões de uma página de cursor de perfis. 1 linha por identidade.',
  ],
  [
    'app/api/x/analytics/resources/route.ts::twitter_post_analytics_current',
    '.in(publication_item_id) sobre a página de posts já cortada em PAGE_SIZE. A projeção é 1 linha por item.',
  ],
  [
    'app/api/x/media-groups/[groupId]/members/route.ts::twitter_media_assets',
    '.in(id) sobre os assetIds do corpo da requisição, recusado acima de 500 pela validação da própria rota.',
  ],

  // --- Scripts entrypoint: hidratação por .in(ids) sobre lista já limitada ---
  [
    'scripts/observability/backfill-instagram-observability.mjs::publication_items',
    '.in(id) sobre blocos de chunks(itemIds) — o próprio script já divide os ids em lotes.',
  ],
  [
    'scripts/observability/backfill-instagram-observability.mjs::instagram_profiles',
    '.in(id) sobre blocos de chunks(profileIds), mesmo particionamento.',
  ],
  [
    'scripts/workers/zernio-sync-worker.mjs::instagram_profiles',
    '.in(id) sobre os perfis em conflito de um ciclo de sincronização, limitados pelo lote do ciclo.',
  ],
  [
    'scripts/workers/zernio-sync-worker.mjs::zernio_connections',
    '.in(id) sobre as conexões distintas dos candidatos do ciclo: no máximo uma linha por conexão da organização.',
  ],
  [
    'scripts/workers/publication-worker.mjs::publication_items',
    '.in(id) em blocos de 200 sobre as entradas de spool vencidas e não ativadas de um ciclo (commit 54db61d). O teto de linhas nunca era o risco aqui: o lote é subconjunto do despacho, limitado a 500 por PUBLICATION_WORKER_STAGED_DISPATCH_LIMIT. O que motivou os blocos foi o COMPRIMENTO DA URL — 500 UUIDs num .in() único geram ~18 KB de query string, abaixo do alerta de 1.000 do CLAUDE.md mas ainda dependente do limite de header do gateway, e falharia justamente no lote grande. Em blocos de 200 são ~7,4 KB.',
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
    'app/api/internal/twitter-sync-claims/route.ts::twitter_profiles',
    '.in(id) sobre as epochs reivindicadas no ciclo, limitadas pela RPC de claim.',
  ],
  [
    'lib/twitter/zernio-profiles.ts::twitter_profiles',
    '.in(id) sobre as epochs abertas de uma conexão, limitadas pelo slot limit da conta.',
  ],
]);

/**
 * Exceções da regra de ordem total: `<caminho>::<relação>` com o motivo pelo
 * qual a ordem declarada já é total apesar de não citar a chave inteira.
 */
const ORDERING_ALLOWLIST = new Map<string, string>([
  [
    'app/api/integrations/zernio/import-batches/route.ts::zernio_connections',
    "Ordena por label, que não é a PK, mas tem índice único em (organization_id, lower(label)) desde a migration 055 — a ordem já é total dentro da organização.",
  ],
  [
    'app/(painel)/x/analises/page.tsx::twitter_profile_follower_daily_metrics',
    'Fixa a data por .eq(snapshot_date), que é coluna GERADA a partir de metric_date (migration 260). A varredura não tem como saber que as duas são a mesma coluna, mas com a data fixada profile_id sozinho já é ordem total.',
  ],
]);

/**
 * Exceções da regra de paginação legível, por arquivo: quantas paginações
 * opacas ele tem hoje e por que a ordem de cada uma já é total. A varredura é
 * de texto e não enxerga dentro de um helper que recebe a tabela por
 * parâmetro; quem escreve o helper assume a responsabilidade por escrito aqui.
 *
 * A chave é o caminho, não o número da linha: linha muda a cada edição acima e
 * quebraria a exceção sem que nada de relevante tivesse mudado. `count` é o que
 * mantém a regra viva — uma paginação opaca NOVA no mesmo arquivo ainda cai.
 */
const OPAQUE_PAGINATION_ALLOWLIST = new Map<string, { count: number; reason: string }>([
  [
    'app/(painel)/postagem/page.tsx',
    { count: 1, reason: 'RPC composer_profile_metrics paginada por .order(profile_id): a função devolve uma linha por perfil, então profile_id é ordem total.' },
  ],
  [
    'app/(painel)/x/postagem/page.tsx',
    { count: 2, reason: 'RPCs de resumo de fila X paginadas por .order(profile_id): uma linha por perfil, ordem total.' },
  ],
  [
    'app/api/bulk-publications/profiles/route.ts',
    { count: 1, reason: 'RPC de contagens do compositor paginada por .order(profile_id): uma linha por perfil, ordem total.' },
  ],
  [
    'lib/twitter/bulk-service.ts',
    { count: 1, reason: 'RPC twitter_bulk_profile_queue_summary paginada por .order(profile_id): uma linha por perfil, ordem total.' },
  ],
  [
    'lib/publications/composer-metrics-fallback.ts',
    { count: 2, reason: 'Laço artesanal sobre publication_items com .order(id) — id é a PK, logo ordem total. A consulta vem de buildQuery(), por isso o .range() fica separado do .from().' },
  ],

  // --- Helpers genéricos em scripts/, com ordem total garantida ---
  [
    'scripts/observability/backfill-instagram-observability.mjs',
    { count: 1, reason: 'Pagina com .order(updated_at).order(id): id é a PK das tabelas varridas, logo ordem total.' },
  ],
  [
    'scripts/workers/recover-zernio-terminal-disconnections.mjs',
    { count: 1, reason: 'O helper fetchAll aplica orderBy dentro do laço, com a chave da tabela em cada chamada (id, ou (group_id, profile_id) em profile_group_members).' },
  ],
  [
    'scripts/workers/cleanup-duplicate-content-logs.mjs',
    { count: 1, reason: 'Helper fetchAll pagina sempre com .order(id) — PK das tabelas que ele varre.' },
  ],
  [
    'scripts/workers/ignore-overdue-duplicate-paused-stories.mjs',
    { count: 1, reason: 'Helper fetchAll pagina sempre com .order(id) — PK das tabelas que ele varre.' },
  ],
  [
    'scripts/workers/backfill-profile-analytics-daily.ts',
    { count: 1, reason: 'O script do incidente de 30/08/2026, já corrigido no commit 2fb7072: o helper allRows recebe a lista de colunas de ordenação e as chamadas passam a chave completa — (metric_date, profile_id, provider) em profile_analytics_daily_metrics, (id) em instagram_profiles. Foi a ordenação só por metric_date que produziu 7.151 linhas com 6.942 distintas.' },
  ],

  // --- Scripts de incidente de uso único, SEM garantia de ordem total ---
  // Estas entradas não afirmam que a paginação está correta; afirmam que o
  // script já rodou, que o resultado dele foi lido na época e que ninguém deve
  // reexecutá-lo sem antes dar uma ordem total ao helper. Registrar isto é o
  // ponto: é a diferença entre um limite conhecido e um limite esquecido.
  [
    'scripts/audit-dashboard-refresh-pipeline.mjs',
    { count: 1, reason: 'Uso único, já executado. O helper allPages não impõe ordenação e o configure do chamador nem sempre dá uma: a leitura pode ter repetido e perdido linhas. Não reexecutar sem corrigir.' },
  ],
  [
    'scripts/workers/audit-story-publication-failures.mjs',
    { count: 1, reason: 'Uso único, já executado. allPages(makeQuery) depende inteiramente da ordenação do chamador; sem garantia de ordem total. Não reexecutar sem corrigir.' },
  ],
  [
    'scripts/workers/audit-vini-zernio-cleanup-preflight.mjs',
    { count: 1, reason: 'Uso único, já executado. O helper aplica .range() ANTES do configure e não ordena: sem garantia de ordem total. Não reexecutar sem corrigir.' },
  ],
  [
    'scripts/workers/cleanup-zernio-terminal-observability.mjs',
    { count: 1, reason: 'Uso único, já executado. O helper fetchAll não ordena. Não reexecutar sem corrigir.' },
  ],
  [
    'scripts/workers/repost-latest-affected-stories.mjs',
    { count: 1, reason: 'Uso único, já executado. fetchAll(buildQuery) depende da ordenação do chamador. Não reexecutar sem corrigir.' },
  ],
  [
    'scripts/workers/trace-miguel-bulk-profile-coverage.mjs',
    { count: 2, reason: 'Uso único, já executado. fetchAllPages(buildQuery) pagina por count total sem impor ordem. Não reexecutar sem corrigir.' },
  ],
]);

/**
 * Scripts que o `package.json` referencia — os workers recorrentes e os
 * comandos operacionais mantidos.
 *
 * `scripts/` mistura esses com dezenas de scripts de incidente de uso único
 * (`audit-*`, `diagnose-*`, `recover-*`, scripts nomeados por organização). As
 * regras de ORDENAÇÃO valem para todos, sem exceção: foi num script de uso
 * único que o incidente de 30/08/2026 aconteceu, então isentá-los derrotaria o
 * propósito. Já as regras de TRUNCAMENTO (`.limit()` acima do teto e `.select()`
 * sem paginação) ficam restritas a esta lista: um script que rodou uma vez e já
 * foi acionado é registro histórico, e cobrar 48 justificativas dele encheria a
 * ALLOWLIST de texto de fachada, que é exatamente o que ela não deve ser.
 *
 * A lista sai do próprio `package.json`: se um script virar entrypoint de
 * verdade, passa a ser cobrado sozinho, sem ninguém precisar lembrar.
 */
const ENTRYPOINT_SCRIPTS = (() => {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const referenced = new Set<string>();
  for (const command of Object.values(manifest.scripts ?? {})) {
    for (const match of command.matchAll(/scripts\/[A-Za-z0-9_/.-]+\.(?:ts|mjs)/g)) referenced.add(match[0]);
  }
  return referenced;
})();

/**
 * A regra de `.select()` sem paginação só cobra `scripts/` nos entrypoints —
 * é ela que produziria as 83 acusações. A regra de `.limit()` acima do teto
 * vale em toda parte: é barata, nunca tem falso positivo, e um número como
 * `.limit(100000)` mente por fator de 20 num script novo tanto quanto num
 * antigo.
 */
function checkedForUnpaginatedSelect(relative: string): boolean {
  return !relative.startsWith('scripts/') || ENTRYPOINT_SCRIPTS.has(relative);
}

/**
 * Exceções da regra de `.limit()`, por arquivo: quantos limites mentirosos ele
 * tem e por que ficam. Mesma chave estável (caminho + contagem) da
 * OPAQUE_PAGINATION_ALLOWLIST.
 */
const OVERSIZED_LIMIT_ALLOWLIST = new Map<string, { count: number; reason: string }>([
  [
    'scripts/workers/audit-dashboard-posts.mjs',
    { count: 3, reason: `Auditoria de uso único, já executada. Os .limit(10000) foram cortados em ${POSTGREST_MAX_ROWS} pelo servidor: os totais que ela reportou são pisos, não contagens. Registrado para que ninguém releia aqueles números como completos.` },
  ],
  [
    'scripts/workers/audit-profile-analytics-cache.mjs',
    { count: 1, reason: 'Auditoria de uso único, já executada; o .limit(10000) foi cortado no teto e o resultado é um piso.' },
  ],
  [
    'scripts/workers/audit-story-reschedule-targets.mjs',
    { count: 1, reason: 'Uso único, já executado. O .limit(100000) mente por fator de 20; o que ele leu foi o teto.' },
  ],
  [
    'scripts/workers/diagnose-bulk-rotation.mjs',
    { count: 1, reason: 'Diagnóstico de uso único, já executado; o .limit(20000) foi cortado no teto.' },
  ],
  [
    'scripts/workers/direct-media-delivery-canary.mjs',
    { count: 1, reason: 'Canário de uso único, já executado; o .limit(10000) foi cortado no teto.' },
  ],
  [
    'scripts/workers/inspect-luiz-miguel-bulk-schedules.mjs',
    { count: 1, reason: 'Inspeção nomeada de uso único, já executada; o .limit(100000) foi cortado no teto.' },
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
      // .mjs entra junto: a maioria dos workers de verdade é .mjs, e sem isso
      // scripts/ entraria no escopo com os arquivos que mais importam de fora.
      if (/\.(tsx?|mjs)$/.test(entry) && !/\.test\.(tsx?|mjs)$/.test(entry)) files.push(full);
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
    const relative = repoPath(file);
    const oversized: string[] = [];

    for (const match of source.matchAll(/\.limit\(\s*([\d_]+)\s*\)/g)) {
      const value = Number(match[1].replace(/_/g, ''));
      if (value <= ROW_CAP) continue;
      const line = source.slice(0, match.index).split('\n').length;
      oversized.push(`${relative}:${line} → .limit(${value})`);
    }

    const approved = OVERSIZED_LIMIT_ALLOWLIST.get(relative);
    if (!approved) { offenders.push(...oversized); continue; }
    if (oversized.length > approved.count) {
      offenders.push(
        `${relative} → ${oversized.length} limites acima do teto, mas a exceção registrada cobre ${approved.count}. Reveja a entrada em OVERSIZED_LIMIT_ALLOWLIST.`,
      );
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
    if (!checkedForUnpaginatedSelect(relative)) continue;

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

/**
 * Um `.range()` com dois literais numéricos lê uma página só; sem segunda
 * página, ordem não-total não duplica nem perde linha. O bug mora no `.range()`
 * de laço, cujos limites são variáveis.
 */
function hasLoopingRange(chain: string): boolean {
  for (const match of chain.matchAll(/\.range\(([^)]*)\)/g)) {
    if (!/^[\d\s,_+*/-]+$/.test(match[1])) return true;
  }
  return false;
}

function namedArguments(chain: string, method: string): Set<string> {
  const pattern = new RegExp(`\\.${method}\\(\\s*["']([a-z_]+)["']`, 'g');
  return new Set([...chain.matchAll(pattern)].map((match) => match[1]));
}

test('paginação por .range() declara ordem total', () => {
  const offenders: string[] = [];

  for (const file of SOURCE_FILES) {
    const source = SOURCE_BY_PATH.get(file)!;
    const relative = repoPath(file);

    for (const match of source.matchAll(/\.from\(\s*["']([a-z_]+)["']/g)) {
      const relation = match[1];
      const key = RELATION_KEYS.get(relation);
      if (!key) continue;
      if (ORDERING_ALLOWLIST.has(`${relative}::${relation}`)) continue;

      const chain = readChain(source, match.index);
      if (!hasLoopingRange(chain)) continue;

      const ordered = namedArguments(chain, 'order');
      // Coluna fixada por igualdade não precisa entrar no .order(): com
      // .eq('group_id', X), ordenar só por profile_id JÁ é ordem total. Sem
      // esta ressalva a checagem nasce com 100% de falso positivo.
      const pinned = namedArguments(chain, 'eq');
      const missing = key.filter((column) => !ordered.has(column) && !pinned.has(column));
      if (!missing.length) continue;

      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(
        `${relative}:${line} → .from('${relation}') pagina ordenando por [${[...ordered].join(', ') || 'nada'}]; falta [${missing.join(', ')}] da chave [${key.join(', ')}]`,
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Estas consultas paginam por .range() sem ordem TOTAL. O PostgREST não garante ordem entre páginas quando a ordenação empata: as páginas repetem linhas e perdem outras, sem erro e sem warning — devolvem dado errado com cara de dado certo. Acrescente as colunas que faltam ao .order(), ou registre a exceção em ORDERING_ALLOWLIST explicando por que a ordem já é total.\n${offenders.join('\n')}`,
  );
});

test('paginação por .range() deixa a relação legível', () => {
  const offenders: string[] = [];

  for (const file of SOURCE_FILES) {
    const source = SOURCE_BY_PATH.get(file)!;
    const relative = repoPath(file);

    // Toda posição de .range() que pertence a uma cadeia iniciada num
    // .from('literal') — essas as duas checagens acima já alcançam.
    const attributed = new Set<number>();
    for (const match of source.matchAll(/\.from\(\s*["'][a-z_]+["']/g)) {
      const chain = readChain(source, match.index);
      for (const range of chain.matchAll(/\.range\(/g)) attributed.add(match.index + range.index);
    }

    const opaque: string[] = [];
    for (const match of source.matchAll(/\.range\(/g)) {
      if (attributed.has(match.index)) continue;
      const line = source.slice(0, match.index).split('\n').length;
      opaque.push(`${relative}:${line} → .range() sem um .from('<relação>') literal na cadeia`);
    }

    const approved = OPAQUE_PAGINATION_ALLOWLIST.get(relative);
    if (!approved) { offenders.push(...opaque); continue; }
    // A exceção cobre a quantidade registrada, não o arquivo inteiro: se
    // apareceu uma paginação opaca a mais, ela precisa de decisão própria.
    if (opaque.length > approved.count) {
      offenders.push(
        `${relative} → ${opaque.length} paginações opacas, mas a exceção registrada cobre ${approved.count}. Reveja a entrada em OPAQUE_PAGINATION_ALLOWLIST.`,
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Estas paginações são opacas para a varredura: a tabela chega por variável, ou a cadeia se quebra antes do .range(), então nenhuma das checagens acima consegue verificar a ordenação. Foi exatamente esta a forma que deixou passar o backfill de 30/08/2026 (.from(table) dentro de um helper genérico). Escreva a tabela como literal na própria cadeia — ou, se o helper genérico for proposital, registre em OPAQUE_PAGINATION_ALLOWLIST qual ordenação ele aplica e por que ela é total.\n${offenders.join('\n')}`,
  );
});
