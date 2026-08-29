// Substitui lib/publications/bulk-horizon-status.ts.
//
// Aquele módulo reimplementava no front a janela móvel de 48h do gerador para
// derivar um status sintético `horizon_ready` ("Horizonte abastecido: próximas
// 48 horas prontas, reposição automática..."). A migration 328 removeu o
// horizonte: um plano agora é gerado até o fim, de uma vez. Não existe mais
// "abastecido até certa data" — ou o plano ainda tem chunk com trabalho pela
// frente, ou ele acabou.
//
// O que sobrou de útil é a contagem de chunks que ainda têm slots a materializar,
// usada pela UI para decidir se vale continuar consultando.

export type BulkOperationalChunk = {
  status: string;
  slotStart: string | number;
  slotCount: string | number;
  nextSlotIndex: string | number;
  retryExhaustedAt?: string | null;
};

export type BulkOperationalStatus = {
  status: string;
  eligibleChunks: number;
};

function integer(value: string | number) {
  try {
    return BigInt(value);
  } catch {
    return BigInt(0);
  }
}

export function deriveBulkOperationalStatus(input: {
  planStatus: string;
  chunks: BulkOperationalChunk[];
}): BulkOperationalStatus {
  if (input.planStatus !== 'generating') {
    return { status: input.planStatus, eligibleChunks: 0 };
  }

  let eligibleChunks = 0;
  for (const chunk of input.chunks) {
    if (!['queued', 'processing', 'failed'].includes(chunk.status) || chunk.retryExhaustedAt) continue;
    if (integer(chunk.nextSlotIndex) >= integer(chunk.slotStart) + integer(chunk.slotCount)) continue;
    eligibleChunks += 1;
  }

  return { status: input.planStatus, eligibleChunks };
}
