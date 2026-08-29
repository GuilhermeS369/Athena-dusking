// Separação em blocos do painel de programação em massa.
//
// Fica aqui, e não no componente, por dois motivos: é lógica pura testável sem
// renderizar nada, e o runner de testes do Node não consegue importar .tsx.

export type BulkPlanGroup = 'waiting' | 'running' | 'attention' | 'finished' | 'hidden';

export type GroupableBulkPlan = {
  status: string;
  generatedPublications: string;
};

export function bulkPlanCount(value: string) {
  try {
    return Number(BigInt(value));
  } catch {
    return 0;
  }
}

export function groupOfBulkPlan(plan: GroupableBulkPlan): BulkPlanGroup {
  if (plan.status === 'cancelled') return 'hidden';
  if (plan.status === 'paused' || plan.status === 'failed') return 'attention';
  if (plan.status === 'completed' || plan.status === 'completed_with_errors') return 'finished';
  // O claim marca o plano como 'generating' assim que pega o primeiro pedaço,
  // antes de existir qualquer publicação. Mostrá-lo como "gerando" com 0% seria
  // enganoso: para quem olha, ele ainda não começou a produzir nada.
  if (plan.status === 'queued' || bulkPlanCount(plan.generatedPublications) === 0) return 'waiting';
  return 'running';
}
