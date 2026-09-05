// Situação da cobertura da dashboard de Análises — em UMA linha, no máximo.
//
// POR QUE ISTO ENCOLHEU. Esta função já devolveu até seis avisos ao mesmo
// tempo, cada um virando uma tarja roxa empilhada acima dos filtros: capacidade
// da frota, coleta pendente, perfis sem publicação, "as métricas de hoje sobem
// ao longo do dia", cobertura parcial, e ainda o estado da atualização em
// curso. Seis mensagens não informam seis vezes mais — elas empurram os
// gráficos para fora da tela e treinam o operador a não ler nenhuma.
//
// A regra agora é: **um aviso por vez, e só quando houver ação possível.**
//
//   * "publicou e está sem métrica" -> é problema nosso, e some sozinho;
//   * "sem métrica nova depois de X" -> a coleta parou, e isso pede olhar;
//   * "não publicou nada no período" -> não é problema de ninguém. Saiu.
//   * "hoje ainda está consolidando" -> é permanente e previsível. Virou dica
//     no seletor de período, não tarja.
//
// A capacidade da frota (quantos perfis publicam agora) deixou de ser aviso e
// virou número fixo no cabeçalho: ela é verdade o tempo todo desde que a Zernio
// caiu, e o que é permanente não deve piscar como alarme. O histórico dos
// perfis que aguardam reconexão continua somando nos números da tela — o
// indicador fala de CAPACIDADE, não de histórico.

export type DashboardCoverageSummary = {
  selected_profiles: number;
  profiles_with_metrics: number;
  partial_profiles: number;
  first_metric_date: string | null;
  last_metric_date: string | null;
  profiles_with_publications?: number;
  profiles_pending_collection?: number;
};

export type DashboardCoverageNote = {
  tone: 'alert' | 'info';
  message: string;
};

export type DashboardCoverageStatus = {
  /** Quantos perfis do escopo publicam agora. `null` quando todos publicam. */
  capacity: { online: number; offline: number; total: number } | null;
  /** No máximo um aviso, e só quando existe algo a fazer a respeito. */
  note: DashboardCoverageNote | null;
};

function plural(count: number, singular: string, pluralForm: string) {
  return count === 1 ? singular : pluralForm;
}

export function dashboardCoverageStatus(input: {
  coverage: DashboardCoverageSummary | null | undefined;
  periodEndDate: string;
  todayDate: string;
  /** Perfis do escopo com a situação de cada um. */
  profiles?: Array<{ status: string }>;
}): DashboardCoverageStatus {
  const { coverage, periodEndDate, todayDate } = input;

  const scoped = input.profiles ?? [];
  const offline = scoped.filter((profile) => profile.status !== 'online').length;
  const capacity = scoped.length > 0 && offline > 0
    ? { online: scoped.length - offline, offline, total: scoped.length }
    : null;

  if (!coverage) return { capacity, note: null };

  const pending = coverage.profiles_pending_collection;

  // 1. Publicou e continua sem métrica: o único caso em que a coleta falhou de
  //    verdade. Ele se resolve sozinho, então o texto diz isso — senão vira
  //    chamado de suporte para algo que já está em andamento.
  if (typeof pending === 'number' && pending > 0) {
    return {
      capacity,
      note: {
        tone: 'alert',
        message: `${pending} ${plural(pending, 'perfil publicou', 'perfis publicaram')} e ainda ${plural(pending, 'está', 'estão')} sem métrica — a coleta repete sozinha em minutos.`,
      },
    };
  }

  // 2. O período não tem NENHUMA métrica. É diferente de "deu zero": zero é um
  //    número medido, e aqui não há medição. Sem este aviso a tela mostra 0
  //    visualizações para um dia com mil publicações, e quem lê conclui que os
  //    posts não performaram — foi exatamente a dúvida levantada em 05/09/2026.
  if (coverage.profiles_with_metrics === 0 && coverage.selected_profiles > 0) {
    return {
      capacity,
      note: {
        tone: 'info',
        message: periodEndDate === todayDate
          ? 'Ainda não há métrica coletada para hoje. Os números do dia entram conforme a Meta os devolve — não significa zero.'
          : 'Nenhuma métrica coletada neste período.',
      },
    };
  }

  // 3. Período já fechado e nenhuma métrica depois de certa data: a coleta
  //    parou. Este é o aviso que merece olhar humano.
  if (periodEndDate !== todayDate && coverage.last_metric_date && coverage.last_metric_date < periodEndDate) {
    return {
      capacity,
      note: {
        tone: 'alert',
        message: `Sem métrica coletada depois de ${coverage.last_metric_date} neste período.`,
      },
    };
  }

  return { capacity, note: null };
}

/**
 * Dica fixa do seletor de período. Não é aviso: é a explicação de por que o dia
 * corrente aparece menor do que vai terminar. Vive como `title`, onde quem tem
 * a dúvida encontra e quem não tem não esbarra.
 */
export const DASHBOARD_TODAY_HINT = 'As métricas de hoje sobem ao longo do dia: o Instagram leva horas para consolidar as visualizações dos posts recentes. Para comparar desempenho, use os dias já fechados.';
