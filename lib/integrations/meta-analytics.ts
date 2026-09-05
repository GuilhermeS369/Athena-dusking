import { decryptToken } from '@/lib/security/token-crypto';
import {
  META_ACCOUNT_INSIGHT_METRICS,
  META_MINIMUM_METRICS,
  classifyMetaAnalyticsFailure,
  metaDailyMetricRow,
  metaDailyRowHasSignal,
  metaBucketLocalDate,
  metaInsightTotals,
  metaInteractions,
  metaNumberValue,
  parseMetaAppUsage,
  saoPauloDay,
  saoPauloDayOf,
  saoPauloDayWindow,
  unsupportedMetricsFromError,
  type MetaAnalyticsFailure,
  type MetaAnalyticsStatus,
  type MetaDailyMetricRow,
  type MetaInsightTotals,
} from '@/lib/integrations/meta-analytics-normalizers';

/**
 * Coleta de métricas pela API oficial da Meta.
 *
 * DESENHO, e por que ele é diferente do da Zernio.
 *
 * A coleta da Zernio nasceu sob uma credencial POR CONTA: milhares de chaves,
 * cada uma com limite próprio e apertado, o que exigiu fila com lease, controle
 * de pressão por conexão e concorrência 1. Com a Meta a topologia inverteu —
 * ~37 apps para toda a frota, cada um cobrindo até 100 perfis — e o gargalo
 * deixou de ser a credencial. O custo por perfil aqui é de 3 chamadas HTTP por
 * ciclo (conta + 2 dias de insights), o que torna a coleta da frota inteira uma
 * operação de minutos, não de horas.
 *
 * DUAS DECISÕES QUE VALE REGISTRAR:
 *
 * 1. **Um dia por chamada.** A Meta agrega insights no fuso da CONTA, que não
 *    temos como saber, e o formato de série temporal não vale para todas as
 *    métricas na versão atual. Pedir uma janela de um dia e carimbar a data que
 *    pedimos é o único jeito de garantir que a linha diária caia no dia certo
 *    sem depender de `end_time`.
 *
 * 2. **Sem arquivo de payload.** A coleta da Zernio grava cada resposta em
 *    `profile_analytics_payload_archives` para auditoria. Repetir isso aqui
 *    seriam ~1.000 linhas por ciclo, de payloads pequenos e repetitivos, para
 *    responder uma pergunta que o `raw_payload` do snapshot já responde.
 */

const graphVersion = process.env.META_GRAPH_API_VERSION ?? 'v26.0';
const requestTimeoutMs = Number(process.env.META_ANALYTICS_TIMEOUT_MS ?? 15_000);

/**
 * Teto de chamadas simultâneas contra a Meta.
 *
 * Não é o limite dela — é o nosso, para que uma rodada da frota não abra mil
 * sockets de uma vez. O limite real do app é dinâmico e chega em `X-App-Usage`,
 * lido abaixo.
 */
const maxConcurrentRequests = Number(process.env.META_ANALYTICS_CONCURRENCY ?? 8);

/** A partir daqui a coleta pausa entre chamadas para não bater no teto do app. */
const APP_USAGE_SLOWDOWN_PERCENT = 75;
const APP_USAGE_STOP_PERCENT = 95;

let activeRequests = 0;
const pendingRequests: Array<() => void> = [];

/**
 * Métricas que a Meta já recusou nesta execução.
 *
 * Guardado em memória do processo, não em banco: é uma característica da versão
 * da API, não do perfil. Descobrir uma vez por rodada e não repetir o erro nos
 * outros 957 perfis é a diferença entre uma chamada perdida e mil.
 */
const knownUnsupportedMetrics = new Set<string>();

let lastAppUsagePercent: number | null = null;
let lastRateHeaders: Record<string, string | null> = {};

/** Cabeçalhos de limite da última resposta, para diagnóstico. */
export function lastMetaRateHeaders() {
  return lastRateHeaders;
}

export type MetaAnalyticsProfile = {
  id: string;
  organization_id: string;
  username: string | null;
  instagram_user_id: string | null;
  encrypted_access_token: string | null;
};

