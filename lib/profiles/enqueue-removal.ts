import { isPublicationInfrastructureError } from '../publications/infrastructure-error.ts';
import {
  chunkProfileIdsForRemoval,
  profileRemovalChunkSize,
  type ProfileRemovalRow,
} from './bulk-removal.ts';

// Enfileiramento fatiado da remoção de perfis.
//
// POR QUE ISTO É UM MÓDULO COMPARTILHADO, e não uma cópia em cada rota: existem
// dois caminhos que enfileiram remoção a pedido de uma pessoa — o bulk-delete de
// `/perfis` e a exclusão de grupo com escopo `media_profiles`. O laço que eles
// precisam não é um `for` sobre fatias: é a partição ao meio quando uma fatia
// estoura o statement_timeout, mais a continuação por `remaining` quando o
// orçamento de parede da rota acaba. Duas cópias disso divergem, e a que
// divergir vai ser descoberta em produção, com perfis pela metade.
//
// O tamanho da fatia é uma ESTIMATIVA: `profileRemovalChunkSize` olha a média de
// itens de fila abertos, e o custo real depende também de quantos batches
// distintos esses itens tocam. Em 03/09/2026 a estimativa deu 11 perfis por
// chamada e a chamada morreu em 57014 sem enfileirar nada. A migration 362 tirou
// o trabalho inútil daquele caso; este laço é o que impede que a próxima
// estimativa errada volte a custar a operação inteira.
//
// Repetir uma fatia é inofensivo por construção: o incidente tem
// unique (organization_id, profile_id) e o job tem unique (incident_id), então a
// repetição volta como `already_queued` em vez de duplicar trabalho.

export type RemovalRpcError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

/**
 * Executa `enqueue_instagram_profile_removal` para uma fatia.
 *
 * Recebido como função em vez de um cliente Supabase para manter este módulo
 * livre de `next/headers` — é o que permite testá-lo com `node --test` sem subir
 * meio framework junto.
 */
export type RemovalEnqueueRpc = (profileIds: string[]) => Promise<{
  data: ProfileRemovalRow[] | null;
  error: RemovalRpcError | null;
}>;

export type EnqueueRemovalOptions = {
  profileIds: string[];
  /** Total de itens de fila abertos do conjunto inteiro, vindo do dry-run. */
  pendingItemCount: number;
  /** Orçamento de parede antes de devolver `remaining` para continuação. */
  budgetMs?: number;
  /** Injetável para teste; por padrão `Date.now`. */
  now?: () => number;
};

export type EnqueueRemovalOutcome = {
  rows: ProfileRemovalRow[];
  /** Ids que não chegaram a ser enfileirados — quem chamou repete com eles. */
  remaining: string[];
  chunkDurationsMs: number[];
  /** Quantas fatias precisaram ser partidas ao meio. Sinal de estimativa larga. */
  splits: number;
  /** Preenchido quando uma fatia falhou e o laço não teve como dividir mais. */
  error: RemovalRpcError | null;
};

export const DEFAULT_REMOVAL_BUDGET_MS = 45_000;

export async function enqueueProfileRemovalInChunks(
  callRpc: RemovalEnqueueRpc,
  options: EnqueueRemovalOptions,
): Promise<EnqueueRemovalOutcome> {
  const { profileIds, pendingItemCount } = options;
  const budgetMs = options.budgetMs ?? DEFAULT_REMOVAL_BUDGET_MS;
  const now = options.now ?? Date.now;

  const rows: ProfileRemovalRow[] = [];
  const chunkDurationsMs: number[] = [];
  let remaining: string[] = [];
  let splits = 0;
  let attempts = 0;

  if (!profileIds.length) {
    return { rows, remaining, chunkDurationsMs, splits, error: null };
  }

  // A fila é mutável de propósito: uma fatia que estoura o statement_timeout é
  // partida no meio e tentada de novo, em vez de derrubar a operação inteira.
  const queue = chunkProfileIdsForRemoval(
    profileIds,
    profileRemovalChunkSize(profileIds.length, pendingItemCount),
  );
  const startedAt = now();
  let index = 0;

  while (index < queue.length) {
    // A primeira fatia sempre roda: sair sem tentar nada devolveria "orçamento
    // esgotado" para uma operação que nem começou.
    if (attempts > 0 && now() - startedAt > budgetMs) {
      remaining = queue.slice(index).flat();
      break;
    }

    const chunk = queue[index];
    const chunkStartedAt = now();
    attempts += 1;
    const { data, error } = await callRpc(chunk);
    chunkDurationsMs.push(now() - chunkStartedAt);

    if (error) {
      // Erro de infraestrutura (timeout, deadlock, queda de conexão) numa fatia
      // com mais de um perfil é sinal de fatia grande demais, não de exclusão
      // impossível. Um perfil sozinho que ainda assim estoura é falha de verdade.
      if (isPublicationInfrastructureError(error) && chunk.length > 1) {
        const half = Math.ceil(chunk.length / 2);
        queue.splice(index, 1, chunk.slice(0, half), chunk.slice(half));
        splits += 1;
        continue;
      }
      return {
        rows,
        remaining: queue.slice(index).flat(),
        chunkDurationsMs,
        splits,
        error,
      };
    }

    rows.push(...(data ?? []));
    index += 1;
  }

  return { rows, remaining, chunkDurationsMs, splits, error: null };
}
