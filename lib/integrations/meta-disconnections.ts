/**
 * Quedas da Meta pendentes de limpeza no Meta Developers.
 *
 * O worker remove o perfil do Athena sozinho (erro 190 com checkpoint, regra em
 * `isMetaTerminalProfileDisconnection`), mas a conexão continua ocupando a vaga
 * no painel da Meta até alguém apagá-la lá — a Graph API não expõe a lista de
 * contas conectadas ao app, então não há como o Athena descobrir nem fazer isso
 * por conta própria. O que a tela consegue oferecer é a lista do que falta
 * apagar, por app, e o botão que registra a limpeza depois de feita.
 *
 * A ordenação é da queda mais recente para a mais antiga, a pedido da operação:
 * a fila de um app cresce por cima, e o que caiu agora é o que ainda está fresco
 * na cabeça de quem vai limpar. O desempate é por id porque uma leva inteira
 * compartilha o mesmo instante — 493 quedas num único dia em 05/09/2026, muitas
 * no mesmo segundo —, e sem ele a lista trocaria de ordem entre um render e
 * outro.
 *
 * Módulo puro, sem importar nada, para rodar no `node --test`.
 */

/**
 * Por que o perfil saiu do Athena. A vaga fica presa igual nos dois casos — é
 * por isso que eles dividem a mesma fila —, mas a linha precisa dizer a verdade
 * sobre o que aconteceu.
 */
export type MetaDisconnectionSignal = 'checkpoint_required' | 'operator_requested';

export type MetaPendingDisconnection = {
  id: string;
  profile_id: string;
  meta_app_id: string | null;
  username_snapshot: string;
  meta_app_label_snapshot: string | null;
  /** Nulo numa remoção pedida: ali não houve erro nenhum da Graph API. */
  error_code: string | null;
  error_message: string | null;
  signal: MetaDisconnectionSignal;
  detected_at: string;
};

/**
 * Como a linha se descreve na tela.
 *
 * Uma exclusão pedida não tem código de erro, e mostrar `erro 190` nela seria
 * inventar um erro que nunca existiu — o operador leria "caiu" onde ele mesmo
 * mandou remover. O verbo também muda, porque "caiu 05/09" numa remoção
 * deliberada é a mesma mentira em outro lugar.
 */
export function describeDisconnection(incident: MetaPendingDisconnection) {
  if (incident.signal === 'operator_requested') {
    return { verb: 'removido', badge: 'removido', isFall: false } as const;
  }

  const code = incident.error_code?.trim();
  return { verb: 'caiu', badge: code ? `erro ${code}` : 'queda', isFall: true } as const;
}

export type MetaDisconnectionGroup = {
  /** Nulo agrupa as quedas de perfis que entraram pela credencial global. */
  metaAppId: string | null;
  /** Rótulo congelado na queda; serve de nome quando o app já foi descadastrado. */
  appLabelSnapshot: string | null;
  incidents: MetaPendingDisconnection[];
};

function compareByFallDesc(first: MetaPendingDisconnection, second: MetaPendingDisconnection) {
  // Comparação de string em vez de Date.parse: as datas vêm todas do mesmo
  // `timestamptz`, no mesmo formato e no mesmo fuso, então a ordem
  // lexicográfica já é a cronológica — e uma data corrompida vira uma linha
  // fora de lugar em vez do NaN que envenenaria a ordenação inteira.
  const byFall = second.detected_at.localeCompare(first.detected_at);
  return byFall !== 0 ? byFall : first.id.localeCompare(second.id);
}

/**
 * Agrupa por app preservando a ordem em que os apps chegam.
 *
 * Quem chama passa a lista de apps na ordem em que a tela os desenha, para que
 * a fila de quedas apareça dentro do cartão certo. O balde `null` sai por
 * último: ele não tem cartão de app onde morar.
 */
export function groupPendingDisconnectionsByApp(
  incidents: MetaPendingDisconnection[],
): MetaDisconnectionGroup[] {
  const byApp = new Map<string | null, MetaPendingDisconnection[]>();

  for (const incident of incidents) {
    const key = incident.meta_app_id ?? null;
    const bucket = byApp.get(key);
    if (bucket) bucket.push(incident);
    else byApp.set(key, [incident]);
  }

  const groups: MetaDisconnectionGroup[] = [];
  for (const [metaAppId, bucket] of byApp) {
    groups.push({
      metaAppId,
      appLabelSnapshot: bucket.find((item) => item.meta_app_label_snapshot)?.meta_app_label_snapshot ?? null,
      incidents: [...bucket].sort(compareByFallDesc),
    });
  }

  return groups.sort((first, second) => {
    if ((first.metaAppId === null) !== (second.metaAppId === null)) return first.metaAppId === null ? 1 : -1;
    return 0;
  });
}

