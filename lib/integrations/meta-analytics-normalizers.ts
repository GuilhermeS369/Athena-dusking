// Normalização das respostas de insights da API da Meta (Instagram Login for
// Business) para as MESMAS tabelas que a coleta da Zernio já alimenta.
//
// POR QUE ISTO EXISTE. Até 04/09/2026 a coleta de métricas só sabia falar com a
// Zernio. Quando ela suspendeu as conexões e a frota foi religada pela API
// oficial, `syncProfileAnalytics` passou a gravar um snapshot ZERADO com
// `sync_status = 'not_configured'` para todo perfil `meta_official` — 944 deles
// em 05/09/2026. Como a dashboard lê o snapshot mais recente por perfil, o
// histórico preservado pela tomada de perfil (migrations 373/374/375) ficava
// escondido atrás de uma linha de zeros. O histórico nunca foi perdido; ele
// parou de ser CONTINUADO, e passou a ser encoberto.
//
// O módulo não importa nada de propósito: o runner nativo do Node não resolve o
// alias `@/`, e a lógica que decide número, data e status precisa de teste.

/** Espelha `AnalyticsStatus` de zernio-analytics.ts; repetido para não importar. */
export type MetaAnalyticsStatus =
  | 'pending' | 'synced' | 'partial' | 'no_data' | 'not_configured'
  | 'permission_missing' | 'rate_limited' | 'failed';

export type MetaInsightTotals = Record<string, number>;

export type MetaDailyMetricRow = {
  organization_id: string;
  profile_id: string;
  provider: string;
  metric_date: string;
  posts: number;
  impressions: number;
  reach: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  interactions: number;
  coverage_status: 'complete' | 'partial';
  source_payload: Record<string, unknown>;
  normalized_at: string;
};

/**
 * Métricas pedidas por padrão em `/me/insights`.
 *
 * A lista é uma APOSTA CONSCIENTE, não um contrato: a Meta muda a
 * disponibilidade de métrica por versão da API e por tipo de conta, e responde
 * com erro 100 quando uma delas não se aplica. Em vez de fixar a lista "certa"
 * (que envelhece), `unsupportedMetricsFromError` lê o nome recusado na
 * mensagem e a coleta repete sem ele. Ver `META_MINIMUM_METRICS` para o piso.
 */
export const META_ACCOUNT_INSIGHT_METRICS = [
  'reach',
  'views',
  'likes',
  'comments',
  'shares',
  'saves',
  'replies',
  'total_interactions',
  'accounts_engaged',
  'profile_links_taps',
];

/**
 * O que sobra quando a Meta recusa tudo o mais. Se nem isto passar, o perfil é
 * marcado como sem métrica na janela — e não como falha, que acionaria alarme.
 */
export const META_MINIMUM_METRICS = ['reach', 'views'];

export function metaNumberValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed));
  }
  return 0;
}

/**
 * Extrai os totais de uma resposta de `/insights`.
 *
 * A Meta devolve duas formas para o mesmo endpoint, e as duas aparecem em
 * produção dependendo da métrica e do `metric_type`:
 *   - `total_value: { value: N }`   (metric_type=total_value)
 *   - `values: [{ value: N, end_time }]` (série temporal)
 * Somar `values` é o comportamento certo para uma janela de um dia, que é como
 * a coleta pede — e continua correto se a janela crescer, porque o consumidor
 * quer o total dela.
 */
export function metaInsightTotals(payload: unknown): MetaInsightTotals {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return {};

  const totals: MetaInsightTotals = {};
  for (const raw of data) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (!name) continue;

    const totalValue = entry.total_value as { value?: unknown } | undefined;
    if (totalValue && typeof totalValue === 'object' && 'value' in totalValue) {
      totals[name] = metaNumberValue(totalValue.value);
      continue;
    }

    if (Array.isArray(entry.values)) {
      totals[name] = entry.values.reduce((sum: number, item: unknown) => {
        const bucket = item as { value?: unknown } | null;
        return sum + metaNumberValue(bucket?.value);
      }, 0);
    }
  }
  return totals;
}

/**
 * Interações do dia.
 *
 * `total_interactions` é o número da própria Meta e tem precedência. A soma
 * manual entra só quando ele não vem — e ela NÃO é equivalente: a Meta conta
 * também respostas e outras ações. Preferir o dela mantém a dashboard falando a
 * mesma língua do app do Instagram, que é onde o operador confere.
 */
export function metaInteractions(totals: MetaInsightTotals) {
  if (totals.total_interactions > 0) return totals.total_interactions;
  return metaNumberValue(totals.likes) + metaNumberValue(totals.comments)
    + metaNumberValue(totals.shares) + metaNumberValue(totals.saves)
    + metaNumberValue(totals.replies);
}

