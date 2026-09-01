import type { InstagramProfilesCatalogFilters } from './catalog.ts';

// Seleção em massa de perfis em /perfis.
//
// O catálogo é paginado por cursor: a tela nunca tem em mãos todos os perfis do
// filtro. Por isso "selecionar todos deste filtro" não pode virar uma lista de
// ids no cliente — seria baixar milhares de linhas só para contar. A seleção é
// representada como filtro + exceções, exatamente como manda
// plans/plano-otimizacao-forte-tela-perfis-instagram-2000-itens.md:
//
//   allFilterSelected = false → vale `selectedIds`
//   allFilterSelected = true  → vale "tudo que casa com o filtro", menos `excludedIds`
//
// A contagem exibida no modo filtro vem de `filteredTotal`, que o resumo do
// catálogo já devolve. Nenhum id trafega para contar.

export const BULK_PROFILE_DELETE_CONFIRMATION = 'EXCLUIR';

/** Teto de ids explícitos aceitos numa chamada. */
export const MAX_BULK_PROFILE_DELETE = 500;

/**
 * Teto do modo "todos deste filtro". Acima disso a rota recusa em vez de cortar:
 * uma exclusão truncada em silêncio é pior que uma recusa, porque parece completa.
 * Fica abaixo de POSTGREST_MAX_ROWS, que também clampa RPCs `returns table`.
 */
export const MAX_FILTER_PROFILE_DELETE = 2000;

export type ProfileSelectionState = {
  selectedIds: string[];
  allFilterSelected: boolean;
  excludedIds: string[];
};

export type ProfileRemovalOutcome = 'queued' | 'already_queued' | 'deleted_local' | 'skipped_not_found';

// Os nomes vêm prefixados do RPC: um OUT chamado `profile_id` sequestraria o
// `on conflict (organization_id, profile_id)` dentro da própria função.
export type ProfileRemovalRow = { removed_profile_id: string; removed_username: string | null; removed_outcome: ProfileRemovalOutcome };

export type ProfileRemovalPreview = {
  total: number;
  zernioCount: number;
  metaCount: number;
  alreadyQueued: number;
  connectionLabels: string[];
  pendingItemCount: number;
};

export const EMPTY_PROFILE_SELECTION: ProfileSelectionState = {
  selectedIds: [],
  allFilterSelected: false,
  excludedIds: [],
};

export function isProfileSelected(state: ProfileSelectionState, profileId: string) {
  return state.allFilterSelected
    ? !state.excludedIds.includes(profileId)
    : state.selectedIds.includes(profileId);
}

/**
 * Quantos perfis a ação vai atingir. No modo filtro o total vem do servidor, e
 * as desmarcações são subtraídas — nunca deixando o número negativo, porque
 * `filteredTotal` e as exceções podem ser observados em instantes diferentes.
 */
export function profileSelectionCount(state: ProfileSelectionState, filteredTotal: number) {
  if (!state.allFilterSelected) return state.selectedIds.length;
  return Math.max(0, filteredTotal - state.excludedIds.length);
}

export function toggleProfileSelection(
  state: ProfileSelectionState,
  profileId: string,
  checked: boolean,
): ProfileSelectionState {
  if (state.allFilterSelected) {
    return {
      ...state,
      excludedIds: checked
        ? state.excludedIds.filter((id) => id !== profileId)
        : state.excludedIds.includes(profileId) ? state.excludedIds : [...state.excludedIds, profileId],
    };
  }
  return {
    ...state,
    selectedIds: checked
      ? state.selectedIds.includes(profileId) ? state.selectedIds : [...state.selectedIds, profileId]
      : state.selectedIds.filter((id) => id !== profileId),
  };
}

/** Marca ou desmarca os perfis da página atual, preservando o resto da seleção. */
export function toggleVisibleProfiles(
  state: ProfileSelectionState,
  visibleIds: string[],
  checked: boolean,
): ProfileSelectionState {
  if (state.allFilterSelected) {
    return {
      ...state,
      excludedIds: checked
        ? state.excludedIds.filter((id) => !visibleIds.includes(id))
        : [...state.excludedIds, ...visibleIds.filter((id) => !state.excludedIds.includes(id))],
    };
  }
  return {
    ...state,
    selectedIds: checked
      ? [...state.selectedIds, ...visibleIds.filter((id) => !state.selectedIds.includes(id))]
      : state.selectedIds.filter((id) => !visibleIds.includes(id)),
  };
}

export function selectAllMatchingFilter(): ProfileSelectionState {
  return { selectedIds: [], allFilterSelected: true, excludedIds: [] };
}

export function clearProfileSelection(): ProfileSelectionState {
  return EMPTY_PROFILE_SELECTION;
}

export function visibleSelectionState(state: ProfileSelectionState, visibleIds: string[]) {
  if (!visibleIds.length) return { allSelected: false, someSelected: false };
  const selected = visibleIds.filter((id) => isProfileSelected(state, id)).length;
  return { allSelected: selected === visibleIds.length, someSelected: selected > 0 && selected < visibleIds.length };
}

export function isBulkDeleteConfirmed(value: string) {
  return value.trim().toUpperCase() === BULK_PROFILE_DELETE_CONFIRMATION;
}

export type BulkProfileDeleteRequest =
  | { profileIds: string[]; dryRun?: boolean; confirmation?: string }
  | { selectAllMatching: true; filters: Partial<InstagramProfilesCatalogFilters>; excludedIds: string[]; dryRun?: boolean; confirmation?: string };

