/**
 * Recorte por provedor das planilhas de grupos.
 *
 * A view `group_profile_export_rows` não tem coluna de provedor (e o rótulo de
 * "Conexão" não serve de substituto: sai nulo para viewer e para perfil sem
 * conta). O recorte é feito na rota, cruzando `profile_id` com os ids dos
 * perfis Zernio da organização.
 *
 * A regra é assimétrica de propósito: `zernio` = quem ESTÁ no conjunto,
 * `meta_official` = quem NÃO está. Assim toda linha cai em exatamente uma das
 * duas planilhas — um perfil que por qualquer motivo não apareça na leitura de
 * provedores fica na planilha normal em vez de sumir das duas.
 *
 * A linha de queda acompanha o provedor ATUAL do perfil, não o da época da
 * queda: é o mesmo critério que a tela usa para decidir em qual lista o perfil
 * aparece.
 */
export type GroupExportProvider = 'meta_official' | 'zernio';

export type GroupExportProviderParam =
  | { ok: true; provider: GroupExportProvider | null }
  | { ok: false };

/** Sem parâmetro = sem recorte (os dois provedores), como a rota sempre foi. */
export function parseGroupExportProvider(value: string | null): GroupExportProviderParam {
  if (value === null || value === '') return { ok: true, provider: null };
  if (value === 'meta_official' || value === 'zernio') return { ok: true, provider: value };
  return { ok: false };
}

export function filterExportRowsByProvider<Row extends { profile_id: string }>(
  rows: Row[],
  provider: GroupExportProvider | null,
  zernioProfileIds: ReadonlySet<string>,
): Row[] {
  if (provider === null) return rows;
  return rows.filter((row) => zernioProfileIds.has(row.profile_id) === (provider === 'zernio'));
}
