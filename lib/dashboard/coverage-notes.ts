// Avisos de cobertura da dashboard de Análises.
//
// O aviso antigo era uma fração só: "598/1105 perfis com métricas". Ele mistura
// três situações que pedem reações opostas:
//   1. o perfil publicou e continua sem métrica  -> problema de coleta, nosso;
//   2. o perfil não publicou nada no período     -> nada a fazer;
//   3. o dia corrente ainda está maturando       -> esperar, não é falha.
//
// Medido em 30/08/2026 (organização Pomodoro, período "Hoje"): o aviso acendia
// como 598/1105 enquanto apenas uma parte era coleta pendente. No fim da tarde,
// com a coleta destravada, o mesmo período estava em 1051/1103 — e desses, só
// 10 perfis tinham publicado sem receber métrica; 42 simplesmente não
// publicaram. Uma fração única nunca vai distinguir esses dois grupos.
//
// Os campos novos (`profiles_with_publications`, `profiles_pending_collection`)
// vêm da migração 339. Enquanto ela não estiver aplicada eles chegam como
// undefined e o texto antigo continua valendo — a dashboard não quebra no
// intervalo entre o deploy do app e o da migração.

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

function plural(count: number, singular: string, pluralForm: string) {
  return count === 1 ? singular : pluralForm;
}

export function dashboardCoverageNotes(input: {
  coverage: DashboardCoverageSummary | null | undefined;
  periodEndDate: string;
  todayDate: string;
}): DashboardCoverageNote[] {
  const { coverage, periodEndDate, todayDate } = input;
  if (!coverage) return [];

  const notes: DashboardCoverageNote[] = [];
  const pending = coverage.profiles_pending_collection;
  const published = coverage.profiles_with_publications;
  const periodIncludesToday = periodEndDate === todayDate;

  if (typeof pending === 'number' && typeof published === 'number') {
    if (pending > 0) {
      notes.push({
        tone: 'alert',
        message: `${pending} ${plural(pending, 'perfil publicou', 'perfis publicaram')} neste período e ainda ${plural(pending, 'está', 'estão')} sem métrica. A coleta repete sozinha em alguns minutos.`,
      });
    }

    // Só vale mencionar quem não publicou quando isso de fato explica um vazio
    // na tela; caso contrário é ruído permanente para quem cadastra contas todo
    // dia.
    const withoutPublications = coverage.selected_profiles - published;
    if (withoutPublications > 0 && coverage.profiles_with_metrics < coverage.selected_profiles) {
      notes.push({
        tone: 'info',
        message: `${withoutPublications} de ${coverage.selected_profiles} ${plural(withoutPublications, 'perfil não publicou', 'perfis não publicaram')} no período — sem publicação não há métrica a exibir.`,
      });
    }
  } else if (
    coverage.profiles_with_metrics < coverage.selected_profiles
    || coverage.last_metric_date !== periodEndDate
  ) {
    // Sem a migração 339 aplicada, mantém o texto conhecido.
    notes.push({
      tone: 'info',
      message: `Cobertura parcial: ${coverage.profiles_with_metrics}/${coverage.selected_profiles} perfis com métricas; última data disponível ${coverage.last_metric_date ?? 'indisponível'}.`,
    });
  }

  if (periodIncludesToday) {
    notes.push({
      tone: 'info',
      message: 'As métricas de hoje sobem ao longo do dia: o Instagram leva horas para consolidar visualizações dos posts recentes. Para comparar desempenho, use os dias já fechados.',
    });
  } else if (coverage.last_metric_date && coverage.last_metric_date < periodEndDate) {
    notes.push({
      tone: 'alert',
      message: `Sem métrica coletada depois de ${coverage.last_metric_date} neste período.`,
    });
  }

  return notes;
}