export type MetaPostRow = {
  mediaId: string;
  permalink: string | null;
  caption: string | null;
  mediaType: string | null;
  thumbnailUrl: string | null;
  timestamp: string | null;
  likes: number;
  comments: number;
  /** Insights por mídia; só preenchidos quando a coleta do dia corrente roda. */
  views: number;
  reach: number;
  shares: number;
  saved: number;
  totalInteractions: number;
};

export type MetaAnalyticsCollection = {
  profileId: string;
  organizationId: string;
  status: MetaAnalyticsStatus;
  failure: MetaAnalyticsFailure | null;
  periodStart: string;
  periodEnd: string;
  followersCount: number | null;
  mediaCount: number | null;
  dailyRows: MetaDailyMetricRow[];
  windowTotals: MetaInsightTotals;
  posts: MetaPostRow[];
  /**
   * O dia corrente, montado a partir dos posts — a única forma de tê-lo.
   *
   * O endpoint de conta não entrega o dia enquanto ele está aberto (medido com
   * sete formatos de janela em 05/09/2026), então este número é a SOMA dos
   * insights dos posts publicados hoje. Ele responde "como está indo o que saiu
   * hoje", que é uma pergunta diferente de "quantas views a conta teve no dia"
   * — e, para esta operação, a mais útil das duas.
   */
  todayRow: MetaDailyMetricRow | null;
  partialSources: string[];
  appUsagePercent: number | null;
  durationMs: number;
};

async function withRequestLimit<T>(operation: () => Promise<T>): Promise<T> {
  if (activeRequests >= maxConcurrentRequests) {
    await new Promise<void>((resolve) => pendingRequests.push(resolve));
  }
  activeRequests += 1;
  try {
    return await operation();
  } finally {
    activeRequests -= 1;
    pendingRequests.shift()?.();
  }
}

export function currentMetaAppUsagePercent() {
  return lastAppUsagePercent;
}

/** A Meta está perto do teto do app? Usado pelo runner para desacelerar. */
export function metaAppUsagePressure(): 'ok' | 'slow' | 'stop' {
  if (lastAppUsagePercent === null) return 'ok';
  if (lastAppUsagePercent >= APP_USAGE_STOP_PERCENT) return 'stop';
  if (lastAppUsagePercent >= APP_USAGE_SLOWDOWN_PERCENT) return 'slow';
  return 'ok';
}

type GraphResponse = {
  ok: boolean;
  httpStatus: number;
  body: Record<string, unknown>;
  failure: MetaAnalyticsFailure | null;
};

async function graphGet(path: string, params: Record<string, string>, token: string): Promise<GraphResponse> {
  const query = new URLSearchParams({ ...params, access_token: token });
  const url = `https://graph.instagram.com/${graphVersion}/${path.replace(/^\//, '')}?${query}`;

  return withRequestLimit(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      const usage = parseMetaAppUsage(response.headers.get('x-app-usage'));
      if (usage) lastAppUsagePercent = usage.percent;
      // Guardado cru para diagnóstico: `X-App-Usage` sozinho não conta a
      // história toda, e a Meta manda o limite por caso de uso em outro
      // cabeçalho. Saber QUAL deles existe é o que permite dimensionar a
      // frota — ver `npm run probe:meta-analytics -- --limites`.
      lastRateHeaders = {
        'x-app-usage': response.headers.get('x-app-usage'),
        'x-business-use-case-usage': response.headers.get('x-business-use-case-usage'),
        'x-ig-api-usage': response.headers.get('x-ig-api-usage'),
      };

      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (response.ok) return { ok: true, httpStatus: response.status, body, failure: null };

      const error = (body.error ?? {}) as Record<string, unknown>;
      return {
        ok: false,
        httpStatus: response.status,
        body,
        failure: classifyMetaAnalyticsFailure({
          httpStatus: response.status,
          graphCode: typeof error.code === 'number' ? error.code : undefined,
          graphSubcode: typeof error.error_subcode === 'number' ? error.error_subcode : undefined,
          message: typeof error.message === 'string' ? error.message : undefined,
          isTransient: error.is_transient === true,
        }),
      };
    } catch (error) {
      const aborted = (error as Error)?.name === 'AbortError';
      return {
        ok: false,
        httpStatus: 0,
        body: {},
        failure: classifyMetaAnalyticsFailure({
          httpStatus: 0,
          message: aborted
            ? `A Meta não respondeu em ${Math.round(requestTimeoutMs / 1000)}s.`
            : (error as Error)?.message ?? 'Falha de rede ao consultar a Meta.',
          isTransient: true,
        }),
      };
    } finally {
      clearTimeout(timeout);
    }
  });
}

