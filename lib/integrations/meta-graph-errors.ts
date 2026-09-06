/** Código de erro da Graph API para token vencido, inválido ou revogado. */
export const META_AUTHENTICATION_ERROR_CODE = 190;

/**
 * "Only photo or video can be accepted as media type."
 *
 * Parece erro de arquivo e quase nunca é. A Meta não recebe a mídia: ela recebe
 * uma URL assinada e busca sozinha. Se nesse instante o R2 devolver erro,
 * timeout ou qualquer coisa que não seja a imagem, ela vê um conteúdo que não é
 * foto nem vídeo e responde isto — sobre um arquivo perfeitamente válido.
 *
 * Medido em 06/09/2026, nos dois PNG que falharam: os MESMOS arquivos já haviam
 * publicado 2.287 vezes pela API da Meta e 395 pela Zernio. Três falhas em
 * 2.330 tentativas — 0,13%, espalhadas por dias diferentes. Formato incompatível
 * não falha em 0,13% dos casos; falha em todos.
 *
 * A URL vale 24 horas, então expiração está descartada.
 */
export const META_MEDIA_FETCH_ERROR_CODE = 9004;

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
  // Falha da Meta ao BUSCAR a mídia. As três ocorrências de 06/09 morreram na
  // primeira leitura, porque 9004 chega com HTTP 400 e a regra abaixo só adia
  // 401, 429 e 5xx. É a terceira vez que o mesmo erro de método aparece: o 401
  // que matou 3.315 publicações em 31/08 e o `ERROR` de contêiner que matou 76
  // em 04/09 tinham exatamente esta forma — um veredito provisório tratado como
  // definitivo. Se a mídia estiver mesmo quebrada, PUBLICATION_MAX_ATTEMPTS
  // encerra do mesmo jeito, só que depois de a Meta repetir o veredito.
  if (graphErrorCode === META_MEDIA_FETCH_ERROR_CODE) return true;
  return httpStatus >= 500 || httpStatus === 429 || isTransient === true;
}

/** Estados possíveis do contêiner de mídia, conforme a documentação da Meta. */
export type MetaContainerStatusCode = 'IN_PROGRESS' | 'FINISHED' | 'PUBLISHED' | 'ERROR' | 'EXPIRED';

export type MetaContainerVerdict =
  | { kind: 'publish' }
  | { kind: 'already_published' }
  | { kind: 'wait' }
  | { kind: 'fail'; retryable: boolean; message: string };

/**
 * Decide o que fazer com o status de um contêiner de mídia.
 *
 * A distinção que importa é entre ERROR e EXPIRED, e ela custou caro para ser
 * aprendida. Em 04/09/2026, 76 publicações foram encerradas em definitivo por um
 * ERROR que a própria Meta desmentiu: consultados minutos depois, os MESMOS
 * contêineres respondiam FINISHED, e um deles foi publicado à mão sem nenhuma
 * correção. O disjuntor então pausou os lotes por falhas consecutivas, e 3.040
 * itens congelaram — tudo a partir de um veredito falso.
 *
 * Por isso:
 *
 *   ERROR   -> ADIA. A Meta recomenda consultar "uma vez por minuto, por no
 *              máximo 5 minutos" e devolve erros transitórios nesse polling que
 *              funcionam na retentativa. Com o backoff de 60s/2min/4min/8min e
 *              PUBLICATION_MAX_ATTEMPTS, cinco leituras de ERROR ainda encerram
 *              o item — a diferença é que agora a Meta precisa REPETIR o
 *              veredito, em vez de bastar dizê-lo uma vez.
 *
 *   EXPIRED -> ENCERRA. Este é terminal de verdade: o contêiner passou das 24 h
 *              de validade que a Meta documenta e não volta. Adiar aqui só
 *              gastaria tentativas contra algo que não existe mais.
 *
 * O motivo em texto vem do campo `status`, que só chega porque `containerStatus`
 * passou a pedi-lo. Antes de 04/09 pedíamos apenas `status_code`, e por isso
 * toda falha chegava como "ERROR" pelado, sem nada por onde começar.
 */