export function metaDailyMetricRow(input: {
  profile: { id: string; organization_id: string };
  metricDate: string;
  totals: MetaInsightTotals;
  posts: number;
  coverageStatus: 'complete' | 'partial';
  sourcePayload?: Record<string, unknown>;
  normalizedAt?: string;
}): MetaDailyMetricRow {
  const { totals } = input;
  return {
    organization_id: input.profile.organization_id,
    profile_id: input.profile.id,
    provider: 'meta_official',
    metric_date: input.metricDate,
    posts: metaNumberValue(input.posts),
    // A Meta aposentou `impressions` para contas de Instagram nas versões
    // recentes e o substituto é `views`. A coluna continua existindo (o
    // histórico da Zernio a usa), então ela é gravada como zero em vez de
    // receber uma cópia de views — copiar inventaria uma métrica.
    impressions: 0,
    reach: metaNumberValue(totals.reach),
    views: metaNumberValue(totals.views),
    likes: metaNumberValue(totals.likes),
    comments: metaNumberValue(totals.comments),
    shares: metaNumberValue(totals.shares),
    saves: metaNumberValue(totals.saves),
    interactions: metaInteractions(totals),
    coverage_status: input.coverageStatus,
    source_payload: input.sourcePayload ?? {},
    normalized_at: input.normalizedAt ?? new Date().toISOString(),
  };
}

/** Uma linha diária só vale gravação se disser alguma coisa. */
export function metaDailyRowHasSignal(row: MetaDailyMetricRow) {
  return row.reach > 0 || row.views > 0 || row.interactions > 0
    || row.likes > 0 || row.comments > 0 || row.shares > 0 || row.saves > 0
    || row.posts > 0;
}

/**
 * Descobre, pela mensagem de erro, quais métricas a Meta recusou.
 *
 * A Meta responde erro 100 com textos do tipo "(#100) The following metrics
 * should not be queried with metric_type=total_value: profile_links_taps" ou
 * "metric[0] must be one of the following values: ...". Em vez de manter uma
 * tabela de compatibilidade que envelhece a cada versão da API, a coleta lê o
 * nome citado e tenta de novo sem ele.
 *
 * Só considera nomes que ESTAVAM sendo pedidos: a mensagem também lista os
 * valores aceitos, e casar com eles removeria justamente as métricas boas.
 */
export function unsupportedMetricsFromError(message: string, requested: string[]) {
  const text = String(message ?? '');
  const offendingSection = text.split(':').slice(1).join(':') || text;
  return requested.filter((metric) => new RegExp(`\\b${metric}\\b`).test(offendingSection));
}

export type MetaAnalyticsFailure = {
  status: MetaAnalyticsStatus;
  code: string;
  message: string;
  retryable: boolean;
};

/**
 * Traduz uma falha da Graph API para o vocabulário de `sync_status`.
 *
 * O caso que importa é o 190/401: token vencido é ROTINA na Meta (o de longa
 * duração vale 60 dias) e a renovação automática existe. Marcar como falha
 * definitiva acenderia alarme em cima de manutenção normal — o mesmo raciocínio
 * de `isRetryableGraphFailure` no caminho de publicação.
 */
export function classifyMetaAnalyticsFailure(input: {
  httpStatus: number;
  graphCode?: number;
  graphSubcode?: number;
  message?: string;
  isTransient?: boolean;
}): MetaAnalyticsFailure {
  const message = input.message?.trim() || 'A Meta não respondeu às métricas deste perfil.';
  const code = input.graphCode ? `meta_${input.graphCode}` : `meta_http_${input.httpStatus}`;

  if (input.httpStatus === 401 || input.graphCode === 190) {
    return { status: 'permission_missing', code, message, retryable: true };
  }
  if (input.httpStatus === 403 || input.graphCode === 10 || input.graphCode === 200) {
    return { status: 'permission_missing', code, message, retryable: false };
  }
  if (input.httpStatus === 429 || input.graphCode === 4 || input.graphCode === 17 || input.graphCode === 32 || input.graphCode === 613) {
    return { status: 'rate_limited', code, message, retryable: true };
  }
  if (input.httpStatus >= 500 || input.graphCode === 1 || input.graphCode === 2 || input.isTransient) {
    return { status: 'failed', code, message, retryable: true };
  }
  return { status: 'failed', code, message, retryable: false };
}

/**
 * Fatia do dia em segundos epoch, no fuso da operação.
 *
 * São Paulo não tem horário de verão desde 2019, então o deslocamento fixo de
 * -03:00 é exato — e é o mesmo que o resto do sistema usa para decidir "o dia
 * de hoje". A Meta agrega insights no fuso da CONTA, que pode divergir; por
 * isso a coleta pede um dia por chamada e carimba a data que pediu, em vez de
 * confiar num `end_time` que viria em outro fuso.
 */