/**
 * Insights de um dia, com a lista de métricas se ajustando sozinha.
 *
 * A Meta recusa a chamada INTEIRA quando uma única métrica não se aplica —
 * então uma métrica aposentada zeraria o perfil todo. Aqui o nome recusado é
 * lido da mensagem, removido e a chamada repetida; o que a versão da API não
 * aceita fica registrado para o resto da rodada.
 */
async function fetchWindowInsights(token: string, window: { since: number; until: number }): Promise<
  { ok: true; totals: MetaInsightTotals; body: Record<string, unknown> }
  | { ok: false; failure: MetaAnalyticsFailure }
> {
  let metrics = META_ACCOUNT_INSIGHT_METRICS.filter((metric) => !knownUnsupportedMetrics.has(metric));
  if (metrics.length === 0) metrics = [...META_MINIMUM_METRICS];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await graphGet('me/insights', {
      metric: metrics.join(','),
      period: 'day',
      metric_type: 'total_value',
      since: String(window.since),
      until: String(window.until),
    }, token);

    if (response.ok) return { ok: true, totals: metaInsightTotals(response.body), body: response.body };

    const error = (response.body.error ?? {}) as Record<string, unknown>;
    const message = typeof error.message === 'string' ? error.message : '';
    const rejected = error.code === 100 ? unsupportedMetricsFromError(message, metrics) : [];

    // Sem métrica identificável na mensagem não há o que ajustar: repetir a
    // mesma chamada só gastaria cota.
    if (rejected.length === 0 || rejected.length === metrics.length) {
      return { ok: false, failure: response.failure! };
    }

    for (const metric of rejected) knownUnsupportedMetrics.add(metric);
    metrics = metrics.filter((metric) => !rejected.includes(metric));
    if (metrics.length === 0) metrics = [...META_MINIMUM_METRICS];
  }

  return {
    ok: false,
    failure: {
      status: 'no_data',
      code: 'meta_metric_negotiation_failed',
      message: 'A Meta recusou todas as métricas pedidas para este perfil.',
      retryable: false,
    },
  };
}

/**
 * Os dias da conta, do jeito que a Meta os define.
 *
 * Uma chamada de série temporal de `reach` — a única métrica que aceita esse
 * formato nesta versão da API — devolve `end_time` por balde, e é dele que sai
 * a fronteira do dia da conta. Sem isso a coleta precisa ADIVINHAR onde o dia
 * começa, e adivinhar errado desloca todo o histórico (ver
 * `metaBucketLocalDate`).
 *
 * Note o que a resposta não traz: um balde para o dia em curso. A Meta só
 * publica o dia depois que ele fecha no fuso da conta — medido em 05/09/2026
 * com sete formatos de janela, incluindo o padrão da própria API.
 */
async function fetchAccountDayBuckets(token: string, days: number, now: number) {
  const until = Math.floor(now / 1000);
  const since = until - (days + 2) * 86_400;
  const response = await graphGet('me/insights', {
    metric: 'reach',
    period: 'day',
    since: String(since),
    until: String(until),
  }, token);

  if (!response.ok) return { ok: false as const, failure: response.failure! };

  const data = response.body.data as Array<{ values?: Array<{ end_time?: string }> }> | undefined;
  const buckets = (data?.[0]?.values ?? [])
    .flatMap((value) => {
      const endTime = typeof value.end_time === 'string' ? value.end_time : null;
      if (!endTime) return [];
      const endMs = Date.parse(endTime);
      const localDate = metaBucketLocalDate(endTime);
      if (!localDate || Number.isNaN(endMs)) return [];
      return [{ endTime, endMs, localDate }];
    })
    .sort((left, right) => left.endMs - right.endMs);

  return { ok: true as const, buckets };
}

