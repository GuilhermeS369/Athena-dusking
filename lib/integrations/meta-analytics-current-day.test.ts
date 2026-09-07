import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Três regras da coleta da Meta que só quebram em silêncio.
 *
 * POR QUE VARREDURA DE CÓDIGO E NÃO TESTE DE UNIDADE. `meta-analytics.ts` e
 * `meta-analytics-refresh.ts` importam por alias `@/`, e o `npm test` deste
 * repositório roda `node --test` puro, sem resolvedor de alias — importar
 * qualquer um dos dois aqui falha antes da primeira asserção. O idioma já
 * usado pelo projeto para regras assim é a varredura: ver
 * `lib/supabase/row-limit-guard.test.ts`.
 *
 * As três nasceram do mesmo dia (07/09/2026) e as três tinham a mesma cara:
 * número plausível na tela, nenhum erro em lugar nenhum.
 */

const raiz = path.join(import.meta.dirname, '..', '..');

/**
 * Lê normalizando o fim de linha.
 *
 * O repositório grava em CRLF (`core.autocrlf` no Windows). Sem normalizar,
 * todo padrão escrito com quebra de linha simples erra por um caractere — um
 * jeito bobo de um guarda ficar preso em verde ou em vermelho para sempre.
 */
const ler = (relativo: string) => readFileSync(path.join(raiz, relativo), 'utf8').split('\r\n').join('\n');

/** O trecho entre `abertura` e o primeiro `fechamento` depois dela. */
function bloco(fonte: string, abertura: string, fechamento: string) {
  const inicio = fonte.indexOf(abertura);
  assert.notEqual(inicio, -1, `Âncora não encontrada no arquivo: ${abertura}`);
  const fim = fonte.indexOf(fechamento, inicio + abertura.length);
  assert.notEqual(fim, -1, `Fechamento não encontrado depois de: ${abertura}`);
  return fonte.slice(inicio, fim);
}

test('o estado corrente grava UM dia, nunca a soma da janela', () => {
  // A coluna "Views" de /perfis mostra `profile_analytics_current.views` cru,
  // sem período ao lado. Enquanto esse campo vinha de `windowTotals`, ele era a
  // soma dos dias coletados — e quantos dias são muda com a passada do cron
  // (`days = deepPass ? 4 : 2`). Medido na organização Pomodoro em 07/09/2026:
  // 572 perfis exibindo soma de 4 dias contra 428 exibindo soma de 2, na mesma
  // coluna. Numa conta com tráfego parelho, somar dois dias é mostrar o dobro.
  const escrita = bloco(
    ler('lib/integrations/meta-analytics-refresh.ts'),
    'currentRowsWithNumbers.push({',
    '});',
  );

  assert.ok(
    !escrita.includes('windowTotals'),
    'A linha de estado corrente voltou a ler `windowTotals`. Ela mede UM dia fechado (`latestDayTotals`); a soma da janela pertence à linha de período, que carrega period_start/period_end ao lado e por isso pode somar.',
  );
  assert.ok(
    escrita.includes('latestDay'),
    'A linha de estado corrente precisa vir de `latestDayTotals` / `collectionLatestDayInteractions`.',
  );
  assert.ok(
    escrita.includes('period_start: collection.latestDayDate')
      && escrita.includes('period_end: collection.latestDayDate'),
    'O período do estado corrente precisa ser o dia medido, começo e fim iguais — é o que permite a tela escrever a data em vez de exibir um total anônimo.',
  );
});

test('a coleta devolve o período que a Meta mediu, não o palpite do calendário', () => {
  // `collectMetaProfileAnalytics` calcula `periodStart`/`periodEnd` provisórios
  // a partir do NOSSO calendário, e os reatribui quando os baldes da conta
  // chegam. Só que o `return` espalha `...base` — que carrega os provisórios —
  // e, se não relistar os dois campos, a reatribuição é jogada fora sem erro
  // nenhum. Ficou assim até 07/09/2026: o banco gravava period 06/09..07/09 em
  // registros cuja soma era de 05/09 e 06/09. Um dia de erro na frota inteira.
  const retorno = bloco(
    ler('lib/integrations/meta-analytics.ts'),
    'return {\n    ...base,\n    status,\n    failure: insightFailure,',
    '\n  };',
  );

  assert.ok(
    retorno.includes('\n    periodStart,\n') && retorno.includes('\n    periodEnd,\n'),
    'O return de collectMetaProfileAnalytics precisa relistar `periodStart` e `periodEnd`. Sem isso o `...base` sobrescreve o período medido com o palpite do calendário, e o erro não aparece: o palpite tem o formato certo.',
  );
  assert.ok(
    retorno.includes('\n    latestDayDate,\n'),
    'O return precisa devolver `latestDayDate`, que é quem diz QUAL dia o estado corrente está medindo.',
  );
});

test('o cron de cinco minutos coleta o dia corrente', () => {
  // O balde da CONTA só fecha depois que o dia acaba no fuso dela, então "hoje"
  // nunca vem por ali: a única fonte é `collectToday`, que soma os insights dos
  // posts publicados no dia. Este despacho é o que roda de 5 em 5 minutos e não
  // passava a opção — 288 das 290 passadas diárias não escreviam a linha de
  // hoje, e ela só existia quando uma rodada fatiada passava.
  const chamada = bloco(
    ler('app/api/internal/meta-analytics-dispatch/route.ts'),
    'runMetaAnalyticsRefresh({',
    '});',
  );

  assert.ok(
    chamada.includes('\n      collectToday,\n'),
    'O despacho da Meta precisa passar `collectToday`, senão a dashboard fica sem a linha do dia corrente entre uma rodada fatiada e outra.',
  );
});
