/**
 * Regras de capacidade e de escrita em massa dos apps próprios da Meta.
 *
 * Um app da Meta comporta um número fixo de contas (100 por padrão). Diferente
 * da Zernio, aqui não existe inventário remoto para consultar: a ocupação é
 * exatamente a quantidade de perfis ativos que entraram por aquele app, um
 * número que o próprio Athena controla. Por isso a contagem é confiável e o
 * Bulk Meta pode recusar de imediato um pedido maior que a vaga — em vez de
 * entregar uma lista menor e deixar o operador descobrir a falta no meio da
 * operação, como acontece na régua da Zernio.
 */

export const META_APP_DEFAULT_SLOT_LIMIT = 100;

/**
 * Projeção lida pelas telas. Fica aqui, e não no route handler, porque o Next
 * proíbe exportar qualquer coisa além dos handlers de um arquivo de rota.
 */
export const META_APP_SAFE_COLUMNS =
  'id, organization_id, label, app_id, instagram_slot_limit, active, last_connected_at, instagram_profile_count, created_at, updated_at';

export type NamedMetaApp = {
  id: string;
  label: string;
  app_id: string;
  active: boolean;
  instagram_slot_limit: number | null;
  instagram_profile_count: number | null;
};

export type NamedProfileGroup = {
  id: string;
  name: string;
};

export type MetaAppCapacity = {
  slotLimit: number;
  usedSlots: number;
  freeSlots: number;
  /** Só um app ativo e com vaga pode receber uma conexão nova. */
  connectable: boolean;
};

export function metaAppCapacity(app: NamedMetaApp): MetaAppCapacity {
  const slotLimit = Math.max(0, app.instagram_slot_limit ?? META_APP_DEFAULT_SLOT_LIMIT);
  const usedSlots = Math.max(0, app.instagram_profile_count ?? 0);
  const freeSlots = Math.max(0, slotLimit - usedSlots);

  return {
    slotLimit,
    usedSlots,
    freeSlots,
    connectable: app.active && freeSlots > 0,
  };
}

/**
 * Ordena para preencher um app de cada vez, e não espalhar contas por todos.
 * Entre os que ainda recebem conexão, o de menos vaga livre vem primeiro; apps
 * cheios ou desativados caem para o fim porque não servem para conectar.
 */
export function sortMetaAppsByFillOrder<T extends NamedMetaApp>(apps: T[]) {
  return [...apps].sort((first, second) => {
    const firstCapacity = metaAppCapacity(first);
    const secondCapacity = metaAppCapacity(second);

    if (firstCapacity.connectable !== secondCapacity.connectable) {
      return firstCapacity.connectable ? -1 : 1;
    }
    if (firstCapacity.freeSlots !== secondCapacity.freeSlots) {
      return firstCapacity.freeSlots - secondCapacity.freeSlots;
    }
    return first.label.localeCompare(second.label, 'pt-BR', { sensitivity: 'variant' });
  });
}

export type ParsedMetaBulkTarget =
  | { kind: 'empty'; appName: ''; groupName: null }
  | { kind: 'invalid_format'; appName: string; groupName: string | null }
  | { kind: 'valid'; appName: string; groupName: string | null };

/**
 * Interpreta exatamente `app` ou `app;grupo`.
 * Os nomes não são normalizados: caixa, acentos e espaços fazem parte do valor,
 * porque é isso que o operador colou da planilha.
 */
export function parseMetaBulkTarget(value: string): ParsedMetaBulkTarget {
  if (value.length === 0) return { kind: 'empty', appName: '', groupName: null };

  const parts = value.split(';');
  const appName = parts[0] ?? '';
  const groupName = parts.length >= 2 ? parts[1] : null;

  if (parts.length > 2 || appName.length === 0 || groupName === '') {
    return { kind: 'invalid_format', appName, groupName };
  }

  return { kind: 'valid', appName, groupName };
}

export type MetaAppMatchStatus = 'empty' | 'found' | 'missing' | 'duplicate' | 'inactive' | 'full';
export type MetaGroupMatchStatus = 'not_requested' | 'found' | 'missing' | 'duplicate' | 'invalid';

export type ResolvedMetaBulkTarget = {
  parsed: ParsedMetaBulkTarget;
  app: NamedMetaApp | null;
  group: NamedProfileGroup | null;
  appStatus: MetaAppMatchStatus;
  groupStatus: MetaGroupMatchStatus;
  valid: boolean;
};