export function buildBulkDeleteRequest(
  state: ProfileSelectionState,
  filters: Partial<InstagramProfilesCatalogFilters>,
  options: { dryRun?: boolean; confirmation?: string } = {},
): BulkProfileDeleteRequest {
  const extras = {
    ...(options.dryRun ? { dryRun: true as const } : {}),
    ...(options.confirmation ? { confirmation: options.confirmation } : {}),
  };
  return state.allFilterSelected
    ? { selectAllMatching: true, filters, excludedIds: state.excludedIds, ...extras }
    : { profileIds: state.selectedIds, ...extras };
}

export function summarizeRemovalRows(rows: ProfileRemovalRow[]) {
  const count = (outcome: ProfileRemovalOutcome) => rows.filter((row) => row.removed_outcome === outcome).length;
  return {
    queued: count('queued'),
    alreadyQueued: count('already_queued'),
    deletedLocal: count('deleted_local'),
    skipped: count('skipped_not_found'),
    // Perfis Zernio só saem da tela quando o worker confirma o DELETE remoto; os
    // locais já saíram. Só estes podem ser removidos da lista otimisticamente.
    removedNowIds: rows.filter((row) => row.removed_outcome === 'deleted_local').map((row) => row.removed_profile_id),
  };
}

export function describeRemovalResult(summary: ReturnType<typeof summarizeRemovalRows>) {
  const parts: string[] = [];
  if (summary.queued) parts.push(`${summary.queued} perfil(is) na fila de remoção da Zernio`);
  if (summary.alreadyQueued) parts.push(`${summary.alreadyQueued} já estava(m) na fila`);
  if (summary.deletedLocal) parts.push(`${summary.deletedLocal} excluído(s) imediatamente`);
  if (summary.skipped) parts.push(`${summary.skipped} ignorado(s) por não existir(em) mais`);
  return parts.length ? `${parts.join(' · ')}.` : 'Nenhum perfil foi alterado.';
}

// Fatiamento do enfileiramento -------------------------------------------------
//
// O custo de excluir perfis não cresce com o número de perfis, e sim com o
// número de itens de fila abertos que cada um carrega: a contenção marca cada
// item como 'ignored' e grava um `publication_item_events` por item — e cada um
// desses eventos dispara o trigger de observabilidade da migration 278, que faz
// três consultas e mais duas escritas por linha.
//
// Doze perfis com ~93 itens abertos cada somam 1.111 itens numa transação só.
// A migration 323 mediu o teto disso na prática: uma mutação em massa sobre
// publication_items abortou em ~8,8s, no statement_timeout do papel. A saída
// registrada na migration 324 vale igual aqui — "a única forma de fazer mais
// trabalho do que cabe em 8s é dividir em várias chamadas separadas, cada uma
// com seu próprio orçamento de tempo".
//
// Fatiar é seguro porque o enfileiramento é idempotente por construção: o
// incidente tem unique (organization_id, profile_id) e o job tem unique
// (incident_id), então repetir uma fatia devolve `already_queued` em vez de
// duplicar trabalho. Uma fatia que falhe não desfaz as anteriores.

/** Itens de fila que uma única chamada do RPC pode conter com folga. */
export const REMOVAL_ITEM_BUDGET_PER_CALL = 400;

/** Teto de perfis por chamada, para perfis sem nenhum item aberto. */
export const MAX_PROFILES_PER_REMOVAL_CALL = 25;

/**
 * Quantos perfis cabem numa chamada, a partir da média de itens abertos que o
 * dry-run já contou. `pendingItemCount` é do conjunto inteiro, não da fatia.
 */
export function profileRemovalChunkSize(profileCount: number, pendingItemCount: number) {
  if (profileCount <= 1) return 1;
  const averageItems = Math.max(1, Math.ceil(Math.max(0, pendingItemCount) / profileCount));
  const size = Math.floor(REMOVAL_ITEM_BUDGET_PER_CALL / averageItems);
  return Math.min(MAX_PROFILES_PER_REMOVAL_CALL, Math.max(1, size));
}

export function chunkProfileIdsForRemoval(profileIds: string[], size: number) {
  const step = Math.max(1, size);
  const chunks: string[][] = [];
  for (let index = 0; index < profileIds.length; index += step) {
    chunks.push(profileIds.slice(index, index + step));
  }
  return chunks;
}

/** Totais de uma resposta do bulk-delete, para somar continuações. */
export type RemovalTotals = {
  queued: number;
  alreadyQueued: number;
  deletedLocal: number;
  skipped: number;
  removedNowIds: string[];
};

export const EMPTY_REMOVAL_TOTALS: RemovalTotals = {
  queued: 0, alreadyQueued: 0, deletedLocal: 0, skipped: 0, removedNowIds: [],
};

/**
 * Soma uma resposta parcial ao acumulado. A rota devolve `remaining` quando o
 * orçamento de tempo acaba antes das fatias terminarem; quem chama repete com
 * esses ids e junta os totais aqui.
 */
export function accumulateRemovalTotals(totals: RemovalTotals, payload: Partial<RemovalTotals>): RemovalTotals {
  return {
    queued: totals.queued + (payload.queued ?? 0),
    alreadyQueued: totals.alreadyQueued + (payload.alreadyQueued ?? 0),
    deletedLocal: totals.deletedLocal + (payload.deletedLocal ?? 0),
    skipped: totals.skipped + (payload.skipped ?? 0),
    removedNowIds: [...totals.removedNowIds, ...(payload.removedNowIds ?? [])],
  };
}
