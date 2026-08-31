/**
 * Veredito do acompanhamento da esteira.
 *
 * O índice é `vs_desde_a_medição ÷ mediana_da_origem_nos_mesmos_dias`, e o
 * corte reusa a **própria régua que condenou o perfil** — o que torna a saída
 * simétrica à entrada: acima do corte aberto (0,40) a régua não o pegaria mais.
 *
 * O cálculo canônico vive na RPC `refresh_recovery_cohort_observations`; o que
 * está aqui é a mesma classificação em TypeScript, para rótulo e ordenação na
 * tela, e para os casos de fronteira ficarem cobertos por teste.
 */

export const RECOVERY_VERDICTS = [
  "recovered",
  "partial",
  "not_recovered",
  "short_sample",
  "no_reference",
  "no_data",
] as const;

export type RecoveryVerdict = (typeof RECOVERY_VERDICTS)[number];

export const RECOVERY_VERDICT_LABELS: Record<RecoveryVerdict, string> = {
  recovered: "Recuperado",
  partial: "Parcial",
  not_recovered: "Não recuperou",
  short_sample: "Aguardando volume",
  no_reference: "Sem referência",
  no_data: "Sem dados",
};

export const RECOVERY_VERDICT_HINTS: Record<RecoveryVerdict, string> = {
  recovered: "Passou do corte aberto: a régua não o pegaria mais.",
  partial: "Saiu do corte apertado, mas ainda cairia no aberto.",
  not_recovered: "Continua abaixo do corte apertado.",
  short_sample:
    "Ainda não postou o suficiente para um veredito. A taxa de zerados é o termômetro deste período.",
  no_reference:
    "O grupo de origem não tem perfis suficientes no mesmo período para servir de comparação.",
  no_data: "Nenhum post medido desde o início da medição.",
};

/** Ordem de gravidade, para a tela pôr o que precisa de decisão no topo. */
export const RECOVERY_VERDICT_SEVERITY: Record<RecoveryVerdict, number> = {
  not_recovered: 0,
  partial: 1,
  recovered: 2,
  short_sample: 3,
  no_reference: 4,
  no_data: 5,
};

export type RecoveryVerdictInput = {
  postsSince: number | null | undefined;
  originMedianVs: number | null | undefined;
  originProfiles: number | null | undefined;
  recoveryIndex: number | null | undefined;
};

export type RecoveryVerdictThresholds = {
  recoveredIndex: number;
  partialIndex: number;
  minPosts: number;
  minOriginProfiles: number;
};

export const RECOVERY_VERDICT_THRESHOLDS: RecoveryVerdictThresholds = {
  recoveredIndex: 0.4,
  partialIndex: 0.25,
  minPosts: 30,
  minOriginProfiles: 5,
};

/**
 * A ordem das checagens importa: "não sei" vem antes de "ruim". Um perfil sem
 * post medido não é um perfil que falhou, e um grupo de origem sem referência
 * não autoriza veredito nenhum — dizer "não recuperou" nesses casos seria
 * mentir com cara de número.
 */
export function classifyRecoveryVerdict(
  input: RecoveryVerdictInput,
  thresholds: RecoveryVerdictThresholds = RECOVERY_VERDICT_THRESHOLDS,
): RecoveryVerdict {
  const posts = Number(input.postsSince ?? 0);
  if (!Number.isFinite(posts) || posts <= 0) return "no_data";

  const originMedian = Number(input.originMedianVs ?? 0);
  const originProfiles = Number(input.originProfiles ?? 0);
  if (!Number.isFinite(originMedian) || originMedian <= 0) return "no_reference";
  if (originProfiles < thresholds.minOriginProfiles) return "no_reference";

  if (posts < thresholds.minPosts) return "short_sample";

  const index = Number(input.recoveryIndex ?? Number.NaN);
  if (!Number.isFinite(index)) return "no_reference";

  if (index >= thresholds.recoveredIndex) return "recovered";
  if (index >= thresholds.partialIndex) return "partial";
  return "not_recovered";
}

export function isRecoveryVerdict(value: unknown): value is RecoveryVerdict {
  return RECOVERY_VERDICTS.includes(value as RecoveryVerdict);
}

/**
 * Formata a taxa de zerados junto do denominador. O denominador não é enfeite:
 * a Zernio devolve analytics de post em páginas de 25, então a taxa é sobre o
 * que foi medido, não sobre tudo que o perfil publicou — e "40% de zerados"
 * sobre 5 posts não é a mesma frase que sobre 60.
 */
export function formatZeroViewRate(
  zeroViewPosts: number | null | undefined,
  measuredPosts: number | null | undefined,
): string {
  const measured = Number(measuredPosts ?? 0);
  if (!Number.isFinite(measured) || measured <= 0) return "sem posts medidos";
  const zeros = Number(zeroViewPosts ?? 0);
  const percent = Math.round((zeros / measured) * 100);
  return `${percent}% (${measured} ${measured === 1 ? "post" : "posts"})`;
}
