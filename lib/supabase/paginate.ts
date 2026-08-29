import type { PostgrestError } from '@supabase/supabase-js';

/**
 * Teto de linhas que o PostgREST aplica a toda resposta da Data API — o
 * `max_rows` do projeto Supabase (Settings → API), espelhado em
 * [supabase/config.toml](../../supabase/config.toml). Nenhuma página pode ser
 * maior que ele; ver a guarda em fetchAllRows.
 */
export const POSTGREST_MAX_ROWS = 5000;

/**
 * Deliberadamente menor que o teto do servidor. Páginas de 1000 continuam
 * corretas se o `max_rows` for reduzido no futuro, e o custo de uma ida a mais
 * ao banco é irrelevante perto de reintroduzir truncamento silencioso.
 */
const DEFAULT_PAGE_SIZE = 1000;

/**
 * PostgREST caps unpaginated selects at a fixed row count (1000 by default).
 * Organizations that pass that threshold silently get a truncated, order-dependent
 * slice back — counts and lists built from it are wrong, not just incomplete.
 * Use this for any top-level select whose row count scales with org size.
 *
 * O chamador precisa aplicar uma `.order()` determinística junto do `.range()`:
 * sem ordem total, páginas consecutivas repetem linhas e perdem outras.
 */
export async function fetchAllRows<Row>(
  buildPage: (rangeFrom: number, rangeTo: number) => PromiseLike<{ data: Row[] | null; error: PostgrestError | null }>,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<{ data: Row[]; error: PostgrestError | null }> {
  // O laço para quando uma página volta com menos linhas do que pediu. Com
  // pageSize acima do teto do servidor, a primeira página volta cortada no teto,
  // o laço conclui que acabou e trunca em silêncio — exatamente o bug que este
  // helper existe para evitar, só que mais difícil de enxergar.
  if (pageSize > POSTGREST_MAX_ROWS) {
    throw new Error(
      `Página de ${pageSize} linhas excede o teto do PostgREST (${POSTGREST_MAX_ROWS}); a paginação truncaria em silêncio.`,
    );
  }
  if (pageSize < 1) throw new Error('O tamanho da página precisa ser maior que zero.');

  const rows: Row[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await buildPage(from, from + pageSize - 1);
    if (error) return { data: rows, error };
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return { data: rows, error: null };
}
