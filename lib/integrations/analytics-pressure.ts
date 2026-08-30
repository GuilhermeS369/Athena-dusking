// Pressão de publicação vista pelo analytics.
//
// O sinal `get_publication_generation_pressure_signal` é compartilhado com o
// staging e a geração de publicação, onde ceder faz sentido: são etapas da
// própria fila. O analytics não é etapa de nada da fila — ele só concorre por
// CPU do worker e pelo orçamento de chamadas da Zernio — mas até aqui cedia do
// mesmo jeito, e com o limiar de 60s.
//
// MEDIDO EM 30/08/2026 (duas janelas, e a diferença entre elas importa):
//
//   janela 03:00-14:00 UTC, 26.025 itens — sistema com uma regressão de staging
//   que a sessão da fila corrigiu ao longo do dia:
//     p50=200s · p75=418s · p90=1130s · p95=1290s · p99=2373s
//     minutos (de 660) com atraso crítico, por limiar:
//       60s → 657 (99%) · 300s → 635 (96%) · 600s → 591 (90%)
//       900s → 467 (71%) · 1200s → 191 (29%)
//
//   janela pós-correções, 1.253 itens (medição da sessão da fila; o intervalo
//   acumula mais de uma mudança dela, então não atribua a nenhuma isolada):
//     p50=162s · p75=208s · p90=399s · p95=439s · p99=572s · max=597s
//     60s → 93% do tempo · 300s → 21% · 600s e acima → 0%
//
// A primeira janela mostra por que a pausa incondicional é inaceitável: um job
// de 200 perfis levou 9h36 entre a primeira e a última coleta, sem uma única
// falha registrada. A segunda mostra que 1200s nunca dispararia num sistema
// saudável — seria código morto.
//
// Duas decisões daí:
//   1. o limiar do analytics é 600s: o máximo absoluto observado com a fila
//      saudável foi 597s, então degradar significa "pior do que qualquer coisa
//      já vista sã", e não "operação normal";
//   2. o resultado nunca é parada total — reduz a concorrência pela metade e
//      segue. Parar de vez continua disponível como válvula de escape por env,
//      caso a operação da fila peça.
//
// Nada nesta trilha escreve na fila de publicação nem altera a função de
// pressão; o consumo é somente leitura.

export type PublicationPressureSignal = {
  criticalDelay?: boolean;
  oldestDueAt?: string | null;
  overdueCurrent?: number;
  overdueAccepted?: boolean;
  overdueUnstarted?: boolean;
  checkedAt?: string;
};

export type AnalyticsPressureMode = 'full' | 'degraded' | 'paused';

export type AnalyticsPressureDecision = {
  mode: AnalyticsPressureMode;
  reason: string | null;
  concurrency: number;
  limit: number;
  criticalDelaySeconds: number;
  pressure: PublicationPressureSignal | null;
};

type PressureClient = {
  rpc: (name: string, params: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

function integerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function booleanEnv(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

export function analyticsPressureConfig() {
  return {
    // A função valida o intervalo [30, 3600]; o padrão do analytics é 10 min.
    criticalDelaySeconds: integerEnv('PROFILE_ANALYTICS_PRESSURE_CRITICAL_DELAY_SECONDS', 600, 30, 3600),
    // Fração da concorrência mantida sob pressão, em porcentagem. Metade evita
    // trocar "parado o tempo todo" por "rastejando o tempo todo".
    degradedPercent: integerEnv('PROFILE_ANALYTICS_PRESSURE_DEGRADED_PERCENT', 50, 10, 100),
    // Válvula de escape: restaura a pausa total caso a operação da fila peça.
    pauseEnabled: booleanEnv('PROFILE_ANALYTICS_PRESSURE_PAUSE_ENABLED', false),
    // Desliga a leitura do sinal por completo, se um dia ela deixar de valer.
    enabled: booleanEnv('PROFILE_ANALYTICS_PRESSURE_ENABLED', true),
  };
}

function degrade(value: number, percent: number) {
  // Piso de 1: degradar nunca pode virar parada disfarçada.
  return Math.max(1, Math.floor((value * percent) / 100));
}

export function decideAnalyticsPressure(input: {
  pressure: PublicationPressureSignal | null;
  concurrency: number;
  limit: number;
  config: ReturnType<typeof analyticsPressureConfig>;
}): AnalyticsPressureDecision {
  const { pressure, concurrency, limit, config } = input;
  const base = {
    concurrency,
    limit,
    criticalDelaySeconds: config.criticalDelaySeconds,
    pressure,
  };

  // Sem sinal utilizável (leitura desligada ou falha) o analytics segue: o
  // objetivo do guard nunca foi proteger o analytics de si mesmo.
  if (!pressure || pressure.criticalDelay !== true) return { ...base, mode: 'full', reason: null };

  if (config.pauseEnabled) {
    return { ...base, mode: 'paused', reason: 'critical_publication_delay', concurrency: 0, limit: 0 };
  }

  return {
    ...base,
    mode: 'degraded',
    reason: 'critical_publication_delay',
    concurrency: degrade(concurrency, config.degradedPercent),
    limit: degrade(limit, config.degradedPercent),
  };
}

export async function resolveAnalyticsPressure(client: PressureClient, input: {
  concurrency: number;
  limit: number;
}): Promise<AnalyticsPressureDecision> {
  const config = analyticsPressureConfig();
  if (!config.enabled) {
    return {
      mode: 'full',
      reason: 'pressure_check_disabled',
      concurrency: input.concurrency,
      limit: input.limit,
      criticalDelaySeconds: config.criticalDelaySeconds,
      pressure: null,
    };
  }

  const { data, error } = await client.rpc('get_publication_generation_pressure_signal', {
    p_critical_delay_seconds: config.criticalDelaySeconds,
  });
  if (error) throw error;

  return decideAnalyticsPressure({
    pressure: (data ?? null) as PublicationPressureSignal | null,
    concurrency: input.concurrency,
    limit: input.limit,
    config,
  });
}
