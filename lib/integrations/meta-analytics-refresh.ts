import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  collectMetaProfileAnalytics,
  collectionInteractions,
  collectionLatestDayInteractions,
  metaAppUsagePressure,
  type MetaAnalyticsCollection,
  type MetaAnalyticsProfile,
} from '@/lib/integrations/meta-analytics';
import { metaNumberValue, saoPauloDay, type MetaDailyMetricRow } from '@/lib/integrations/meta-analytics-normalizers';

/**
 * Rodada de coleta de métricas da Meta sobre um conjunto de perfis.
 *
 * O QUE MUDA EM RELAÇÃO À COLETA DA ZERNIO. Lá, cada perfil vira um item de
 * fila com lease, uma execução (`profile_analytics_sync_runs`) e um arquivo de
 * payload — três escritas por perfil ANTES de qualquer métrica. Isso fazia
 * sentido quando cada perfil tinha credencial própria e a coleta podia parar no
 * meio por limite de uma conta específica. Com ~37 apps para a frota inteira,
 * esse aparato custa mais banco do que a própria métrica.
 *
 * Aqui a rodada coleta em paralelo e escreve EM LOTE: uma requisição por tabela
 * por lote, não por perfil. Uma passada de 60 perfis são ~180 chamadas à Meta e
 * 4 requisições ao Supabase.
 *
 * INVARIANTE QUE NÃO PODE CAIR: um perfil que falhou NUNCA grava linha zerada.
 * Foi exatamente isso que escondeu o histórico de 944 perfis religados em
 * 05/09/2026 — `syncProfileAnalytics` gravava um snapshot de zeros com
 * `sync_status = 'not_configured'`, e a dashboard, que lê o snapshot mais
 * recente, passou a mostrar zero para contas com meses de histórico. Erro vai
 * para `profile_analytics_current` (uma linha por perfil, sobrescrita), nunca
 * para uma linha nova de período.
 */

/**
 * Teto de perfis por passada. Não é limite da Meta: é o tamanho de lote que
 * cabe no orçamento de 60s de uma função da Vercel com folga para a resposta.
 */
export const META_REFRESH_MAX_BATCH = 500;

export type MetaRefreshOptions = {
  organizationId?: string | null;
  profileIds?: string[] | null;
  /** Teto de perfis nesta passada. */
  limit?: number;
  /** Só coleta perfis parados há mais do que isto. `0` força todos. */
  staleMinutes?: number;
  /**
   * Instante fixo: só entra quem foi coletado ANTES disto.
   *
   * É o critério da rodada — "ainda não visitado desde que ela começou". A
   * versão com minutos não serve para isso: a janela anda junto com a rodada e
   * o perfil coletado no início volta a ser elegível no fim (migration 390).
   */
  collectedBefore?: string | null;
  /** Dias coletados por perfil, de hoje para trás. */
  days?: number;
  collectPosts?: boolean;
  /** Soma os posts de hoje para montar a linha do dia corrente. */
  collectToday?: boolean;
  /** Interrompe a rodada quando o tempo estourar, devolvendo o que já fez. */
  timeBudgetMs?: number;
  concurrency?: number;
};

export type MetaRefreshSummary = {
  requested: number;
  processed: number;
  synced: number;
  partial: number;
  noData: number;
  failed: number;
  dailyRowsWritten: number;
  followerRowsWritten: number;
  postRowsWritten: number;
  remaining: number;
  appUsagePercent: number | null;
  durationMs: number;
  errors: Array<{ profileId: string; code: string; message: string }>;
};

type CandidateRow = {
  profile_id: string;
  organization_id: string;
  username: string | null;
  instagram_user_id: string | null;
  last_synced_at: string | null;
  pending_count?: number;
};

/**
 * Escolhe quem coletar.
 *
 * A ordem é por quem está parado há mais tempo, resolvida no banco pela RPC
 * `select_meta_analytics_refresh_batch` (migration 380) — ler os 958 perfis
 * para ordenar em memória a cada ciclo seria o tipo de leitura que a regra de
 * `max_rows` deste repositório existe para evitar.
 */
