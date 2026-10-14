/**
 * Rótulos e contas do cartão "plugadas × caídas" da dashboard.
 *
 * Módulo puro, sem importar nada, para rodar no `node --test`.
 */

import type { DashboardAccountFlowReason } from './v2-types';

/**
 * O nome de um motivo de queda, do jeito que a operação fala.
 *
 * Só nomeia o que foi visto em produção (14/10/2026). Código novo cai em
 * "Erro N" e a mensagem crua da Meta aparece no tooltip — inventar nome para um
 * erro que ninguém investigou seria afirmar uma causa que a tela não conhece.
 */
export function accountFlowReasonLabel(reason: Pick<DashboardAccountFlowReason, 'source' | 'signal' | 'code'>) {
  if (reason.signal === 'operator_requested') {
    return reason.source === 'zernio' ? 'Removida pelo operador (Zernio)' : 'Removida pelo operador';
  }

  if (reason.source === 'zernio') {
    if (reason.signal === 'account_disconnected') return 'Zernio: conta desconectada';
    if (reason.signal === 'auth_expired') return 'Zernio: autorização expirada';
    if (reason.signal === 'duplicate_identity_auto_removed') return 'Zernio: duplicada removida';
    return `Zernio: ${reason.signal}`;
  }

  const code = reason.code?.trim();
  // 190 com "You cannot access the app till you log in" — o checkpoint.
  if (code === '190') return 'Checkpoint';
  // 25 com "User access is restricted".
  if (code === '25') return 'Acesso restrito';
  // 100 "Unsupported request - method type": a conta não responde nem ao `me`
  // (migration 448).
  if (code === '100') return 'Conta não responde';
  return code ? `Erro ${code}` : 'Queda sem código';
}

/** O código como aparece no selo ao lado do rótulo: "190", "25 · 2207050". */
export function accountFlowReasonCode(reason: Pick<DashboardAccountFlowReason, 'source' | 'code' | 'subcode'>) {
  if (reason.source === 'zernio') return 'Zernio';
  const code = reason.code?.trim();
  if (!code) return null;
  const subcode = reason.subcode?.trim();
  return subcode && subcode !== '0' ? `${code} · ${subcode}` : code;
}

/**
 * Quantas caíram para cada cem plugadas.
 *
 * Nulo sem nenhuma plugada no período: "∞%" ou "100%" contra zero seriam
 * números inventados. As contas que caem não precisam ser as que entraram — é
 * uma régua de volume, não de sobrevivência.
 */
export function accountFlowFallRate(connected: number, fallen: number) {
  if (connected <= 0) return null;
  return (fallen / connected) * 100;
}

/**
 * A chave pela qual dois motivos são "o mesmo" na tela.
 *
 * O banco devolve a chave crua (`fonte:sinal:código:subcódigo`), e ela separa
 * coisas que a operação não distingue: o 190 de antes de 04/09/2026 vinha com
 * subcódigo vazio e o de depois com `0`, e a Zernio grava um `error_code` próprio
 * em cada incidente. Sem isto o "Checkpoint 190" aparecia duas vezes na lista.
 */
export function accountFlowReasonGroupKey(reason: Pick<DashboardAccountFlowReason, 'source' | 'signal' | 'code' | 'subcode'>) {
  if (reason.source === 'zernio' || reason.signal === 'operator_requested') return `${reason.source}:${reason.signal}`;
  const subcode = reason.subcode?.trim();
  return `${reason.source}:${reason.signal}:${reason.code?.trim() ?? ''}:${subcode && subcode !== '0' ? subcode : ''}`;
}

/**
 * Junta os motivos pela chave da tela e devolve também o de-para da chave crua,
 * para o detalhe de cada dia (`by_reason`) somar do mesmo jeito.
 */
export function mergeAccountFlowReasons(reasons: DashboardAccountFlowReason[]) {
  const merged = new Map<string, DashboardAccountFlowReason>();
  const groupOf = new Map<string, string>();
  for (const reason of reasons) {
    const group = accountFlowReasonGroupKey(reason);
    groupOf.set(reason.key, group);
    const current = merged.get(group);
    if (!current) {
      merged.set(group, { ...reason, key: group, subcode: reason.source === 'zernio' ? null : reason.subcode });
      continue;
    }
    const newer = reason.last_at > current.last_at;
    merged.set(group, {
      ...current,
      total: current.total + reason.total,
      last_at: newer ? reason.last_at : current.last_at,
      sample_message: newer && reason.sample_message ? reason.sample_message : current.sample_message ?? reason.sample_message,
    });
  }
  const list = [...merged.values()].sort((left, right) => right.total - left.total || left.key.localeCompare(right.key));
  return { reasons: list, groupOf };
}

/** O detalhe de um dia, somado pelas mesmas chaves de `mergeAccountFlowReasons`. */
export function mergeDayReasons(byReason: Record<string, number>, groupOf: Map<string, string>) {
  const merged = new Map<string, number>();
  for (const [key, total] of Object.entries(byReason)) {
    const group = groupOf.get(key) ?? key;
    merged.set(group, (merged.get(group) ?? 0) + total);
  }
  return [...merged.entries()].sort((left, right) => right[1] - left[1]);
}