export function metaContainerVerdict(
  statusCode: string | undefined,
  status?: string,
): MetaContainerVerdict {
  if (statusCode === 'FINISHED') return { kind: 'publish' };
  if (statusCode === 'PUBLISHED') return { kind: 'already_published' };

  if (statusCode === 'EXPIRED') {
    return {
      kind: 'fail',
      retryable: false,
      message: 'Instagram informou EXPIRED: o contêiner passou das 24 horas de validade e precisa ser recriado.',
    };
  }

  if (statusCode === 'ERROR') {
    const detalhe = typeof status === 'string' && status.trim() && status.trim() !== statusCode
      ? ` Motivo da Meta: ${status.trim().slice(0, 400)}`
      : ' A Meta não informou o motivo.';
    return {
      kind: 'fail',
      retryable: true,
      message: `Instagram informou ERROR ao preparar a publicação.${detalhe}`,
    };
  }

  return { kind: 'wait' };
}

/**
 * Reconhece o bloqueio de API no nível do APP, e não do perfil nem do item.
 *
 * Em 05/09/2026 a Meta passou a responder `código 200` com a mensagem
 * `API access blocked.` para 4 dos 28 apps — 169 perfis de uma vez. O código
 * tratou aquilo como falha de item: 200 não é retentável, então 136 reels
 * morreram em definitivo, o disjuntor contou falhas consecutivas e pausou três
 * lotes. Um deles misturava dois apps do mesmo cliente, e a pausa congelou
 * 6.120 publicações de um app que estava saudável.
 *
 * A unidade errada era o item; a certa é o app. Enquanto o bloqueio durar,
 * nenhum perfil daquele app publica, e cada tentativa só multiplica o prejuízo.
 * Quem trata isso é `flag_meta_app_api_blocked`, que abre uma janela de uma
 * hora no app e marca o que vence nela como `ignored` — nunca `failed`, para o
 * disjuntor não contar e nenhum lote pausar.
 *
 * O `200` sozinho não basta: ele é o código genérico de permissão da Graph API
 * e cobre desde escopo faltando até papel de desenvolvedor errado. Só a
 * mensagem `API access blocked` diz que o app inteiro está fechado, e é por
 * isso que a checagem exige as duas coisas — a mesma guarda existe do lado do
 * Postgres, para que nenhum chamador consiga bloquear um app por engano.
 */
export function isMetaAppApiBlocked(result: { errorCode?: string; errorMessage?: string }) {
  return metaAppApiFailureKind(result) !== null;
}

/** As duas formas conhecidas de a Meta dizer que o app não fala mais com a API. */
export type MetaAppApiFailureKind = 'blocked' | 'deactivated';

/**
 * Diz QUAL das duas mensagens chegou — e a diferença muda o que o operador faz.
 *
 * Em 06/09/2026, a partir das 00:21, a Meta trocou `API access blocked.` por
 * `API access deactivated.` nos mesmos apps. A guarda só casava a primeira,
 * então os itens voltaram ao caminho antigo: 200 não é retentável, viraram
 * falha terminal, o disjuntor contou e três lotes pausaram. Às 10:50 havia
 * 14.482 itens congelados, 2.076 já vencidos — e quase todos de perfis
 * SAUDÁVEIS, presos por ~220 itens de perfis com token de app morto. O mesmo
 * estrago do dia anterior, voltando por uma palavra diferente.
 *
 *   blocked     -> pode voltar. A janela de uma hora testa sozinha.
 *   deactivated -> não volta. O app foi desativado do lado da Meta e as contas
 *                  precisam ser religadas em outro app. A janela continua
 *                  valendo, porque é ela que impede a fila de sangrar, mas a
 *                  tela precisa dizer "religue" em vez de "aguarde".
 */
export function metaAppApiFailureKind(
  result: { errorCode?: string; errorMessage?: string },
): MetaAppApiFailureKind | null {
  if (String(result.errorCode ?? '').trim() !== '200') return null;
  const message = result.errorMessage ?? '';
  if (/api access blocked/i.test(message)) return 'blocked';
  if (/api access deactivated/i.test(message)) return 'deactivated';
  return null;
}
