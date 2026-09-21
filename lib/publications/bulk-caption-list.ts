import { MAX_PUBLICATION_CAPTION_LENGTH } from './composer.ts';

/**
 * Lista de legendas do plano em massa (migration 437): o usuário cola várias
 * legendas inteiras separadas por `;` e cada post recebe uma delas, trocando a
 * cada post do perfil. A distribuição é feita no banco, pelo gerador; aqui mora
 * só a validação, que é a MESMA no navegador (ao vivo) e no servidor.
 *
 * Sem import de `node:` de propósito: este arquivo roda no navegador.
 *
 * Só o `;` comum (U+003B) separa. O `；` de largura cheia (U+FF1B), usado em
 * texto japonês, é parte da legenda — decisão para que legendas em japonês
 * nunca sejam cortadas no meio.
 */

export const BULK_CAPTION_LIST_SEPARATOR = ';';
export const MIN_BULK_CAPTION_VARIANTS = 2;
export const MAX_BULK_CAPTION_VARIANTS = 1_000;
/**
 * Teto da lista inteira, em unidades UTF-16. A lista viaja três vezes (revisão,
 * resposta da revisão e confirmação); 300 mil unidades de texto japonês dão
 * ~1,2 MB em JSON, bem abaixo dos 4,5 MB de corpo que a Vercel aceita.
 */
export const MAX_BULK_CAPTION_LIST_TOTAL_LENGTH = 300_000;

export type BulkCaptionList = {
  /** Legendas válidas, aparadas nas pontas; quebras de linha internas mantidas. */
  items: string[];
  /** Mensagens em português, na ordem em que aparecem no texto. Vazio = lista válida. */
  errors: string[];
  /** Maior legenda, em unidades UTF-16 (a mesma conta do contador de hoje). */
  longest: number;
  /** Soma das legendas, em unidades UTF-16. */
  total: number;
};

type Entry = { text: string; number: number; line: number | null };

function formatNumber(value: number) {
  return value.toLocaleString('pt-BR');
}

function where(entry: Entry) {
  return entry.line === null ? `Legenda ${entry.number}` : `Legenda ${entry.number} (linha ${entry.line})`;
}

function collectErrors(entries: Entry[]) {
  const errors: string[] = [];
  const firstByText = new Map<string, number>();
  let total = 0;
  let longest = 0;

  for (const entry of entries) {
    if (!entry.text) {
      errors.push(`${where(entry)} está vazia: há dois ";" seguidos ou um ";" sobrando.`);
      continue;
    }
    total += entry.text.length;
    longest = Math.max(longest, entry.text.length);
    if (entry.text.length > MAX_PUBLICATION_CAPTION_LENGTH) {
      errors.push(`${where(entry)} tem ${formatNumber(entry.text.length)} caracteres; o limite é ${formatNumber(MAX_PUBLICATION_CAPTION_LENGTH)}.`);
    }
    const first = firstByText.get(entry.text);
    if (first !== undefined) {
      errors.push(`Legendas ${first} e ${entry.number} são iguais.`);
    } else {
      firstByText.set(entry.text, entry.number);
    }
  }

  const count = entries.filter((entry) => entry.text).length;
  if (count < MIN_BULK_CAPTION_VARIANTS) {
    errors.push(`Cole pelo menos ${MIN_BULK_CAPTION_VARIANTS} legendas separadas por ";". Para uma só, use "Uma legenda para todos os posts".`);
  }
  if (count > MAX_BULK_CAPTION_VARIANTS) {
    errors.push(`O máximo é ${formatNumber(MAX_BULK_CAPTION_VARIANTS)} legendas; a lista tem ${formatNumber(count)}.`);
  }
  if (total > MAX_BULK_CAPTION_LIST_TOTAL_LENGTH) {
    errors.push(`A lista tem ${formatNumber(total)} caracteres; o máximo é ${formatNumber(MAX_BULK_CAPTION_LIST_TOTAL_LENGTH)}.`);
  }
  return { errors, total, longest };
}

/**
 * Separa o texto colado na caixa. Cada item é aparado nas pontas (espaços e
 * quebras de linha em volta do `;` não contam); um `;` no fim é ignorado, porque
 * é o jeito natural de colar uma lista. Qualquer outro item vazio é erro.
 */
function countLineBreaks(value: string) {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) === 10) count += 1;
  return count;
}

export function parseBulkCaptionList(text: string): BulkCaptionList {
  const segments = text.split(BULK_CAPTION_LIST_SEPARATOR);
  const entries: Entry[] = [];
  // Linha do começo do item atual. Conta andando junto com o texto (uma passada):
  // a caixa revalida a cada tecla e a lista pode ter 300 mil caracteres.
  let segmentStartLine = 1;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const trimmed = segment.trim();
    const leading = segment.length - segment.trimStart().length;
    // Linha onde o texto do item começa; item vazio aponta para onde está o ";".
    const segmentLineBreaks = countLineBreaks(segment);
    const line = trimmed ? segmentStartLine + countLineBreaks(segment.slice(0, leading)) : segmentStartLine + segmentLineBreaks;
    segmentStartLine += segmentLineBreaks;
    const isTrailing = index === segments.length - 1 && index > 0 && !trimmed;
    if (isTrailing) continue;
    entries.push({ text: trimmed, number: index + 1, line });
  }
  if (entries.length === 1 && !entries[0].text) entries.length = 0;
  const { errors, total, longest } = collectErrors(entries);
  return { items: entries.filter((entry) => entry.text).map((entry) => entry.text), errors, total, longest };
}

/**
 * Validação do servidor sobre a lista já separada que o navegador enviou. Não
 * separa de novo: o resultado de uma validação passa idêntico pela seguinte, o
 * que mantém a impressão digital da revisão estável entre revisar e confirmar.
 */
export function validateBulkCaptionVariants(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new RangeError('Lista de legendas inválida.');
  }
  const entries = (value as string[]).map((item, index) => ({ text: item.trim(), number: index + 1, line: null }));
  const { errors } = collectErrors(entries);
  if (errors.length) throw new RangeError(errors[0]);
  return entries.map((entry) => entry.text);
}