/** Índice pronto para o cartão de cada app perguntar a fila dele. */
export function pendingDisconnectionsByAppId(incidents: MetaPendingDisconnection[]) {
  return new Map(groupPendingDisconnectionsByApp(incidents).map((group) => [group.metaAppId, group.incidents]));
}

/**
 * Quedas que não têm cartão de app onde aparecer.
 *
 * São duas origens, e as duas somem da tela se ninguém as recolher aqui: o
 * perfil que entrou pela credencial global (`meta_app_id` nulo) e o que entrou
 * por um app depois descadastrado — a coluna do incidente vira nula por
 * `on delete set null`, mas mesmo que não virasse o app já não está na lista.
 * Some da tela é o pior desfecho: são exatamente as vagas que ninguém vai
 * liberar, porque ninguém sabe que elas existem.
 */
export function orphanPendingDisconnections(
  incidents: MetaPendingDisconnection[],
  knownAppIds: ReadonlySet<string>,
) {
  return incidents
    .filter((incident) => !incident.meta_app_id || !knownAppIds.has(incident.meta_app_id))
    // Agrupadas pelo app de origem, e não pela data: quem percorre esta lista
    // está com o Meta Developers aberto e resolve UM app por vez. Espalhar as
    // 63 da PeachySara no meio das 44 da Lari obriga a pular linha a linha.
    // Sem rótulo guardado vai para o fim, porque ali não há app para abrir.
    .sort((first, second) => {
      const firstLabel = first.meta_app_label_snapshot?.trim() ?? '';
      const secondLabel = second.meta_app_label_snapshot?.trim() ?? '';
      if (firstLabel !== secondLabel) {
        if (!firstLabel) return 1;
        if (!secondLabel) return -1;
        return firstLabel.localeCompare(secondLabel);
      }
      return compareByFallDesc(first, second);
    });
}

/**
 * Mesma regra da lista de quedas, para os perfis que perderam o app: um nome
 * por linha, SEM a arroba. O destino é o mesmo — a busca do painel da Meta e o
 * campo de conexão —, e apagar arroba à mão depois de colar é exatamente o
 * trabalho que estas listas existem para não dar.
 */
export function orphanedUsernameList(profiles: { username: string }[]) {
  return profiles.map((profile) => profile.username).join('\n');
}

/**
 * Texto para colar: um nome por linha, na mesma ordem da tela.
 *
 * SEM a arroba, a pedido da operação: o que vai para a busca do Meta Developers
 * é o nome puro, e apagar 63 arrobas à mão depois de colar é exatamente o
 * trabalho que esta tela existe para não dar. A arroba continua na tela, onde
 * serve de marca visual de que aquilo é um handle — ela nunca entra no que é
 * copiado, nem aqui nem no clique numa linha só.
 */
export function pendingUsernameList(incidents: MetaPendingDisconnection[]) {
  return incidents.map((incident) => incident.username_snapshot).join('\n');
}

/**
 * Marca uma linha, e só marca.
 *
 * Clicar no nome copia E marca, porque quem clica está indo apagar aquela conta
 * no painel da Meta. O clique NÃO alterna: voltar e clicar de novo — para
 * recopiar o nome que se perdeu no meio do caminho — não pode desmarcar o que
 * já foi feito. Quem desmarca é o checkbox. Existe como função para que a regra
 * fique registrada num teste: transformar isso num toggle é o "conserto"
 * natural de quem mexer aqui depois sem conhecer o motivo.
 *
 * Devolve o mesmo conjunto quando nada muda, para não disparar render à toa.
 */
export function selectIncident(selected: ReadonlySet<string>, incidentId: string): ReadonlySet<string> {
  if (selected.has(incidentId)) return selected;
  const next = new Set(selected);
  next.add(incidentId);
  return next;
}

/**
 * Quantos da fila estão marcados. Usado para o rótulo do botão e para decidir
 * o estado do "selecionar todos" (marcado, vazio ou parcial).
 */
export function selectionSummary(incidents: MetaPendingDisconnection[], selected: ReadonlySet<string>) {
  const selectedCount = incidents.reduce(
    (total, incident) => (selected.has(incident.id) ? total + 1 : total), 0);

  return {
    total: incidents.length,
    selectedCount,
    allSelected: incidents.length > 0 && selectedCount === incidents.length,
    partiallySelected: selectedCount > 0 && selectedCount < incidents.length,
  };
}
