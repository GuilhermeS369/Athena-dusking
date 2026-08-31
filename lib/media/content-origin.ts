/**
 * Mídia comum ou reprocessada, deduzida do nome do arquivo.
 *
 * **Por que o nome do arquivo, e não um campo que alguém preenche.** A marca
 * não depende da memória de ninguém: ela sai da própria ferramenta que gera o
 * vídeo. Levantamento do acervo real em 31/08/2026 (917 mídias da organização):
 *
 *   video_final_#_#_camuflado.mp4      156
 *   video_conjunto_#_#_camuflado.mp4    45
 *   V#_espelhado.mp4                     4
 *   ------------------------------------ 205 de 917 (22%)
 *
 * O restante é saída crua de baixador — `conta_1784896590_3948319961810165546_71479571452.mp4` —
 * que é mídia fresca, não reprocessada.
 *
 * Sem esse campo não há como ler o experimento de recuperação depois: ele é o
 * que separa "melhorou porque foi reprocessada" de "melhorou porque era nova".
 *
 * **Se a ferramenta mudar de nomenclatura, é aqui que se acrescenta.** Um
 * marcador novo entra na lista e o backfill reclassifica o histórico.
 */

export type MediaContentOrigin = 'common' | 'reprocessed';

/**
 * Marcadores de reprocessamento observados no acervo. São comparados sem
 * acento e sem caixa, e como *radical* — `camuflad` pega "camuflado",
 * "camuflada" e "camuflados" sem precisar de três entradas.
 */
export const REPROCESSED_NAME_MARKERS = [
  'camuflad',   // saída da ferramenta de camuflagem (201 arquivos em 04–07/08/2026)
  'espelhad',   // espelhamento horizontal, mesma finalidade (4 arquivos)
] as const;

function normalize(value: string) {
  return value
    .normalize('NFD')
    // Tira acentos: "espelhádo" e "espelhado" têm de bater no mesmo radical.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function isReprocessedFileName(originalName: string | null | undefined): boolean {
  if (!originalName) return false;
  const name = normalize(originalName);
  return REPROCESSED_NAME_MARKERS.some((marker) => name.includes(marker));
}

export function contentOriginFromFileName(
  originalName: string | null | undefined,
): MediaContentOrigin {
  return isReprocessedFileName(originalName) ? 'reprocessed' : 'common';
}
