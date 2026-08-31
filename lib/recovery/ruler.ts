/**
 * Constantes da régua de recuperação (Instagram).
 *
 * **A fonte de verdade é o banco, não este arquivo.** Os valores realmente
 * usados numa análise ficam copiados na linha de `recovery_analysis_runs`, e é
 * de lá que a tela deve ler o que exibir — cada snapshot carrega a régua com
 * que foi produzido. O que existe aqui são os rótulos e os *fallbacks* de
 * exibição, para a tela não quebrar antes da primeira execução.
 *
 * Nenhum limiar absoluto de views/slot aparece aqui, e nunca deve aparecer:
 * `M`, `MR` e o pico são recalculados a cada rodada, e copiar o número absoluto
 * é o erro que quebra a régua.
 */

/** Os dois ajustes do Filtro 1, lado a lado na tela. O Filtro 2 não tem ajuste. */
export const RECOVERY_ADJUSTMENTS = [0.25, 0.4] as const;
export type RecoveryAdjustment = (typeof RECOVERY_ADJUSTMENTS)[number];

export const DEFAULT_RECOVERY_ADJUSTMENT: RecoveryAdjustment = 0.25;

export function isRecoveryAdjustment(value: unknown): value is RecoveryAdjustment {
  return RECOVERY_ADJUSTMENTS.includes(value as RecoveryAdjustment);
}

/**
 * O ajuste do Filtro 1 é filtro de **cliente**: a resposta traz o superconjunto
 * de 40% etiquetado por severidade, e girar o botão só muda opacidade e
 * contagem. É o que permite comparar os dois cenários antes de transferir sem
 * disparar requisição nova.
 */
export function severityForAdjustment(adjustment: RecoveryAdjustment) {
  return adjustment === 0.25 ? "severe" : "any";
}

/** Fallbacks de exibição. Os valores reais vêm da execução. */
export const RECOVERY_DEFAULTS = {
  windowDays: 30,
  minPostsJudgeable: 60,
  recentWindowPosts: 60,
  neverStartedRatio: 0.25,
  neverStartedRatioAlt: 0.4,
  collapsedRatio: 0.25,
  healthGateRatio: 0.6,
  /** Acima disso a faixa de coleta atrasada acende. */
  stalenessWarnDays: 2,
} as const;

/** Rótulos dos dois níveis, na linguagem da análise. */
export const RECOVERY_REASON_LABELS = {
  never_started: "Nunca engrenou",
  collapsed: "Desabou",
} as const;

export type RecoveryReason = keyof typeof RECOVERY_REASON_LABELS;

export const RECOVERY_GROUP_STATUS_LABELS = {
  ok: "Analisado",
  gate_blocked: "Nível 2 desligado",
  insufficient_judgeable: "Amostra insuficiente",
  degenerate_median: "Mediana degenerada",
  no_metrics: "Sem métrica na janela",
  no_members: "Sem perfis",
  failed: "Falhou",
} as const;

export type RecoveryGroupStatus = keyof typeof RECOVERY_GROUP_STATUS_LABELS;

/**
 * Explicação de cada status para o operador. O `gate_blocked` é o que mais
 * precisa de contexto: não é erro, é a régua se calando de propósito.
 */
export const RECOVERY_GROUP_STATUS_HINTS: Record<RecoveryGroupStatus, string> = {
  ok: "A régua opinou sobre este grupo nos dois níveis.",
  gate_blocked:
    "A mediana recente do grupo está abaixo de 60% do pico. Aqui não dá para separar conta caindo de mídia queimando, então o Filtro 2 não opina.",
  insufficient_judgeable:
    "Julgáveis de menos para uma mediana confiável. A régua prefere não opinar a condenar por acaso.",
  degenerate_median:
    "A mediana do grupo é zero: mais da metade dos julgáveis não teve view. Sem referência, nenhum filtro roda.",
  no_metrics: "Nenhum perfil do grupo atingiu o mínimo de posts na janela.",
  no_members: "O grupo não tem perfis.",
  failed: "O cálculo deste grupo falhou. O restante da análise seguiu normalmente.",
};
