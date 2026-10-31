/**
 * Regras de capacidade e de escrita em massa dos apps próprios da Meta.
 *
 * Um app da Meta comporta um número fixo de contas (100 por padrão). Diferente
 * da Zernio, aqui não existe inventário remoto para consultar: quem sabe da
 * ocupação é o próprio Athena. Por isso a contagem pode recusar de imediato um
 * pedido maior que a vaga — em vez de entregar uma lista menor e deixar o
 * operador descobrir a falta no meio da operação, como acontece na régua da
 * Zernio.
 *
 * Só que "o Athena sabe" não é o mesmo que "o Athena contava". Até 05/09/2026 a
 * ocupação era só o número de perfis ativos, e um perfil derrubado pela Meta
 * saía dessa conta no instante da queda. No painel da Meta ele continuava lá: a
 * conexão só some quando alguém a apaga à mão, e a Graph API não expõe essa
 * lista para conferirmos sozinhos. Eram 512 vagas fantasma em 28 apps, com
 * NOVE apps lotados aparecendo com 2 a 27 vagas livres — e cada vaga fantasma
 * virava um celular apontado para um app sem espaço.
 *
 * Daí a ocupação ter duas parcelas: os perfis que publicam e as quedas ainda
 * não confirmadas em /meta. A vaga presa só volta quando o operador diz que
 * apagou a conexão no Meta Developers.
 */

export const META_APP_DEFAULT_SLOT_LIMIT = 100;

/**
 * Projeção lida pelas telas. Fica aqui, e não no route handler, porque o Next
 * proíbe exportar qualquer coisa além dos handlers de um arquivo de rota.
 */
export const META_APP_SAFE_COLUMNS =
  'id, organization_id, label, app_id, instagram_slot_limit, active, last_connected_at, instagram_profile_count, pending_slot_release_count, transferred_out_count, api_blocked_at, api_block_until, api_block_error_message, api_block_kind, api_block_window_count, api_block_ignored_count, api_last_unblocked_at, auth_mode, created_at, updated_at';

export type NamedMetaApp = {
  id: string;
  label: string;
  app_id: string;
  active: boolean;
  instagram_slot_limit: number | null;
  instagram_profile_count: number | null;
  /**
   * Quedas registradas neste app que ainda não foram confirmadas em /meta.
   * Obrigatório de propósito: quem esquecer de trazer a coluna não recebe zero
   * em silêncio — recebe erro de tipo. Zero aqui é a diferença entre "app com
   * 13 vagas" e "app lotado", e foi ela que mandou celular para app sem espaço.
   */
  pending_slot_release_count: number | null;
  /**
   * Perfis que SAIRAM deste app para outro e cuja conexao ainda nao foi apagada
   * no Meta Developers. Mesma natureza da vaga presa acima, outra causa: aqui a
   * conta nao caiu, foi movida. Ver migration 399.
   */
  transferred_out_count: number | null;
  /**
   * Fim da janela de bloqueio de API. No futuro = app fechado pela Meta agora,
   * e nenhum perfil dele publica. Nulo ou no passado = sem bloqueio ativo.
   */
  api_block_until?: string | null;
};

export type NamedProfileGroup = {
  id: string;
  name: string;
};

export type MetaAppCapacity = {
  slotLimit: number;
  /** Perfis vivos, que ainda publicam por este app. */
  activeProfiles: number;
  /**
   * Quedas ainda não confirmadas: o Athena já removeu o perfil, mas a conexão
   * segue ocupando o app no painel da Meta até alguém apagá-la lá.
   */
  trappedSlots: number;
  /** O que a Meta enxerga como ocupado: perfis vivos + vagas presas. */
  usedSlots: number;
  freeSlots: number;
  /** A Meta fechou a API deste app e a janela de bloqueio ainda está aberta. */
  apiBlocked: boolean;
  /** Só um app ativo, com vaga e sem bloqueio pode receber conexão nova. */
  connectable: boolean;
};

/**
 * "Bloqueado agora" e a janela ainda aberta, nao uma flag guardada.
 *
 * A janela expira sozinha e e isso que faz a fila voltar a testar o app sem
 * nenhuma sonda. Por isso a pergunta e feita ao relogio, e nao a um booleano
 * que alguem precisaria lembrar de limpar.
 */
export function isMetaAppApiBlockedNow(app: { api_block_until?: string | null }, now = Date.now()) {
  if (!app.api_block_until) return false;
  const until = Date.parse(app.api_block_until);
  return Number.isFinite(until) && until > now;
}

