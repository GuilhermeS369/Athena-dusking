// Decide o que é indisponibilidade de infraestrutura — e portanto NUNCA pode
// virar falha terminal de publicação — e o que é erro real do item.
//
// POR QUE ISTO É UM MÓDULO COMPARTILHADO, e não uma cópia em cada despachante:
// existem dois caminhos de publicação, o worker da VPS
// (`scripts/workers/publication-direct-dispatch.mjs`) e o cron da Vercel
// (`lib/publications/dispatcher.ts`). Eles tinham catch-alls idênticos, mas só o
// worker ganhou a guarda de infraestrutura. O cron ficou sem nenhuma — o mesmo
// erro que o worker adiava por 30 s, o cron encerrava para sempre.
//
// A divergência não é hipotética: em 31/08/2026, entre 15:19 e 11:00 UTC do dia
// seguinte, uma queda de conexão com o Supabase encerrou 3.315 publicações em
// 946 perfis com `retryable: false` na primeira tentativa. Nenhuma voltou
// sozinha. `lib/publications/infrastructure-error.test.ts` compara esta
// implementação com a do worker caso a caso e falha se elas discordarem, para
// que a próxima correção não conserte um lado só.

const INFRASTRUCTURE_ERROR_CODES = new Set([
  '57014', '40001', '40p01', '53300', '57p01', '57p02', '57p03',
  'publication_worker_cycle_failed',
]);

const DATABASE_UNAVAILABLE = /statement timeout|canceling statement|deadlock detected|connection pool|database connection|supabase unavailable/;

// Assinaturas de falha de TRANSPORTE (undici/Node). São necessárias porque o
// supabase-js não propaga o TypeError original de uma queda de rede: ele entrega
// um objeto simples `{ message: 'TypeError: fetch failed', details, hint,
// code: '' }`, que não é instância de Error — então testar `instanceof
// TypeError` não alcança o caso que mais acontece.
const TRANSPORT_FAILURE = /fetch failed|und_err_|connecttimeouterror|headerstimeouterror|bodytimeouterror|socketerror|socket hang up|econnreset|econnrefused|etimedout|eai_again|enotfound|epipe/;

export function isPublicationInfrastructureError(error: unknown): boolean {
  if (error instanceof TypeError) return true;

  if (typeof error === 'string') {
    const text = error.toLowerCase();
    return DATABASE_UNAVAILABLE.test(text) || TRANSPORT_FAILURE.test(text);
  }

  if (!error || typeof error !== 'object') return false;

  const value = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  if (INFRASTRUCTURE_ERROR_CODES.has(String(value.code ?? '').trim().toLowerCase())) return true;

  const text = [value.message, value.details, value.hint]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .toLowerCase();

  return DATABASE_UNAVAILABLE.test(text) || TRANSPORT_FAILURE.test(text);
}
