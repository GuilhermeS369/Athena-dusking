/**
 * Política de renovação do token de longa duração da Meta.
 *
 * Os três fatos que desenham tudo aqui:
 *
 * 1. O token vale 60 dias e `GET /refresh_access_token` estende por mais 60,
 *    servidor a servidor, sem o usuário ver nada.
 * 2. A Meta exige que o token tenha ao menos 24 h de idade para ser renovado.
 * 3. Passados os 60 dias sem renovar, o refresh também morre: só um OAuth novo,
 *    perfil por perfil.
 *
 * Daí a escolha de renovar semanalmente, e não perto da borda. O mecanismo
 * funciona igual no dia 7 e no dia 59; o que muda é o que sobra quando ele
 * falha. Renovando no dia 7, uma falha deixa ~53 dias para consertar. Renovando
 * no dia 59, deixa horas — e nas últimas 48 h desta operação houve uma parada de
 * 4 h do worker e um computador desligado na hora de uma tarefa agendada.
 * Qualquer uma delas, no dia errado, levaria a frota inteira junto.
 */

export const META_LONG_LIVED_TOKEN_DAYS = 60;

/** Piso da Meta: abaixo disso o refresh é recusado. */
export const META_TOKEN_MIN_REFRESH_AGE_HOURS = 24;

/** Idade a partir da qual o worker renova. Semanal, por margem, não por limite. */
export const META_TOKEN_REFRESH_AFTER_DAYS = 7;

/**
 * Idade a partir da qual a renovação deixou de ser rotina e virou risco: passou
 * de cinco ciclos semanais sem sucesso, ainda com 25 dias de folga.
 */
export const META_TOKEN_ALARM_AFTER_DAYS = 35;

const HOUR_IN_MS = 60 * 60 * 1000;
const DAY_IN_MS = 24 * HOUR_IN_MS;

export type MetaTokenProfile = {
  provider: string;
  token_refreshed_at: string | null;
  token_expires_at: string | null;
  token_refresh_attempted_at: string | null;
  token_refresh_error: string | null;
  token_refresh_failure_count: number | null;
};

export type MetaTokenHealth =
  | 'not_applicable'
  | 'unknown'
  | 'healthy'
  | 'due'
  | 'at_risk'
  | 'expired';

export type MetaTokenRenewalState = {
  health: MetaTokenHealth;
  /** Idade do token vigente, em dias. Null quando não dá para saber. */
  ageDays: number | null;
  /** Dias até o token deixar de ser renovável. Null quando não dá para saber. */
  daysUntilUnrefreshable: number | null;
  /** A Meta aceita renovar agora? Exige 24 h de idade e a janela aberta. */
  canRefreshNow: boolean;
  /** O worker deve renovar neste ciclo? */
  due: boolean;
  consecutiveFailures: number;
  lastError: string | null;
};

function parseDate(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function metaTokenRenewalState(
  profile: MetaTokenProfile,
  now = Date.now(),
): MetaTokenRenewalState {
  const consecutiveFailures = Math.max(0, profile.token_refresh_failure_count ?? 0);
  const lastError = profile.token_refresh_error ?? null;

  if (profile.provider !== 'meta_official') {
    return {
      health: 'not_applicable',
      ageDays: null,
      daysUntilUnrefreshable: null,
      canRefreshNow: false,
      due: false,
      consecutiveFailures,
      lastError,
    };
  }

  const refreshedAt = parseDate(profile.token_refreshed_at);

  if (refreshedAt === null) {
    // Sem idade conhecida não dá para afirmar saúde nem para arriscar o refresh:
    // se o token tiver menos de 24 h, a Meta recusa e a falha seria contada
    // contra o perfil sem motivo. A varredura trata este caso à parte.
    return {
      health: 'unknown',
      ageDays: null,
      daysUntilUnrefreshable: null,
      canRefreshNow: false,
      due: false,
      consecutiveFailures,
      lastError,
    };
  }

  const ageMs = Math.max(0, now - refreshedAt);
  const ageDays = ageMs / DAY_IN_MS;
  const daysUntilUnrefreshable = META_LONG_LIVED_TOKEN_DAYS - ageDays;
  const canRefreshNow = ageMs >= META_TOKEN_MIN_REFRESH_AGE_HOURS * HOUR_IN_MS
    && daysUntilUnrefreshable > 0;

  const health: MetaTokenHealth = daysUntilUnrefreshable <= 0
    ? 'expired'
    : ageDays >= META_TOKEN_ALARM_AFTER_DAYS
      ? 'at_risk'
      : ageDays >= META_TOKEN_REFRESH_AFTER_DAYS
        ? 'due'
        : 'healthy';

  return {
    health,
    ageDays,
    daysUntilUnrefreshable,
    canRefreshNow,
    // Um token expirado não é renovável: insistir só gasta chamada e esconde,
    // atrás de uma falha repetida, que o caso já virou reautorização manual.
    due: canRefreshNow && ageDays >= META_TOKEN_REFRESH_AFTER_DAYS,
    consecutiveFailures,
    lastError,
  };
}

export function metaTokenRenewalLabel(state: MetaTokenRenewalState) {
  const age = state.ageDays === null ? null : Math.floor(state.ageDays);

  switch (state.health) {
    case 'not_applicable':
      return 'Não se aplica a este provedor.';
    case 'unknown':
      return 'Idade do token desconhecida. Será medida na próxima renovação.';
    case 'expired':
      return 'Token vencido: a renovação automática não alcança mais. Reconecte este perfil.';
    case 'at_risk':
      return `Sem renovar há ${age} dia(s). Restam ${Math.floor(state.daysUntilUnrefreshable ?? 0)} dia(s) antes de exigir reconexão manual.`;
    case 'due':
      return `Renovado há ${age} dia(s). Entra na próxima varredura.`;
    default:
      return age !== null && age <= 1 ? 'Renovado hoje.' : `Renovado há ${age} dia(s).`;
  }
}

/**
 * Resume a frota de um app (ou da organização) em um número que cabe num card.
 * O que importa não é a média de dias, é quantos perfis já passaram do ponto em
 * que a renovação deveria ter acontecido.
 */
export function summarizeMetaTokenFleet(
  profiles: MetaTokenProfile[],
  now = Date.now(),
) {
  return profiles.reduce((accumulator, profile) => {
    const state = metaTokenRenewalState(profile, now);
    if (state.health === 'not_applicable') return accumulator;

    return {
      total: accumulator.total + 1,
      healthy: accumulator.healthy + (state.health === 'healthy' ? 1 : 0),
      due: accumulator.due + (state.health === 'due' ? 1 : 0),
      atRisk: accumulator.atRisk + (state.health === 'at_risk' ? 1 : 0),
      expired: accumulator.expired + (state.health === 'expired' ? 1 : 0),
      unknown: accumulator.unknown + (state.health === 'unknown' ? 1 : 0),
      failing: accumulator.failing + (state.consecutiveFailures > 0 ? 1 : 0),
    };
  }, { total: 0, healthy: 0, due: 0, atRisk: 0, expired: 0, unknown: 0, failing: 0 });
}