export function resolveMetaBulkTarget(
  apps: NamedMetaApp[],
  groups: NamedProfileGroup[],
  value: string,
): ResolvedMetaBulkTarget {
  const parsed = parseMetaBulkTarget(value);

  if (parsed.kind === 'empty') {
    return {
      parsed,
      app: null,
      group: null,
      appStatus: 'empty',
      groupStatus: 'not_requested',
      valid: false,
    };
  }

  const appMatches = apps.filter((app) => app.label === parsed.appName);
  const matchedApp = appMatches.length === 1 ? appMatches[0] : null;
  const capacity = matchedApp ? metaAppCapacity(matchedApp) : null;
  const appStatus: MetaAppMatchStatus = appMatches.length > 1
    ? 'duplicate'
    : !matchedApp
      ? 'missing'
      : !matchedApp.active
        ? 'inactive'
        : capacity && capacity.freeSlots === 0
          ? 'full'
          : 'found';

  const groupMatches = parsed.groupName === null
    ? []
    : groups.filter((group) => group.name === parsed.groupName);
  const groupStatus: MetaGroupMatchStatus = parsed.kind === 'invalid_format'
    ? 'invalid'
    : parsed.groupName === null
      ? 'not_requested'
      : groupMatches.length === 1
        ? 'found'
        : groupMatches.length > 1
          ? 'duplicate'
          : 'missing';

  return {
    parsed,
    // O app segue exposto quando está cheio ou desativado: a tela precisa
    // dizer QUAL app foi encontrado para explicar por que ele não serve.
    app: matchedApp,
    group: groupStatus === 'found' ? groupMatches[0] : null,
    appStatus,
    groupStatus,
    valid: parsed.kind === 'valid'
      && appStatus === 'found'
      && (groupStatus === 'not_requested' || groupStatus === 'found'),
  };
}

export type MetaBulkPlanReason =
  | 'ok'
  | 'no_app_selected'
  | 'invalid_quantity'
  | 'inactive_app'
  | 'app_full'
  | 'insufficient_slots';

export type MetaBulkPlan = {
  rows: string[];
  requested: number;
  freeSlots: number;
  slotLimit: number;
  usedSlots: number;
  blocked: boolean;
  reason: MetaBulkPlanReason;
  text: string;
};

/**
 * Monta as linhas `app;grupo` para colar na planilha.
 *
 * A regra pedida explicitamente pela operação: pedir mais do que cabe não gera
 * nada. Dez vagas livres e um pedido de treze devolve zero linha e o motivo,
 * porque uma lista truncada em dez seria copiada sem ninguém reparar que três
 * celulares ficariam sem app.
 */
export function buildBulkMetaRows(
  app: NamedMetaApp | null,
  requestedQuantity: number,
  groupName: string | null = null,
): MetaBulkPlan {
  const requested = Math.max(
    0,
    Math.floor(Number.isFinite(requestedQuantity) ? requestedQuantity : 0),
  );
  const capacity = app ? metaAppCapacity(app) : null;
  const empty = {
    rows: [] as string[],
    requested,
    freeSlots: capacity?.freeSlots ?? 0,
    slotLimit: capacity?.slotLimit ?? 0,
    usedSlots: capacity?.usedSlots ?? 0,
    text: '',
  };

  if (!app || !capacity) return { ...empty, blocked: true, reason: 'no_app_selected' };
  if (requested === 0) return { ...empty, blocked: true, reason: 'invalid_quantity' };
  if (!app.active) return { ...empty, blocked: true, reason: 'inactive_app' };
  if (capacity.freeSlots === 0) return { ...empty, blocked: true, reason: 'app_full' };
  if (requested > capacity.freeSlots) return { ...empty, blocked: true, reason: 'insufficient_slots' };

  const line = groupName === null ? app.label : `${app.label};${groupName}`;
  const rows = Array.from({ length: requested }, () => line);

  return {
    rows,
    requested,
    freeSlots: capacity.freeSlots,
    slotLimit: capacity.slotLimit,
    usedSlots: capacity.usedSlots,
    blocked: false,
    reason: 'ok',
    text: rows.join('\n'),
  };
}

export function metaBulkPlanMessage(plan: MetaBulkPlan, appLabel: string | null) {
  const name = appLabel ? `“${appLabel}”` : 'o app selecionado';

  switch (plan.reason) {
    case 'no_app_selected':
      return 'Escolha um app da Meta cadastrado para gerar a lista.';
    case 'invalid_quantity':
      return 'Informe uma quantidade maior que zero.';
    case 'inactive_app':
      return `O app ${name} está desativado e não recebe conexões novas.`;
    case 'app_full':
      return `O app ${name} está com as ${plan.slotLimit} vagas ocupadas. Cadastre outro app da Meta.`;
    case 'insufficient_slots':
      return `Não há vaga para essa API: ${name} tem ${plan.freeSlots} vaga(s) livre(s) e você pediu ${plan.requested}.`;
    default:
      return `${plan.rows.length} linha(s) prontas. Restarão ${plan.freeSlots - plan.rows.length} vaga(s) em ${name} depois dessas conexões.`;
  }
}
