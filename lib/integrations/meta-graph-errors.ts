/** Código de erro da Graph API para token vencido, inválido ou revogado. */
export const META_AUTHENTICATION_ERROR_CODE = 190;

/**
 * Decide se uma resposta de erro da Graph API adia a publicação ou a encerra.
 *
 * O caso que exige atenção é o de autenticação (HTTP 401 e o código 190). Ele
 * parece definitivo e não é: o token de longa duração da Meta é renovado por
 * rotina, e a conta volta a publicar assim que a renovação passa. Encerrar na
 * primeira tentativa repete o incidente de 31/08/2026, em que 3.315 publicações
 * morreram com `retryable: false` em vez de esperarem — e agora com raio maior,
 * porque um segredo de app rotacionado devolve 401 para os ~100 perfis daquele
 * app de uma vez só. Adiar custa tentativas; encerrar custa o post.
 *
 * Adiar não é retentar para sempre: PUBLICATION_MAX_ATTEMPTS continua valendo,
 * então um token realmente revogado ainda termina — só que depois de dar chance
 * à renovação, e não antes dela.
 *
 * Vive num módulo próprio, sem importar nada, para poder ser testado pelo
 * runner nativo do Node, que não resolve o alias `@/`.
 */
export function isRetryableGraphFailure(
  httpStatus: number,
  graphErrorCode?: number,
  isTransient?: boolean,
) {
  if (httpStatus === 401 || graphErrorCode === META_AUTHENTICATION_ERROR_CODE) return true;
  return httpStatus >= 500 || httpStatus === 429 || isTransient === true;
}
