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
  /**
   * Perfis do escopo com a situação de cada um. Opcional: sem a lista, os
   * avisos abaixo continuam exatamente como eram.
   */
  profiles?: Array<{ status: string }>;
}): DashboardCoverageNote[] {
  const { coverage, periodEndDate, todayDate } = input;
  if (!coverage) return [];

  const notes: DashboardCoverageNote[] = [];

  // A migração da Zernio para a API da Meta divide a frota em duas: quem já
  // reconectou publica, quem não reconectou não publica. Sem este aviso a
  // dashboard soma o histórico dos dois grupos e passa a impressão de uma
  // operação inteira em pé — foi exatamente a leitura errada que a tela
  // permitia em 04/09/2026, com 1.565 perfis no escopo e ~120 capazes de
  // publicar.
  //
  // O aviso NÃO filtra o histórico de propósito: as visualizações já
  // coletadas continuam valendo e somando. O que ele corrige é a leitura de
  // CAPACIDADE, que é o número em que a operação se planeja.
  const scoped = input.profiles;
  if (scoped && scoped.length > 0) {
    const offline = scoped.filter((profile) => profile.status !== 'online').length;
    if (offline > 0) {
      const online = scoped.length - offline;
      notes.push({
        tone: 'alert',
        message: `${online} de ${scoped.length} ${plural(scoped.length, 'perfil está', 'perfis estão')} online e ${plural(offline, 'publica', 'publicam')} agora. `
          + `${offline} ${plural(offline, 'aguarda', 'aguardam')} reconexão pela API da Meta — o histórico deles continua somando nos números acima, mas eles não publicam até serem reconectados.`,
      });
    }
  }
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
