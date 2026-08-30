// Sinal de pressão global (RPC get_publication_generation_pressure_signal) e as regras de
// quando um consumidor deve ceder a ele. Compartilhado entre publication-worker.mjs (staging)
// e publication-generation-worker.mjs (geração em massa) — os dois podem entrar no mesmo tipo
// de laço fechado se cederem incondicionalmente a um atraso que só eles mesmos resolvem
// (ver plans/plano-correcao-deadlock-staging-criticaldelay-2026-08-28.md).

export async function loadPublicationPressureSignal(supabase, criticalDelaySeconds) {
  const { data, error } = await supabase.rpc('get_publication_generation_pressure_signal', {
    p_critical_delay_seconds: criticalDelaySeconds,
  });
  if (error) throw error;
  return {
    criticalDelay: data?.criticalDelay === true,
    // null quando a migração 319 ainda não foi aplicada remotamente (RPC antiga não devolve
    // esses campos) — shouldYieldToPublicationPressure trata null como "desconhecido" e cai
    // de volta no comportamento anterior (ceder sempre), nunca assume falso.
    overdueAccepted: typeof data?.overdueAccepted === 'boolean' ? data.overdueAccepted : null,
    overdueUnstarted: typeof data?.overdueUnstarted === 'boolean' ? data.overdueUnstarted : null,
    oldestDueAt: typeof data?.oldestDueAt === 'string' ? data.oldestDueAt : null,
    checkedAt: typeof data?.checkedAt === 'string' ? data.checkedAt : new Date().toISOString(),
  };
}

// Um consumidor (staging, geração em massa, ...) só deve ceder ao atraso crítico quando ele é
// de itens JÁ ACEITOS pelo provedor (competindo por capacidade de despacho — ceder faz
// sentido). Quando o atraso é só de itens NÃO INICIADOS, o próprio consumidor costuma ser a
// única fase capaz de resolvê-lo; ceder incondicionalmente cria um laço fechado (nunca roda
// porque o atraso nunca some, e o atraso nunca some porque nunca roda). Sinal antigo/ambíguo
// (overdueAccepted desconhecido) mantém o comportamento anterior.
// `resolvesUnstarted` diz se QUEM PERGUNTA e a fase capaz de destravar itens
// atrasados e nao iniciados:
//   * staging  -> true  (e ele quem prepara o envelope; sem isso o item nunca sai)
//   * geracao  -> false (cria trabalho FUTURO; nao resolve atraso nenhum, e
//                        competir com a publicacao do momento presente e
//                        exatamente o que nao se quer)
// A regra e a mesma; o papel de cada consumidor e que muda.
export function shouldYieldToPublicationPressure(pressure, { resolvesUnstarted = false } = {}) {
  if (!pressure || pressure.criticalDelay !== true) return false;
  if (pressure.overdueAccepted === null || pressure.overdueAccepted === undefined) return true;
  if (pressure.overdueAccepted !== true) return false;
  // MEDIDO EM PRODUCAO (30/08/2026): o log mostrou `overdueAccepted: true` E
  // `overdueUnstarted: true` ao mesmo tempo, com oldestDueAt de 17 a 23 minutos
  // atras, e o teto de seguranca sendo acionado repetidamente
  // (forcedThroughCriticalDelayCount saiu de 0). Consequencia medida na noite:
  // espera na fila p99 de 949s para 2.327s.
  //
  // A versao anterior so olhava `overdueAccepted`, e portanto cedia sempre que
  // houvesse QUALQUER item aceito atrasado - mesmo havendo itens NAO INICIADOS
  // atrasados junto. Mas item nao iniciado so sai do lugar pelo staging: ceder
  // ali alimenta o proprio atraso, que e o laco fechado que este arquivo diz,
  // no comentario acima, existir para evitar. O comentario dizia "SO de itens
  // nao iniciados"; o codigo nunca checou o "so".
  //
  // Ceder continua certo quando o atraso e PURAMENTE de itens ja aceitos: ai o
  // gargalo e o provedor, e preparar mais envelopes nao ajuda ninguem.
  if (resolvesUnstarted && pressure.overdueUnstarted === true) return false;
  return true;
}

// Rede de segurança independente da distinção acima: se um consumidor ficar preso cedendo ao
// atraso crítico por tempo demais, força uma tentativa mesmo assim. Protege contra qualquer
// variante futura do mesmo tipo de laço fechado (ex.: um erro na classificação acima).
export function shouldForceThroughPublicationPressure(streakStartedAt, now, thresholdMs) {
  if (streakStartedAt == null) return false;
  return now - streakStartedAt >= thresholdMs;
}
