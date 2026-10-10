/**
 * Trava da troca de grupo: perfil com fila aberta não é movido (decisão do dono
 * em 10/10/2026). A fila de plano em massa pertence ao perfil, não ao grupo; um
 * perfil que chega com reels agendados a um grupo com a postagem contínua ligada
 * postaria os dois. A conferência é por perfil — quem está parado passa mesmo
 * que o resto do grupo de origem esteja rodando.
 *
 * As linhas vêm de `get_profiles_with_open_publication_queue` (migration 444),
 * que só devolve perfil com fila: item aberto que não é de postagem contínua, ou
 * reserva de horizonte ativa.
 */
export type OpenQueueRow = {
  profile_id: string;
  open_items: number | string | null;
  active_horizons: number | string | null;
};

export function splitProfilesByOpenQueue(profileIds: string[], rows: OpenQueueRow[] | null | undefined) {
  const openItemsByProfile = new Map<string, number>();
  for (const row of rows ?? []) {
    openItemsByProfile.set(row.profile_id, Number(row.open_items ?? 0));
  }
  const blockedProfileIds = profileIds.filter((id) => openItemsByProfile.has(id));
  const movableProfileIds = profileIds.filter((id) => !openItemsByProfile.has(id));
  const blockedOpenItems = blockedProfileIds.reduce((total, id) => total + (openItemsByProfile.get(id) ?? 0), 0);
  return { blockedProfileIds, movableProfileIds, blockedOpenItems };
}

/** Frase para quando nenhum perfil do pedido pôde ser movido. */
export function describeBlockedMove(blockedCount: number, requestedCount: number, blockedOpenItems: number) {
  const queue = blockedOpenItems > 0
    ? `${blockedOpenItems.toLocaleString('pt-BR')} post(s) na fila`
    : 'plano em massa ativo';
  if (requestedCount === 1) {
    return `Este perfil ainda tem fila aberta (${queue}). Cancele a fila dele antes de mover.`;
  }
  return `Nenhum perfil foi movido: os ${blockedCount} selecionados ainda têm fila aberta (${queue}). Cancele a fila deles antes de mover.`;
}