export function metaAppCapacity(app: NamedMetaApp): MetaAppCapacity {
  const slotLimit = Math.max(0, app.instagram_slot_limit ?? META_APP_DEFAULT_SLOT_LIMIT);
  const activeProfiles = Math.max(0, app.instagram_profile_count ?? 0);
  // Queda e transferencia produzem a MESMA vaga fantasma: nos dois casos o
  // perfil sumiu da contagem do Athena e a conexao continua no painel da Meta.
  // Somar as duas e o que impede a tela de oferecer vaga que nao existe.
  const trappedSlots = Math.max(0, app.pending_slot_release_count ?? 0)
    + Math.max(0, app.transferred_out_count ?? 0);
  // Sem teto no limite: um app com 96 ativos e 13 quedas está com 109 conexões
  // no painel da Meta, e esconder isso atrás de "100/100" apagaria justamente o
  // tamanho do estrago. `freeSlots` já não fica negativo.
  const usedSlots = activeProfiles + trappedSlots;
  const freeSlots = Math.max(0, slotLimit - usedSlots);

  return {
    slotLimit,
    activeProfiles,
    trappedSlots,
    usedSlots,
    freeSlots,
    // App com API bloqueada nao recebe conexao: mandar uma conta para dentro
    // dele agora e garantir que ela nao publique. Ver migration 392.
    apiBlocked: isMetaAppApiBlockedNow(app),
    connectable: app.active && freeSlots > 0 && !isMetaAppApiBlockedNow(app),
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

/**
 * A ordem alfabética usada quando o critério é achar um app pelo nome.
 *
 * `numeric` mantém “BIEL 2” antes de “BIEL 10”, que é como o operador lê os
 * nomes numerados da planilha; sem ela a ordem seria a de string pura e “10”
 * viria antes de “2”.
 */
function compareLabel(first: NamedMetaApp, second: NamedMetaApp) {
  return first.label.localeCompare(second.label, 'pt-BR', { numeric: true, sensitivity: 'base' });
}

/**
 * Ordena por nome para quem precisa achar um app específico na lista, e não
 * receber a sugestão de qual preencher.
 */
export function sortMetaAppsByLabel<T extends NamedMetaApp>(apps: T[]) {
  return [...apps].sort(compareLabel);
}

/**
 * Ordem da tela de controle: primeiro quem tem trabalho pendente.
 *
 * Os apps com conta caída sobem, os sem descem, e dentro de cada bloco a ordem
 * é alfabética. É diferente da ordem de preenchimento de propósito: lá a
 * pergunta é “onde conecto o próximo celular”, aqui é “qual app eu abro agora
 * no Meta Developers”. Com 28 apps e a limpeza feita em várias sessões, uma
 * lista ordenada por vaga livre obrigava a caçar de novo, do zero, onde a
 * pessoa tinha parado.
 */
export function sortMetaAppsByPendingRemoval<T extends NamedMetaApp>(apps: T[]) {
  return [...apps].sort((first, second) => {
    const firstPending = (first.pending_slot_release_count ?? 0) > 0;
    const secondPending = (second.pending_slot_release_count ?? 0) > 0;

    // Só a PRESENÇA de queda separa os blocos, não a quantidade: um app com 63
    // e outro com 1 estão os dois na mesma situação — têm o que limpar —, e
    // ordenar por volume quebraria o alfabeto que faz a lista ser percorrível.
    if (firstPending !== secondPending) return firstPending ? -1 : 1;
    return compareLabel(first, second);
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

export type MetaAppMatchStatus = 'empty' | 'found' | 'missing' | 'duplicate' | 'inactive' | 'api_blocked' | 'full';
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
        // Antes da vaga, pela mesma razão de `buildBulkMetaRows`: o app
        // bloqueado e vazio parece o melhor destino e é o pior. Sem isto a tela
        // montaria o link de conexão e só o servidor recusaria, depois de a
        // pessoa já ter clicado.
        : capacity && capacity.apiBlocked
          ? 'api_blocked'
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
  | 'api_blocked'
  | 'app_full'
  | 'insufficient_slots';

export type MetaBulkPlan = {
  rows: string[];
  requested: number;
  freeSlots: number;
  slotLimit: number;
  usedSlots: number;
  /** Parcela de `usedSlots` que some assim que a limpeza for confirmada em /meta. */
  trappedSlots: number;
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
    trappedSlots: capacity?.trappedSlots ?? 0,
    text: '',
  };

  if (!app || !capacity) return { ...empty, blocked: true, reason: 'no_app_selected' };
  if (requested === 0) return { ...empty, blocked: true, reason: 'invalid_quantity' };
  if (!app.active) return { ...empty, blocked: true, reason: 'inactive_app' };
  // Antes da vaga: um app com a API bloqueada pela Meta pode estar vazio e
  // ainda assim ser o pior destino possível — a conta entraria e não
  // publicaria. Ver migration 392.
  if (capacity.apiBlocked) return { ...empty, blocked: true, reason: 'api_blocked' };
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
    trappedSlots: capacity.trappedSlots,
    blocked: false,
    reason: 'ok',
    text: rows.join('\n'),
  };
}

/**
 * Explica a recusa dizendo o que dá para fazer a respeito.
 *
 * Vaga presa ganha frase própria porque o desfecho é outro: "cadastre outro
 * app" não serve para quem tem 13 vagas esperando uma limpeza no Meta
 * Developers. Sem essa distinção, a tela mandaria criar app novo em cima de
 * espaço que já existe.
 */
export function metaBulkPlanMessage(plan: MetaBulkPlan, appLabel: string | null) {
  const name = appLabel ? `“${appLabel}”` : 'o app selecionado';
  const trapped = plan.trappedSlots > 0
    ? ` ${plan.trappedSlots} vaga(s) estão presas em quedas ainda não confirmadas: apague essas conexões no Meta Developers e confirme em /meta para liberá-las.`
    : '';

  switch (plan.reason) {
    case 'no_app_selected':
      return 'Escolha um app da Meta cadastrado para gerar a lista.';
    case 'invalid_quantity':
      return 'Informe uma quantidade maior que zero.';
    case 'inactive_app':
      return `O app ${name} está desativado e não recebe conexões novas.`;
    case 'app_full':
      return `O app ${name} está com as ${plan.slotLimit} vagas ocupadas.${trapped || ' Cadastre outro app da Meta.'}`;
    case 'insufficient_slots':
      return `Não há vaga para essa API: ${name} tem ${plan.freeSlots} vaga(s) livre(s) e você pediu ${plan.requested}.${trapped}`;
    default:
      return `${plan.rows.length} linha(s) prontas. Restarão ${plan.freeSlots - plan.rows.length} vaga(s) em ${name} depois dessas conexões.${trapped}`;
  }
}