/**
 * Insights de cada mídia. UMA CHAMADA POR POST — não há atalho.
 *
 * DUAS FORMAS DE LOTE FORAM TESTADAS EM 05/09/2026, E NENHUMA EXISTE AQUI:
 *
 *   `?ids=a,b,c&fields=insights.metric(...)`
 *     → 500 · "The ids query parameter is deprecated in v26.0+."
 *
 *   `POST /?batch=[{method,relative_url}, ...]` (o lote clássico da Graph)
 *     → 400, corpo vazio
 *
 * Fica registrado para ninguém tentar de novo achando que economiza: em
 * `graph.instagram.com` v26 a métrica por post sai uma a uma. Com 25 posts por
 * perfil por dia, o "hoje" custa 26 chamadas por perfil que publicou — contra
 * as 2 que a primeira versão deste código supôs.
 *
 * A CONTAGEM DE FALHAS IMPORTA. A versão anterior engolia o erro com um
 * `continue` e devolvia mapa vazio, e o resultado era uma linha diária de zeros
 * — o mesmo "zero silencioso" que esta coleta inteira existe para não repetir.
 * Agora quem chama recebe quantas falharam e decide.
 */
const MEDIA_INSIGHT_METRICS = ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions'];

async function fetchMediaInsights(token: string, mediaIds: string[]) {
  const porMidia = new Map<string, MetaInsightTotals>();
  let falhas = 0;

  // Sequencial de propósito: o limitador global (`maxConcurrentRequests`) já
  // reparte a banda entre os perfis, e disparar 25 chamadas de uma vez por
  // perfil faria um perfil monopolizar a fila dos outros.
  for (const mediaId of mediaIds) {
    const response = await graphGet(`${mediaId}/insights`, { metric: MEDIA_INSIGHT_METRICS.join(',') }, token);
    if (!response.ok) {
      falhas += 1;
      continue;
    }
    porMidia.set(mediaId, metaInsightTotals(response.body));
  }

  return { porMidia, falhas };
}

export type CollectMetaAnalyticsOptions = {
  /** Quantos dias coletar, contando de hoje para trás. Padrão 2 (hoje e ontem). */
  days?: number;
  /** Coleta a lista de mídias (alimenta o card de melhores posts). */
  collectPosts?: boolean;
  /**
   * Soma os insights dos posts de hoje para montar a linha do dia corrente.
   * Implica `collectPosts`: a lista de mídias é de onde saem os ids.
   */
  collectToday?: boolean;
  /** Datas que já têm linha de OUTRO provedor e não devem ser regravadas. */
  skipDates?: Set<string>;
  now?: number;
};

/**
 * Coleta as métricas de um perfil. Não escreve nada — quem persiste é
 * `persistMetaAnalyticsCollections`, em lote, porque escrever perfil a perfil é
 * o que deixaria a rodada pesada para o Supabase.
 */
