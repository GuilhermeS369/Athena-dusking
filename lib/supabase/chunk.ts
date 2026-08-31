import type { PostgrestError } from '@supabase/supabase-js';

import { fetchAllRows } from './paginate.ts';

/**
 * PostgREST recebe filtros `in.(...)` na URL de um GET. Uma lista de 1.000 UUIDs
 * gera ~37 KB de query string, acima do que o proxy aceita, e a resposta ainda
 * seria cortada pelo teto de linhas. Blocos pequenos resolvem os dois de uma vez.
 */
/**
 * ATENÇÃO ao mudar este número: ele está DUPLICADO em
 * scripts/workers/publication-worker.mjs, que chegou nos mesmos 200 de forma
 * independente, partindo do limite de header do gateway. Se ajustar aqui,
 * ajuste lá — a divergência não quebra nada de imediato, ela só faz um dos dois
 * deixar de valer o que o comentário diz que vale.
 *
 * O motivo da duplicação NÃO é o worker ser `.mjs`: a VPS roda Node v22.23.2 e
 * o type stripping nativo importaria este módulo sem problema hoje. O motivo é
 * o contrato — aquele worker não tem nenhuma dependência de TypeScript, e o
 * `engines` do package.json declara `node >=18.0.0`. Importar daqui criaria um
 * requisito novo de Node >= 22.6 para o publicador subir, e o modo de falha é o
 * pior possível: worker não sobe, publicação para.
 *
 * A duplicação termina quando o `engines` subir para >= 22.6, ou quando aquele
 * worker passar a rodar sob tsx. Aí importe daqui e apague o número de lá.
 */
export const DEFAULT_ID_CHUNK_SIZE = 200;

export function chunkIds<T>(ids: readonly T[], size = DEFAULT_ID_CHUNK_SIZE): T[][] {
  if (size < 1) throw new Error('O tamanho do bloco precisa ser maior que zero.');
  const chunks: T[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size) as T[]);
  }
  return chunks;
}

/**
 * Lê todas as linhas casadas por uma lista de ids, sem depender do tamanho da
 * lista nem do número de linhas por id. Cada bloco é paginado por
 * {@link fetchAllRows}, então relações 1:N (várias linhas por id) também são
 * seguras — desde que `buildPage` aplique uma ordem determinística.
 */
export async function fetchAllRowsByIds<Row>(
  ids: readonly string[],
  buildPage: (
    chunk: string[],
    rangeFrom: number,
    rangeTo: number,
  ) => PromiseLike<{ data: Row[] | null; error: PostgrestError | null }>,
  chunkSize = DEFAULT_ID_CHUNK_SIZE,
): Promise<{ data: Row[]; error: PostgrestError | null }> {
  const rows: Row[] = [];

  for (const chunk of chunkIds(ids, chunkSize)) {
    const { data, error } = await fetchAllRows<Row>((from, to) => buildPage(chunk, from, to));
    rows.push(...data);
    if (error) return { data: rows, error };
  }

  return { data: rows, error: null };
}

/**
 * Executa uma mutação (update/delete) em blocos de ids. Para na primeira falha e
 * devolve o erro junto do número de ids já processados, para que o chamador possa
 * relatar uma execução parcial em vez de fingir que nada aconteceu.
 */
export async function runInIdChunks(
  ids: readonly string[],
  run: (chunk: string[]) => PromiseLike<{ error: PostgrestError | null }>,
  chunkSize = DEFAULT_ID_CHUNK_SIZE,
): Promise<{ processed: number; error: PostgrestError | null }> {
  let processed = 0;

  for (const chunk of chunkIds(ids, chunkSize)) {
    const { error } = await run(chunk);
    if (error) return { processed, error };
    processed += chunk.length;
  }

  return { processed, error: null };
}