/**
 * A data que um balde de insights REALMENTE cobre, lida do `end_time` da Meta.
 *
 * ESTE É O ERRO MAIS CARO QUE ESTA COLETA JÁ TEVE, e ele não aparecia como
 * erro. A Meta agrega o dia no fuso da CONTA, e as contas desta frota estão em
 * horário do Pacífico: medido em 05/09/2026, TODO balde volta com
 * `end_time = ...T07:00:00+0000`, que é meia-noite em Los Angeles.
 *
 * Nós pedíamos a janela do dia de São Paulo (03:00Z → 03:00Z) e carimbávamos o
 * resultado com a data que tínhamos pedido. Só que a única fatia que cai nessa
 * janela é a que termina às 07:00Z do MESMO dia — e ela cobre das 04:00 de
 * ONTEM às 04:00 de hoje, hora de São Paulo. Resultado: todo número ficava um
 * dia adiantado. O que a tela chamava de "hoje" era ontem.
 *
 * A correção é não adivinhar: o `end_time` diz onde o dia da conta termina, e
 * daí sai tanto o fuso quanto a data. Se a meia-noite local cai às `h` horas
 * UTC, o deslocamento é `-h` (para h ≤ 12) ou `24-h` (para o resto) — e a data
 * do balde é a do seu início, já nesse fuso.
 */
export function metaBucketLocalDate(endTime: string) {
  const end = Date.parse(endTime);
  if (Number.isNaN(end)) return null;

  const boundary = new Date(end);
  const hour = boundary.getUTCHours();
  const minutes = boundary.getUTCMinutes();
  const offsetHours = hour <= 12 ? -hour : 24 - hour;
  const start = end - 86_400_000 + offsetHours * 3_600_000 - minutes * 60_000;
  return new Date(start).toISOString().slice(0, 10);
}

export function saoPauloDayWindow(date: string, now = Date.now()) {
  const start = Date.parse(`${date}T00:00:00-03:00`);
  if (Number.isNaN(start)) throw new Error(`Data inválida para janela de coleta: ${date}`);

  const since = Math.floor(start / 1000);
  const fimDoDia = since + 86_400;
  // O dia corrente termina AGORA, não à meia-noite que ainda não chegou.
  //
  // Pedir `until` no futuro é pedir uma janela que ainda não existe, e foi o
  // que manteve "Hoje" zerado na dashboard: às 01h de 05/09/2026 a coleta pedia
  // 05/09 00:00 → 06/09 00:00 — 22,5 horas à frente — e voltava sem métrica
  // nenhuma para 1.030 publicações já feitas no dia. Os dias fechados vinham
  // certos porque neles `until` já era passado.
  //
  // O piso de uma hora existe para a virada do dia: à 00h05 o intervalo seria
  // de cinco minutos, e uma janela quase vazia é o mesmo que nenhuma.
  const until = Math.max(since + 3_600, Math.min(fimDoDia, Math.floor(now / 1000)));
  return { since, until };
}

/** A data, no fuso da operação, de um instante ISO qualquer. */
export function saoPauloDayOf(iso: string) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return saoPauloDay(0, ms);
}

/** Dia corrente em São Paulo, deslocado por `daysAgo`. */
export function saoPauloDay(daysAgo = 0, now = Date.now()) {
  const date = new Date(now - daysAgo * 86_400_000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/**
 * Uso do app relatado pelo cabeçalho `X-App-Usage`.
 *
 * Ninguém lia este cabeçalho até aqui — está registrado como pendência em
 * docs/migracao-meta-prontidao-da-fila.md. Ele é o único número REAL do limite
 * da Meta: o teto por app é dinâmico e não tem valor publicado para cravar.
 * A coleta o usa para desacelerar sozinha antes de tomar 429.
 */
export function parseMetaAppUsage(header: string | null) {
  if (!header) return null;
  try {
    const parsed = JSON.parse(header) as Record<string, unknown>;
    // O PIOR de todos os eixos, sejam quais forem os nomes.
    //
    // A primeira versão desta função procurava `call_count`, `total_cputime` e
    // `total_time`, que é o formato do cabeçalho da Graph API do Facebook.
    // `graph.instagram.com` manda outro: medido em 05/09/2026,
    // `{"call_volume":0,"cpu_time":0}`. Nenhum dos três nomes existia ali, e o
    // resultado era um 0% constante — uma válvula de segurança que reportava
    // folga sempre, inclusive se estivéssemos em 99%.
    //
    // Ler todo valor numérico do objeto resolve os dois formatos e o próximo:
    // o que a Meta manda são percentuais de consumo, e o que interessa é o
    // maior deles.
    const percent = Math.max(
      0,
      ...Object.values(parsed).filter((value) => typeof value === 'number').map((value) => metaNumberValue(value)),
    );
    return { percent, raw: parsed };
  } catch {
    return null;
  }
}