export async function collectMetaProfileAnalytics(
  profile: MetaAnalyticsProfile,
  options: CollectMetaAnalyticsOptions = {},
): Promise<MetaAnalyticsCollection> {
  const startedAt = Date.now();
  const now = options.now ?? Date.now();
  const days = Math.min(Math.max(options.days ?? 2, 1), 30);
  // Provisórios: assim que os baldes da conta chegam, o período passa a ser o
  // que a Meta de fato mediu, e não o que o nosso calendário supôs.
  let periodEnd = saoPauloDay(0, now);
  let periodStart = saoPauloDay(days - 1, now);

  const base = {
    profileId: profile.id,
    organizationId: profile.organization_id,
    periodStart,
    periodEnd,
    followersCount: null,
    mediaCount: null,
    dailyRows: [] as MetaDailyMetricRow[],
    windowTotals: {} as MetaInsightTotals,
    posts: [] as MetaPostRow[],
    todayRow: null as MetaDailyMetricRow | null,
    partialSources: [] as string[],
    appUsagePercent: lastAppUsagePercent,
    durationMs: 0,
  };

  if (!profile.encrypted_access_token) {
    return {
      ...base,
      status: 'not_configured',
      failure: {
        status: 'not_configured',
        code: 'missing_access_token',
        message: 'Perfil sem token da Meta salvo. Reconecte a conta em /perfis.',
        retryable: false,
      },
      durationMs: Date.now() - startedAt,
    };
  }

  let token: string;
  try {
    token = decryptToken(profile.encrypted_access_token);
  } catch {
    return {
      ...base,
      status: 'failed',
      failure: {
        status: 'failed',
        code: 'token_unreadable',
        message: 'Não foi possível ler o token salvo deste perfil.',
        retryable: false,
      },
      durationMs: Date.now() - startedAt,
    };
  }

  const partialSources: string[] = [];

  // 1. Conta: seguidores e total de mídias. Uma chamada, e é a que sustenta o
  //    histórico de seguidores — a Meta não expõe série diária confiável para
  //    contas pequenas, então o Athena tira a própria foto por dia.
  const account = await graphGet('me', { fields: 'id,username,followers_count,media_count' }, token);
  if (!account.ok) {
    // Falha na conta é falha do perfil: sem ela não há token válido, e insistir
    // nas outras chamadas só gastaria cota do app.
    return { ...base, status: account.failure!.status, failure: account.failure, durationMs: Date.now() - startedAt };
  }
  const followersCount = metaNumberValue(account.body.followers_count);
  const mediaCount = metaNumberValue(account.body.media_count);

  // 2. Insights, um balde por chamada — e o balde é o da CONTA, não o do nosso
  //    calendário. A chamada abaixo é o que descobre onde o dia dela começa.
  const dailyRows: MetaDailyMetricRow[] = [];
  const windowTotals: MetaInsightTotals = {};
  let insightFailure: MetaAnalyticsFailure | null = null;

  const bucketsResult = await fetchAccountDayBuckets(token, days, now);
  if (!bucketsResult.ok) {
    // Sem os baldes não dá para carimbar data nenhuma com honestidade. Melhor
    // não gravar do que gravar no dia errado — foi o erro que esta função
    // acabou de deixar de cometer.
    return {
      ...base,
      status: bucketsResult.failure.status,
      failure: bucketsResult.failure,
      followersCount,
      mediaCount,
      durationMs: Date.now() - startedAt,
    };
  }

  const buckets = bucketsResult.buckets.slice(-days);
  if (buckets.length > 0) {
    periodStart = buckets[0].localDate;
    periodEnd = buckets[buckets.length - 1].localDate;
  }

  for (const bucket of buckets) {
    if (options.skipDates?.has(bucket.localDate)) continue;

    const insights = await fetchWindowInsights(token, {
      since: Math.floor(bucket.endMs / 1000) - 86_400,
      until: Math.floor(bucket.endMs / 1000),
    });
    if (!insights.ok) {
      insightFailure = insights.failure;
      partialSources.push(`insights:${bucket.localDate}`);
      // Erro de autenticação ou de cota não melhora no balde seguinte da mesma
      // rodada: para de tentar em vez de multiplicar a falha por `days`.
      if (insights.failure.status === 'permission_missing' || insights.failure.status === 'rate_limited') break;
      continue;
    }

    for (const [name, value] of Object.entries(insights.totals)) {
      windowTotals[name] = (windowTotals[name] ?? 0) + value;
    }

    const row = metaDailyMetricRow({
      profile,
      metricDate: bucket.localDate,
      totals: insights.totals,
      posts: 0,
      coverageStatus: 'complete',
      sourcePayload: {
        source: 'meta_graph',
        endpoint: 'me/insights',
        metric_type: 'total_value',
        bucket_end_time: bucket.endTime,
        metrics: insights.totals,
      },
    });
    // Um balde sem nenhum sinal não vira linha: gravar zeros faria a dashboard
    // afirmar "zero visualizações" onde a verdade é "a conta não teve nada".
    if (metaDailyRowHasSignal(row)) dailyRows.push(row);
  }

  // 3. Mídias: opcional e barata (uma chamada traz curtidas e comentários de
  //    todas). Insights por mídia custariam N chamadas por perfil e ficam fora.
  let posts: MetaPostRow[] = [];
  let todayRow: MetaDailyMetricRow | null = null;
  if (options.collectPosts || options.collectToday) {
    const media = await graphGet('me/media', {
      fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,timestamp,like_count,comments_count',
      limit: '25',
    }, token);
    if (media.ok && Array.isArray(media.body.data)) {
      posts = (media.body.data as Array<Record<string, unknown>>).flatMap((item) => {
        const mediaId = typeof item.id === 'string' ? item.id : '';
        if (!mediaId) return [];
        return [{
          mediaId,
          permalink: typeof item.permalink === 'string' ? item.permalink : null,
          caption: typeof item.caption === 'string' ? item.caption.slice(0, 2200) : null,
          mediaType: typeof item.media_product_type === 'string' && item.media_product_type !== 'FEED'
            ? String(item.media_product_type).toLowerCase()
            : typeof item.media_type === 'string' ? item.media_type.toLowerCase() : null,
          thumbnailUrl: typeof item.thumbnail_url === 'string' ? item.thumbnail_url : null,
          timestamp: typeof item.timestamp === 'string' ? item.timestamp : null,
          likes: metaNumberValue(item.like_count),
          comments: metaNumberValue(item.comments_count),
          views: 0,
          reach: 0,
          shares: 0,
          saved: 0,
          totalInteractions: 0,
        }];
      });
    } else {
      partialSources.push('media');
    }
  }

  // O dia corrente, somado a partir dos posts publicados nele.
  if (options.collectToday && posts.length > 0) {
    const hoje = saoPauloDay(0, now);
    const dePostsDeHoje = posts.filter((post) => post.timestamp && saoPauloDayOf(post.timestamp) === hoje);

    if (dePostsDeHoje.length > 0) {
      const { porMidia: insightsPorMidia, falhas } = await fetchMediaInsights(token, dePostsDeHoje.map((post) => post.mediaId));
      if (falhas > 0) partialSources.push(`media_insights:${falhas}`);
      const somaDoDia: MetaInsightTotals = {};

      for (const post of dePostsDeHoje) {
        const totais = insightsPorMidia.get(post.mediaId);
        if (!totais) continue;
        post.views = metaNumberValue(totais.views);
        post.reach = metaNumberValue(totais.reach);
        post.shares = metaNumberValue(totais.shares);
        post.saved = metaNumberValue(totais.saved);
        post.totalInteractions = metaNumberValue(totais.total_interactions);
        for (const [nome, valor] of Object.entries(totais)) {
          somaDoDia[nome] = (somaDoDia[nome] ?? 0) + valor;
        }
      }

      // `saved` na métrica por mídia é `saves` na linha diária. Nomes diferentes
      // para a mesma coisa, e a coluna do banco segue o nome da conta.
      if (somaDoDia.saved !== undefined) somaDoDia.saves = somaDoDia.saved;

      const linha = metaDailyMetricRow({
        profile,
        metricDate: hoje,
        totals: somaDoDia,
        // `partial` de propósito: o dia ainda está aberto e o número vai subir.
        // É o que impede alguém de comparar hoje com um dia fechado como se
        // fossem a mesma medida.
        coverageStatus: 'partial',
        posts: dePostsDeHoje.length,
        sourcePayload: {
          source: 'meta_graph',
          endpoint: 'media_insights',
          posts: dePostsDeHoje.length,
          nota: 'soma dos insights dos posts publicados hoje; a conta não entrega o dia corrente',
        },
      });
      // Exige métrica de verdade, não só "houve post".
      //
      // `metaDailyRowHasSignal` aceita `posts > 0`, e é o certo para o dia
      // fechado — publicar sem view é um fato. Para o dia corrente não serve:
      // enquanto os insights não vierem, uma linha com 13 posts e tudo zerado
      // afirma "13 posts, nenhuma visualização", que é diferente de "ainda não
      // medi". Foi exatamente o que 108 perfis gravaram antes desta guarda.
      const temMetrica = linha.views > 0 || linha.reach > 0 || linha.interactions > 0
        || linha.likes > 0 || linha.comments > 0;
      if (temMetrica) todayRow = linha;
    }
  }

  const collectedSomething = dailyRows.length > 0 || followersCount > 0 || posts.length > 0;
  const status: MetaAnalyticsStatus = insightFailure && dailyRows.length === 0
    ? insightFailure.status
    : partialSources.length > 0
      ? 'partial'
      : collectedSomething ? 'synced' : 'no_data';

  return {
    ...base,
    status,
    failure: insightFailure,
    followersCount,
    mediaCount,
    dailyRows,
    windowTotals,
    posts,
    todayRow,
    partialSources,
    appUsagePercent: lastAppUsagePercent,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Resposta CRUA da Meta para um dia, para diagnóstico.
 *
 * Existe porque "a coleta não trouxe nada" tem duas causas opostas — a Meta
 * respondeu vazio, ou respondeu erro e nós engolimos — e da telemetria normal
 * as duas parecem iguais. Usada só por `npm run probe:meta-analytics`.
 */
export async function probeDayInsightsRaw(profile: MetaAnalyticsProfile, metricDate: string, now = Date.now()) {
  if (!profile.encrypted_access_token) return { erro: 'perfil sem token' };
  const token = decryptToken(profile.encrypted_access_token);
  const window = saoPauloDayWindow(metricDate, now);
  const response = await graphGet('me/insights', {
    metric: META_ACCOUNT_INSIGHT_METRICS.join(','),
    period: 'day',
    metric_type: 'total_value',
    since: String(window.since),
    until: String(window.until),
  }, token);
  return {
    dia: metricDate,
    janela: { since: new Date(window.since * 1000).toISOString(), until: new Date(window.until * 1000).toISOString() },
    httpStatus: response.httpStatus,
    body: response.body,
  };
}

/**
 * Chamada crua de insights com janela arbitrária, para diagnóstico.
 *
 * Serve para responder perguntas sobre o COMPORTAMENTO da API — que janela ela
 * aceita, a partir de quando o dia corrente existe — sem depender de
 * documentação, que nesta API envelhece mais rápido que a própria API.
 * Usada só por `npm run probe:meta-analytics -- --janelas`.
 */
export async function probeInsightsWindow(
  profile: MetaAnalyticsProfile,
  options: { since?: number; until?: number; metricType?: 'total_value' | 'time_series'; metrics?: string[] },
) {
  if (!profile.encrypted_access_token) return { erro: 'perfil sem token' };
  const token = decryptToken(profile.encrypted_access_token);
  const params: Record<string, string> = {
    metric: (options.metrics ?? ['reach', 'views']).join(','),
    period: 'day',
  };
  if (options.metricType) params.metric_type = options.metricType;
  if (options.since) params.since = String(options.since);
  if (options.until) params.until = String(options.until);
  const response = await graphGet('me/insights', params, token);
  return { httpStatus: response.httpStatus, body: response.body };
}

/**
 * Insights de UMA mídia, para diagnóstico.
 *
 * O endpoint de conta (`/me/insights`) só entrega dias fechados — medido em
 * 05/09/2026 com sete formatos de janela diferentes. Este é o outro caminho: a
 * métrica por post, que existe desde a publicação. Usado por
 * `npm run probe:meta-analytics -- --midias`.
 */
export async function probeMediaInsights(profile: MetaAnalyticsProfile, mediaId: string, metrics: string[]) {
  if (!profile.encrypted_access_token) return { erro: 'perfil sem token' };
  const token = decryptToken(profile.encrypted_access_token);
  const response = await graphGet(`${mediaId}/insights`, { metric: metrics.join(',') }, token);
  return { httpStatus: response.httpStatus, body: response.body };
}

/** Endpoint de lote oficial (`batch=[...]`), para diagnóstico. */
export async function probeGraphBatch(profile: MetaAnalyticsProfile, mediaIds: string[]) {
  if (!profile.encrypted_access_token) return { erro: 'perfil sem token' };
  const token = decryptToken(profile.encrypted_access_token);
  const lote = mediaIds.slice(0, 3).map((id) => ({ method: 'GET', relative_url: `${id}/insights?metric=views,reach` }));
  const corpo = new URLSearchParams({ access_token: token, batch: JSON.stringify(lote) });
  const res = await fetch(`https://graph.instagram.com/${process.env.META_GRAPH_API_VERSION ?? 'v26.0'}/`, {
    method: 'POST',
    body: corpo,
  });
  return { httpStatus: res.status, body: await res.json().catch(() => null) };
}

/** Chamada em lote de insights por mídia, crua, para diagnóstico. */
export async function probeBatchedMediaInsights(profile: MetaAnalyticsProfile, mediaIds: string[]) {
  if (!profile.encrypted_access_token) return { erro: 'perfil sem token' };
  const token = decryptToken(profile.encrypted_access_token);
  const response = await graphGet('', {
    ids: mediaIds.slice(0, 3).join(','),
    fields: `insights.metric(${['views', 'reach', 'likes'].join(',')})`,
  }, token);
  return { httpStatus: response.httpStatus, body: response.body };
}

/** Total de interações da janela, para o snapshot agregado. */
export function collectionInteractions(collection: MetaAnalyticsCollection) {
  return metaInteractions(collection.windowTotals);
}