export async function selectMetaRefreshBatch(options: MetaRefreshOptions): Promise<{ candidates: CandidateRow[]; remaining: number }> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc('select_meta_analytics_refresh_batch', {
    p_organization_id: options.organizationId ?? null,
    p_profile_ids: options.profileIds ?? null,
    p_limit: Math.min(Math.max(options.limit ?? 60, 1), META_REFRESH_MAX_BATCH),
    p_stale_minutes: Math.max(options.staleMinutes ?? 45, 0),
    p_collected_before: options.collectedBefore ?? null,
  });
  if (error) throw error;

  const rows = (data ?? []) as CandidateRow[];
  const remaining = Math.max((rows[0]?.pending_count ?? rows.length) - rows.length, 0);
  return { candidates: rows, remaining };
}

/**
 * Datas que já têm métrica de outro provedor.
 *
 * Sem isto a migração para a Meta somaria duas vezes o mesmo dia: as linhas da
 * Zernio ficam com `provider = 'zernio'` e as novas com `meta_official`, e a
 * dashboard soma os dois provedores no mesmo perfil de propósito — é assim que
 * o histórico reaproveitado continua aparecendo. Reescrever um dia que a Zernio
 * já contou dobraria o número na tela.
 */
async function datesAlreadyCoveredByAnotherProvider(profileIds: string[], since: string) {
  const admin = createSupabaseAdminClient();
  const covered = new Map<string, Set<string>>();
  if (profileIds.length === 0) return covered;

  const { data, error } = await admin
    .from('profile_analytics_daily_metrics')
    .select('profile_id, metric_date')
    .in('profile_id', profileIds)
    .neq('provider', 'meta_official')
    .gte('metric_date', since)
    // Janela de poucos dias vezes poucas centenas de perfis: bem abaixo do teto
    // do PostgREST, e a ordem total mantém a leitura determinística.
    .order('profile_id', { ascending: true })
    .order('metric_date', { ascending: true })
    .limit(1000);
  if (error) throw error;

  for (const row of data ?? []) {
    const set = covered.get(row.profile_id) ?? new Set<string>();
    set.add(row.metric_date);
    covered.set(row.profile_id, set);
  }
  return covered;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function runMetaAnalyticsRefresh(options: MetaRefreshOptions = {}): Promise<MetaRefreshSummary> {
  const startedAt = Date.now();
  const admin = createSupabaseAdminClient();
  const days = Math.min(Math.max(options.days ?? 2, 1), 30);
  const timeBudgetMs = options.timeBudgetMs ?? 45_000;

  const { candidates, remaining } = await selectMetaRefreshBatch(options);
  const summary: MetaRefreshSummary = {
    requested: candidates.length,
    processed: 0,
    synced: 0,
    partial: 0,
    noData: 0,
    failed: 0,
    dailyRowsWritten: 0,
    followerRowsWritten: 0,
    postRowsWritten: 0,
    remaining,
    appUsagePercent: null,
    durationMs: 0,
    errors: [],
  };
  if (candidates.length === 0) {
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const profileIds = candidates.map((row) => row.profile_id);
  // O token é lido só para os perfis desta passada, e nunca sai daqui: não vai
  // para log, resposta de API nem telemetria.
  const { data: profileRows, error: profileError } = await admin
    .from('instagram_profiles')
    .select('id, organization_id, username, instagram_user_id, encrypted_access_token')
    .in('id', profileIds)
    .is('deleted_at', null)
    // O lote já vem limitado por META_REFRESH_MAX_BATCH; o teto explícito é o
    // que prova para a varredura de row-limit que esta leitura não escala.
    .limit(META_REFRESH_MAX_BATCH);
  if (profileError) throw profileError;

  const profiles = (profileRows ?? []) as MetaAnalyticsProfile[];
  // Dois dias a mais de folga: o dia da CONTA (fuso do Pacífico, nestas contas)
  // pode ficar atrás do nosso calendário, então a data que a coleta vai
  // carimbar às vezes é anterior à janela que o nosso relógio calcularia.
  const skipDates = await datesAlreadyCoveredByAnotherProvider(profileIds, saoPauloDay(days + 1));

  const collections = await mapWithConcurrency(profiles, options.concurrency ?? 6, async (profile) => {
    if (Date.now() - startedAt > timeBudgetMs) return null;
    if (metaAppUsagePressure() === 'stop') return null;
    try {
      return await collectMetaProfileAnalytics(profile, {
        days,
        collectPosts: options.collectPosts ?? false,
        collectToday: options.collectToday ?? false,
        skipDates: skipDates.get(profile.id),
      });
    } catch (error) {
      return {
        profileId: profile.id,
        organizationId: profile.organization_id,
        status: 'failed' as const,
        failure: { status: 'failed' as const, code: 'meta_collect_threw', message: (error as Error)?.message ?? 'Falha inesperada.', retryable: true },
        periodStart: saoPauloDay(days - 1),
        periodEnd: saoPauloDay(0),
        followersCount: null,
        mediaCount: null,
        dailyRows: [],
        windowTotals: {},
        latestDayTotals: {},
        latestDayDate: null,
        posts: [],
        todayRow: null,
        partialSources: [],
        appUsagePercent: null,
        durationMs: 0,
      } satisfies MetaAnalyticsCollection;
    }
  });

  const done = collections.filter((entry): entry is MetaAnalyticsCollection => entry !== null);
  summary.processed = done.length;
  summary.remaining = remaining + (candidates.length - done.length);

  await persistMetaAnalyticsCollections(done, summary);

  summary.durationMs = Date.now() - startedAt;
  return summary;
}

/** Escreve em lote o que a rodada coletou. Uma requisição por tabela. */
export async function persistMetaAnalyticsCollections(collections: MetaAnalyticsCollection[], summary: MetaRefreshSummary) {
  const admin = createSupabaseAdminClient();
  const syncedAt = new Date().toISOString();
  const today = saoPauloDay(0);

  const dailyRows: MetaDailyMetricRow[] = [];
  const followerRows: Array<Record<string, unknown>> = [];
  const snapshotRows: Array<Record<string, unknown>> = [];
  // Duas listas, e a razão é uma armadilha do PostgREST: num upsert em lote ele
  // normaliza as linhas pela UNIÃO das chaves e preenche com NULL o que faltar
  // em cada uma — não com o DEFAULT da coluna. Misturar "linha com números" e
  // "linha só de situação" no mesmo array fazia `followers_count` chegar nulo e
  // a escrita inteira falhar por not-null. Separadas, a de situação atualiza
  // apenas as colunas de estado e preserva os números que já estavam lá.
  const currentRowsWithNumbers: Array<Record<string, unknown>> = [];
  const currentRowsStatusOnly: Array<Record<string, unknown>> = [];
  const currentRowsTimestamps: Array<Record<string, unknown>> = [];
  const postRows: Array<Record<string, unknown>> = [];

  for (const collection of collections) {
    if (collection.status === 'synced') summary.synced += 1;
    else if (collection.status === 'partial') summary.partial += 1;
    else if (collection.status === 'no_data') summary.noData += 1;
    else {
      summary.failed += 1;
      if (collection.failure) {
        summary.errors.push({ profileId: collection.profileId, code: collection.failure.code, message: collection.failure.message });
      }
    }
    if (collection.appUsagePercent !== null) summary.appUsagePercent = collection.appUsagePercent;

    dailyRows.push(...collection.dailyRows);
    // A linha do dia corrente vem dos posts, não da conta (ver `todayRow`).
    // Ela entra no mesmo lote: uma linha por perfil, sem custo extra de escrita.
    if (collection.todayRow) dailyRows.push(collection.todayRow);

    // Seguidores: a foto do dia. A Meta não devolve série diária confiável para
    // conta pequena, então quem guarda a linha do tempo é o Athena — uma linha
    // por dia, sobrescrita à vontade dentro do mesmo dia.
    if (collection.followersCount !== null && collection.followersCount > 0) {
      followerRows.push({
        organization_id: collection.organizationId,
        profile_id: collection.profileId,
        provider: 'meta_official',
        snapshot_date: today,
        followers_count: collection.followersCount,
        // Ganhos e perdas do dia não vêm da API oficial para estas contas. Zero
        // aqui significa "não medido", e é por isso que a variação exibida na
        // dashboard vem da diferença entre fotos, não desta coluna.
        followers_gained: 0,
        followers_lost: 0,
        raw_payload: {},
        sync_status: 'synced',
        synced_at: syncedAt,
        deleted_at: null,
      });
    }

    const interactions = collectionInteractions(collection);
    const reach = metaNumberValue(collection.windowTotals.reach);
    const hasNumbers = collection.dailyRows.length > 0 || (collection.followersCount ?? 0) > 0;

    // Só quem tem número vira linha de período. Erro nunca cria snapshot: ele
    // apagaria da tela o último dado bom deste perfil.
    if (hasNumbers) {
      snapshotRows.push({
        organization_id: collection.organizationId,
        profile_id: collection.profileId,
        provider: 'meta_official',
        period_start: collection.periodStart,
        period_end: collection.periodEnd,
        followers_count: collection.followersCount ?? 0,
        followers_delta: 0,
        followers_gained: 0,
        followers_lost: 0,
        impressions: 0,
        reach,
        views: metaNumberValue(collection.windowTotals.views),
        likes: metaNumberValue(collection.windowTotals.likes),
        comments: metaNumberValue(collection.windowTotals.comments),
        shares: metaNumberValue(collection.windowTotals.shares),
        saves: metaNumberValue(collection.windowTotals.saves),
        replies: metaNumberValue(collection.windowTotals.replies),
        total_interactions: interactions,
        profile_links_taps: metaNumberValue(collection.windowTotals.profile_links_taps),
        posts_count: collection.posts.length,
        engagement_rate: reach > 0 ? Number(((interactions / reach) * 100).toFixed(4)) : 0,
        sync_status: collection.status,
        unavailable_reason: collection.status === 'partial'
          ? `Coleta parcial; fontes pendentes: ${collection.partialSources.join(', ')}.`
          : null,
        last_error_code: null,
        last_error_message: null,
        raw_payload: { source: 'meta_graph', totals: collection.windowTotals, days: collection.dailyRows.length },
        synced_at: syncedAt,
        deleted_at: null,
      });
    }

    // O ESTADO CORRENTE MEDE UM DIA, NÃO A JANELA — e esta é a diferença entre
    // esta tabela e a de período logo acima.
    //
    // `profile_analytics_current` é o que a coluna "Views" de /perfis mostra, e
    // ela mostra o número CRU, sem período ao lado. Enquanto isso vinha de
    // `windowTotals`, o número era a soma dos dias coletados — e quantos dias
    // são muda com a passada: `days = deepPass ? 4 : 2` no despacho de 5 em 5
    // minutos. Medido em 07/09/2026 na organização Pomodoro: 572 perfis
    // exibindo soma de 4 dias contra 428 exibindo soma de 2, lado a lado na
    // mesma coluna. Para uma conta com tráfego parelho, somar dois dias é
    // mostrar o dobro (1269 = 671 + 598), e uma hora depois o quádruplo.
    //
    // Um dia fechado não tem esse problema: é o mesmo recorte para todo perfil,
    // independentemente de qual cron passou por último, e é comparável entre
    // duas linhas da tabela. A soma da janela continua existindo, na linha de
    // período, que carrega `period_start`/`period_end` e por isso pode somar.
    const latestDay = collection.latestDayTotals;
    const latestDayReach = metaNumberValue(latestDay.reach);
    const latestDayInteractions = collectionLatestDayInteractions(collection);

    const currentState = {
      organization_id: collection.organizationId,
      profile_id: collection.profileId,
      provider: 'meta_official',
      sync_status: collection.status,
      unavailable_reason: collection.failure && collection.status !== 'failed' ? collection.failure.message : null,
      last_error_code: collection.failure?.code ?? null,
      last_error_message: collection.failure?.message ?? null,
      current_synced_at: syncedAt,
      deleted_at: null,
    };
    if (hasNumbers) {
      currentRowsWithNumbers.push({
        ...currentState,
        // Começo e fim são o MESMO dia, e é isso que o número representa. A
        // tela pode escrever a data em vez de exibir um total anônimo.
        period_start: collection.latestDayDate,
        period_end: collection.latestDayDate,
        followers_count: collection.followersCount ?? 0,
        reach: latestDayReach,
        views: metaNumberValue(latestDay.views),
        likes: metaNumberValue(latestDay.likes),
        comments: metaNumberValue(latestDay.comments),
        shares: metaNumberValue(latestDay.shares),
        saves: metaNumberValue(latestDay.saves),
        replies: metaNumberValue(latestDay.replies),
        total_interactions: latestDayInteractions,
        profile_links_taps: metaNumberValue(latestDay.profile_links_taps),
        engagement_rate: latestDayReach > 0 ? Number(((latestDayInteractions / latestDayReach) * 100).toFixed(4)) : 0,
      });
    } else {
      // Sem número não há período a declarar, e as colunas ficam FORA da
      // escrita de propósito: elas são nuláveis, então não mandá-las preserva
      // o último período bom em vez de carimbar por cima o palpite do
      // calendário. Uma falha não pode apagar a medição anterior — é a mesma
      // invariante do cabeçalho deste arquivo.
      currentRowsStatusOnly.push(currentState);
    }

    // Os carimbos de "quando coletei diária/mídias" vão numa escrita própria, e
    // só para quem coletou de fato nesta passada. Mandá-los junto obrigaria a
    // gravar `null` nos ciclos curtos (que não pedem mídia) e apagaria a
    // informação de que a coleta funcionou meia hora atrás.
    if (collection.dailyRows.length > 0 || collection.posts.length > 0) {
      currentRowsTimestamps.push({
        organization_id: collection.organizationId,
        profile_id: collection.profileId,
        provider: 'meta_official',
        ...(collection.dailyRows.length > 0 ? { daily_synced_at: syncedAt } : {}),
        ...(collection.posts.length > 0 ? { posts_synced_at: syncedAt, posts_count: collection.posts.length } : {}),
      });
    }

    for (const post of collection.posts) {
      const postInteractions = post.likes + post.comments;
      postRows.push({
        organization_id: collection.organizationId,
        profile_id: collection.profileId,
        provider: 'meta_official',
        // A coluna nasceu com nome da Zernio, mas o papel dela é "id do post no
        // provedor". O prefixo evita qualquer chance de um id da Meta colidir
        // com um id da Zernio na mesma organização.
        zernio_post_id: `meta:${post.mediaId}`,
        platform_post_id: post.mediaId,
        platform_post_url: post.permalink,
        // A coluna aceita 'athena' | 'zernio' | 'external' (migration 057). A
        // mídia vem da conta no Instagram, não da nossa fila, então ela é
        // externa — quem diz o provedor é a coluna `provider` ao lado.
        source: 'external',
        status: 'published',
        content: post.caption,
        media_type: post.mediaType,
        thumbnail_url: post.thumbnailUrl,
        published_at: post.timestamp,
        impressions: 0,
        reach: post.reach,
        views: post.views,
        likes: post.likes,
        comments: post.comments,
        shares: post.shares,
        saves: post.saved,
        clicks: 0,
        follows: 0,
        total_interactions: post.totalInteractions || postInteractions,
        engagement_rate: 0,
        // `synced` quando os insights por mídia vieram; `partial` quando só
        // temos curtidas e comentários da listagem. A Recuperação lê essa
        // coluna para decidir o que é medição e o que é ausência dela.
        sync_status: post.views > 0 || post.reach > 0 ? 'synced' : 'partial',
        last_error_message: null,
        raw_payload: {},
        synced_at: syncedAt,
        deleted_at: null,
      });
    }
  }

  if (dailyRows.length > 0) {
    const { error } = await admin.from('profile_analytics_daily_metrics')
      .upsert(dailyRows, { onConflict: 'organization_id,profile_id,provider,metric_date' });
    if (error) throw error;
    summary.dailyRowsWritten += dailyRows.length;
  }
  if (followerRows.length > 0) {
    const { error } = await admin.from('profile_follower_daily_snapshots')
      .upsert(followerRows, { onConflict: 'organization_id,profile_id,provider,snapshot_date' });
    if (error) throw error;
    summary.followerRowsWritten += followerRows.length;
  }
  if (snapshotRows.length > 0) {
    const { error } = await admin.from('profile_analytics_snapshots')
      .upsert(snapshotRows, { onConflict: 'organization_id,profile_id,provider,period_start,period_end' });
    if (error) throw error;
  }
  // A ordem importa: números e situação primeiro (a linha passa a existir),
  // carimbos depois. Cada lista tem chaves uniformes — ver o comentário sobre a
  // normalização por união de chaves lá em cima.
  const timestampGroups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of currentRowsTimestamps) {
    const shape = Object.keys(row).sort().join(',');
    timestampGroups.set(shape, [...(timestampGroups.get(shape) ?? []), row]);
  }

  for (const rows of [currentRowsWithNumbers, currentRowsStatusOnly, ...timestampGroups.values()]) {
    if (rows.length === 0) continue;
    const { error } = await admin.from('profile_analytics_current')
      .upsert(rows, { onConflict: 'organization_id,profile_id' });
    if (error) throw error;
  }
  if (postRows.length > 0) {
    const { error } = await admin.from('profile_post_analytics_snapshots')
      .upsert(postRows, { onConflict: 'organization_id,zernio_post_id' });
    if (error) throw error;
    summary.postRowsWritten += postRows.length;
  }
}
