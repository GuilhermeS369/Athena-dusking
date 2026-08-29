import type { PostgrestError } from '@supabase/supabase-js';

const DEFAULT_PAGE_SIZE = 1000;

/**
 * PostgREST caps unpaginated selects at a fixed row count (1000 by default).
 * Organizations that pass that threshold silently get a truncated, order-dependent
 * slice back — counts and lists built from it are wrong, not just incomplete.
 * Use this for any top-level select whose row count scales with org size.
 */
export async function fetchAllRows<Row>(
  buildPage: (rangeFrom: number, rangeTo: number) => PromiseLike<{ data: Row[] | null; error: PostgrestError | null }>,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<{ data: Row[]; error: PostgrestError | null }> {
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
