'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import type { DashboardData } from '@/lib/dashboard/server';
import { dailyMetricRanking, dailyMetricValue, dashboardPeriodRange, filterDailyMetricsForPeriod, previousPeriodRange, saoPauloDateKey, sumDailyMetrics, type DashboardDailyMetric, type DashboardMetric } from '@/lib/dashboard/analytics-period';
import { DASHBOARD_TODAY_HINT, dashboardCoverageStatus, type DashboardCoverageNote } from '@/lib/dashboard/coverage-notes';
import type { DashboardV2Analytics, DashboardV2Operations, DashboardV2Section, DashboardV2TopPost } from '@/lib/dashboard/v2-types';
import { useLegacySchedulingEnabled } from './components/legacy-scheduling-context';
import { DashboardAccountFlowSection } from './dashboard-account-flow';
import { DashboardAreaChart, type ChartSeries } from './dashboard-chart';
import twitterStyles from './x/twitter-dashboard.module.css';

type Organization = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  role: 'admin' | 'operator' | 'viewer';
};

/**
 * Estado das três coletas do dia (migration 387). É o que o indicador do
 * cabeçalho mostra no lugar do antigo botão "atualizar".
 */
type CollectionStatus = {
  slots: string[];
  next_slot: string;
  run: {
    slot_label: string;
    slot_date: string;
    started_at: string;
    finished_at: string | null;
    total_profiles: number;
    processed_profiles: number;
    synced_profiles: number;
    failed_profiles: number;
    daily_rows: number;
    post_rows: number;
    percent: number;
  } | null;
};

type TwitterMetric = 'impressions' | 'views' | 'likes' | 'comments' | 'shares' | 'engagement';
type TwitterDashboardData = {
  summary: { followers: number; followerDelta: number; impressions: number; views: number; likes: number; comments: number; shares: number; engagement: number; engagementRate: number; posts: number; lastCapturedAt: string | null };
  coverage: { eligibleProfiles: number; disabledProfiles: number; profilesWithData: number; missingProfiles: number; pendingD1: number; pendingD7: number; pendingD30: number };
  followerSeries: Array<{ date: string; followers: number }>;
  ranking: Array<{ profileId: string; username: string; displayName: string | null; avatarUrl: string | null; value: number; followers: number }>;
  topPosts: Array<{ publicationItemId: string; profileId: string; username: string; publishedAt: string | null; content: string; url: string | null; impressions: number; views: number; likes: number; comments: number; shares: number; engagement: number; value: number }>;
  filters: {
    connections: Array<{ id: string; label: string; analytics_enabled: boolean; status: string }>;
    profiles: Array<{ id: string; username: string; display_name: string | null; current_connection_id: string | null }>;
    groups: Array<{ id: string; name: string }>;
  };
  pagination: { page: number; limit: number; totalTopPosts: number };
  source: 'typed_projections' | 'local_snapshots';
  metric: TwitterMetric;
};

/**
 * Períodos como pílulas, e "Hoje" primeiro.
 *
 * O padrão era 30 dias, o que respondia a pergunta errada: quem abre a tela de
 * manhã quer saber do dia, não da média do mês. Períodos longos continuam a um
 * clique — e agora dizem quanto tempo cobrem sem precisar abrir um select.
 */
const INSTAGRAM_PERIODS = [
  { value: '1', label: 'Hoje' },
  { value: 'ontem', label: 'Ontem' },
  { value: '3', label: '3 dias' },
  { value: '7', label: '7 dias' },
  { value: '15', label: '15 dias' },
  { value: '30', label: '30 dias' },
  { value: '90', label: '90 dias' },
];

/** O X só tem métrica consolidada por janelas maiores. */
const TWITTER_PERIODS = [
  { value: '7', label: '7 dias' },
  { value: '30', label: '30 dias' },
  { value: '90', label: '90 dias' },
];

type DashboardTabKey = 'reach' | 'likes' | 'comments' | 'interactions' | 'followers' | 'posts';

/**
 * As abas são os indicadores E o seletor do gráfico ao mesmo tempo.
 *
 * `metric` é a métrica que as abas de baixo (ranking, por fonte, por grupo)
 * passam a mostrar. Seguidores e Posts não são métricas de post, então elas
 * trocam só o gráfico e deixam os cartões de baixo como estavam — trocar para
 * "interações" sem pedir seria mexer no que o operador não pediu.
 */
const DASH_TABS: Array<{ key: DashboardTabKey; label: string; metric: DashboardMetric | null }> = [
  { key: 'reach', label: 'Alcance / views', metric: 'reach' },
  { key: 'likes', label: 'Curtidas', metric: 'likes' },
  { key: 'comments', label: 'Comentários', metric: 'comments' },
  { key: 'interactions', label: 'Interações', metric: 'interactions' },
  { key: 'followers', label: 'Seguidores', metric: null },
  { key: 'posts', label: 'Posts', metric: null },
];

/**
 * Duas cores, e só. Um gráfico de operação não precisa de paleta: precisa de
 * contraste contra o fundo escuro e de duas séries distinguíveis por quem não
 * enxerga bem vermelho e verde — daí violeta e turquesa, que diferem em
 * matiz E em luminosidade.
 */
const SERIES_COLORS = { primary: '#a78bfa', secondary: '#2dd4bf' };

export default function DashboardClient({
  activeOrganization,
  data,
  twitterEnabled,
}: {
  organizations: Organization[];
  activeOrganization: Organization;
  data: DashboardData;
  twitterEnabled: boolean;
}) {
  const router = useRouter();
  const legacySchedulingEnabled = useLegacySchedulingEnabled();
  const [selectedPlatform, setSelectedPlatform] = useState('instagram');
  const [selectedProfileId, setSelectedProfileId] = useState('all');
  const [selectedSource, setSelectedSource] = useState('all');
  const [selectedGroupId, setSelectedGroupId] = useState('all');
  const [selectedPeriod, setSelectedPeriod] = useState('1');
  const [selectedMetric, setSelectedMetric] = useState<DashboardMetric>('reach');
  const [selectedTab, setSelectedTab] = useState<DashboardTabKey>('reach');
  const [v2Analytics, setV2Analytics] = useState<DashboardV2Analytics | null>(null);
  const [v2TopPosts, setV2TopPosts] = useState<DashboardV2TopPost[]>([]);
  const [v2Loading, setV2Loading] = useState(true);
  const [v2Error, setV2Error] = useState('');
  const [v2Operations, setV2Operations] = useState<DashboardV2Operations | null>(null);
  const [v2Previous, setV2Previous] = useState<DashboardV2Analytics | null>(null);
  const [v2ChartWindow, setV2ChartWindow] = useState<DashboardV2Analytics | null>(null);
  const [collection, setCollection] = useState<CollectionStatus | null>(null);
  const [analyticsRevision, setAnalyticsRevision] = useState(0);
  const [twitterDashboard, setTwitterDashboard] = useState<TwitterDashboardData | null>(null);
  const [twitterLoading, setTwitterLoading] = useState(false);
  const [twitterLocalError, setTwitterLocalError] = useState('');
  const [twitterConnectionId, setTwitterConnectionId] = useState('all');
  const [twitterMetric, setTwitterMetric] = useState<TwitterMetric>('engagement');

  /**
   * Enquanto a rodada corre, pergunta de meio em meio minuto; parada, uma vez só.
   *
   * Meio minuto porque o indicador mostra porcentagem: mais lento que isso e o
   * número fica visivelmente travado; mais rápido é conversa à toa com o
   * servidor para uma informação que muda devagar.
   */
  useEffect(() => {
    let cancelado = false;
    async function ler() {
      try {
        const resposta = await fetch('/api/dashboard/collection-status', { cache: 'no-store' });
        const payload = await resposta.json().catch(() => ({})) as { status?: CollectionStatus | null };
        if (cancelado) return;
        setCollection((anterior) => {
          // A rodada acabou de terminar enquanto a tela estava aberta: busca os
          // agregados de novo. Sem isto o operador ficaria olhando o número
          // velho até trocar um filtro — e o indicador ao lado dele dizendo
          // "concluída", o que é pior do que não ter indicador nenhum.
          const estavaRodando = Boolean(anterior?.run && !anterior.run.finished_at);
          const terminouAgora = Boolean(payload.status?.run?.finished_at);
          if (estavaRodando && terminouAgora) setAnalyticsRevision((revision) => revision + 1);
          return payload.status ?? null;
        });
      } catch {
        if (!cancelado) setCollection(null);
      }
    }
    void ler();
    const emAndamento = collection?.run && !collection.run.finished_at;
    const intervalo = emAndamento ? window.setInterval(() => void ler(), 30_000) : null;
    return () => {
      cancelado = true;
      if (intervalo) window.clearInterval(intervalo);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection?.run?.finished_at, collection?.run?.slot_label]);


  useEffect(() => {
    if (selectedPlatform !== 'twitter' || !twitterEnabled) return;
    const controller = new AbortController();
    const range = dashboardPeriodRange(selectedPeriod);
    const params = new URLSearchParams({ start: range.startDate, end: range.endDate, metric: twitterMetric });
    if (twitterConnectionId !== 'all') params.set('connectionId', twitterConnectionId);
    if (selectedProfileId !== 'all') params.set('profileId', selectedProfileId);
    if (selectedGroupId !== 'all') params.set('groupId', selectedGroupId);
    setTwitterLoading(true);
    setTwitterLocalError('');
    void fetch(`/api/x/analytics/dashboard?${params}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => { const payload = await response.json().catch(() => ({})) as TwitterDashboardData & { error?: string }; if (!response.ok) throw new Error(payload.error ?? 'Dashboard X indisponível.'); return payload; })
      .then((payload) => setTwitterDashboard(payload))
      .catch((error: unknown) => { if (!controller.signal.aborted) setTwitterLocalError(error instanceof Error ? error.message : 'Dashboard X indisponível.'); })
      .finally(() => { if (!controller.signal.aborted) setTwitterLoading(false); });
    return () => controller.abort();
  }, [selectedGroupId, selectedPeriod, selectedPlatform, selectedProfileId, twitterConnectionId, twitterEnabled, twitterMetric]);


  useEffect(() => {
    if (selectedPlatform !== 'instagram') { setV2Loading(false); return; }
    const controller = new AbortController();
    const range = dashboardPeriodRange(selectedPeriod);
    const params = new URLSearchParams({
      start: range.startDate,
      end: range.endDate,
      metric: selectedMetric,
    });
    if (analyticsRevision > 0) params.set('_refresh', String(analyticsRevision));
    if (selectedProfileId !== 'all') params.set('profileId', selectedProfileId);
    if (selectedGroupId !== 'all') params.set('groupId', selectedGroupId);
    if (selectedSource !== 'all') params.set('provider', selectedSource);

    setV2Loading(true);
    setV2Error('');
    fetch(`/api/dashboard/analytics-v2?${params}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as {
          analytics?: DashboardV2Section<DashboardV2Analytics>;
          topPosts?: DashboardV2Section<DashboardV2TopPost[]>;
          error?: string;
        };
        if (!response.ok || !payload.analytics?.data) throw new Error(payload.error ?? 'Analytics indisponível.');
        setV2Analytics(payload.analytics.data);
        setV2TopPosts(payload.topPosts?.data ?? []);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setV2Error(error instanceof Error ? error.message : 'Analytics indisponível.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setV2Loading(false);
      });

    // A metade operacional vai em paralelo e tem vida própria: ela varre a fila
    // de publicação (226 mil linhas num período de 30 dias, medido em
    // 05/09/2026) enquanto a de cima agrega 12 mil de métrica. Esperar as duas
    // na mesma resposta era o que fazia o gráfico de curtidas demorar 5s para
    // aparecer. Se esta falhar, a tela continua: os cartões que dependem dela
    // mostram travessão, e nenhum aviso é aceso por isso.
    // A janela anterior, do mesmo tamanho: é ela que dá sentido à variação
    // percentual ao lado de cada número. Custa outra chamada à metade barata.
    const previous = previousPeriodRange(range);
    const previousParams = new URLSearchParams(params);
    previousParams.set('start', previous.startDate);
    previousParams.set('end', previous.endDate);
    fetch(`/api/dashboard/analytics-v2?${previousParams}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { analytics?: DashboardV2Section<DashboardV2Analytics> };
        if (!response.ok || !payload.analytics?.data) throw new Error('sem período anterior');
        setV2Previous(payload.analytics.data);
      })
      .catch(() => {
        if (!controller.signal.aborted) setV2Previous(null);
      });

    // Período de UM dia (Hoje, Ontem) renderiza um ponto só — o que é um
    // gráfico inútil. Os números continuam sendo os do dia escolhido; o desenho
    // passa a mostrar a semana que termina nele, para o ponto de hoje ter
    // contra o que ser lido. O rótulo do gráfico diz isso.
    const singleDay = range.startDate === range.endDate;
    if (singleDay) {
      const chartParams = new URLSearchParams(params);
      chartParams.set('start', shiftDay(range.endDate, -6));
      chartParams.set('end', range.endDate);
      fetch(`/api/dashboard/analytics-v2?${chartParams}`, { cache: 'no-store', signal: controller.signal })
        .then(async (response) => {
          const payload = await response.json().catch(() => ({})) as { analytics?: DashboardV2Section<DashboardV2Analytics> };
          if (!response.ok || !payload.analytics?.data) throw new Error('sem janela do gráfico');
          setV2ChartWindow(payload.analytics.data);
        })
        .catch(() => {
          if (!controller.signal.aborted) setV2ChartWindow(null);
        });
    } else {
      setV2ChartWindow(null);
    }

    const operationParams = new URLSearchParams(params);
    operationParams.delete('metric');
    fetch(`/api/dashboard/operations-v2?${operationParams}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { operations?: DashboardV2Operations };
        if (!response.ok || !payload.operations) throw new Error('Operações indisponíveis.');
        setV2Operations(payload.operations);
      })
      .catch(() => {
        if (!controller.signal.aborted) setV2Operations(null);
      });

    return () => controller.abort();
  }, [analyticsRevision, selectedGroupId, selectedMetric, selectedPeriod, selectedPlatform, selectedProfileId, selectedSource]);

  const filteredProfiles = useMemo(() => data.analytics.profiles.filter((profile) => {
    if (selectedProfileId !== 'all' && profile.id !== selectedProfileId) return false;
    if (selectedSource !== 'all' && profile.provider !== selectedSource) return false;
    if (selectedGroupId !== 'all' && !data.analytics.groups.find((group) => group.id === selectedGroupId)?.profile_ids.includes(profile.id)) return false;
    return selectedPlatform === 'instagram';
  }), [data.analytics.groups, data.analytics.profiles, selectedGroupId, selectedPlatform, selectedProfileId, selectedSource]);

  const filteredProfileIds = useMemo(() => new Set(filteredProfiles.map((profile) => profile.id)), [filteredProfiles]);
  const periodDays = Number(selectedPeriod);
  const periodRange = useMemo(() => dashboardPeriodRange(selectedPeriod), [selectedPeriod]);
  const profileSnapshotsUntilEnd = useMemo(() => data.analytics.snapshots.filter((snapshot) => (
    filteredProfileIds.has(snapshot.profile_id)
    && snapshot.period_end <= periodRange.endDate
  )), [data.analytics.snapshots, filteredProfileIds, periodRange.endDate]);
  const filteredSnapshots = useMemo(() => latestSnapshotsByProfile(profileSnapshotsUntilEnd), [profileSnapshotsUntilEnd]);
  const filteredDailyMetrics = useMemo(
    () => filterDailyMetricsForPeriod(data.analytics.dailyMetrics, filteredProfileIds, periodRange),
    [data.analytics.dailyMetrics, filteredProfileIds, periodRange],
  );
  const filteredPosts = useMemo(() => data.analytics.posts.filter((post) => (
    filteredProfileIds.has(post.profile_id)
    && Boolean(post.published_at)
    && post.published_at! >= periodRange.startIso
    && post.published_at! <= periodRange.endIso
  )), [data.analytics.posts, filteredProfileIds, periodRange]);
  const publishedItemsThisPeriod = useMemo(() => data.analytics.publishedItems.filter((item) => (
    filteredProfileIds.has(item.profile_id)
    && item.published_at >= periodRange.startIso
    && item.published_at <= periodRange.endIso
  )), [data.analytics.publishedItems, filteredProfileIds, periodRange]);
  const followerHistoryUntilEnd = useMemo(() => data.analytics.followerHistory.filter((point) => (
    filteredProfileIds.has(point.profile_id)
    && point.snapshot_date <= periodRange.endDate
  )), [data.analytics.followerHistory, filteredProfileIds, periodRange]);
  const filteredFollowerHistory = useMemo(() => followerHistoryUntilEnd.filter((point) => (
    filteredProfileIds.has(point.profile_id)
    && point.snapshot_date >= periodRange.startDate
  )), [followerHistoryUntilEnd, filteredProfileIds, periodRange]);
  const filteredPublicationRollups = useMemo(() => data.analytics.publicationRollups.filter((item) => filteredProfileIds.has(item.profile_id)), [data.analytics.publicationRollups, filteredProfileIds]);

  const dailyTotals = useMemo(() => sumDailyMetrics(filteredDailyMetrics), [filteredDailyMetrics]);
  const followersTotal = useMemo(() => filteredProfiles.reduce((sum, profile) => {
    const latestFollower = followerHistoryUntilEnd
      .filter((point) => point.profile_id === profile.id)
      .sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date))[0];
    const snapshot = filteredSnapshots.find((item) => item.profile_id === profile.id);
    return sum + (latestFollower?.followers_count ?? snapshot?.followers_count ?? 0);
  }, 0), [filteredProfiles, filteredSnapshots, followerHistoryUntilEnd]);
  const followersDelta = useMemo(() => filteredFollowerHistory.reduce((sum, point) => sum + point.followers_gained - point.followers_lost, 0), [filteredFollowerHistory]);

  const engagementRate = dailyTotals.reach > 0 ? (dailyTotals.interactions / dailyTotals.reach) * 100 : 0;
  // Publicações são uma métrica operacional: contam itens efetivamente
  // publicados no Athena, e não o postCount parcial retornado pela analytics.
  const postsThisPeriod = publishedItemsThisPeriod.length;
  const metricPerSource = [
    { label: 'API oficial', value: filteredDailyMetrics.filter((item) => profileProvider(data, item.profile_id) === 'meta_official').reduce((sum, item) => sum + dailyMetricValue(item, selectedMetric), 0) },
    { label: 'Integração externa', value: filteredDailyMetrics.filter((item) => profileProvider(data, item.profile_id) === 'zernio').reduce((sum, item) => sum + dailyMetricValue(item, selectedMetric), 0) },
  ];
  const metricPerGroup = useMemo(() => data.analytics.groups.map((group) => ({
    label: group.name,
    value: filteredDailyMetrics
      .filter((item) => group.profile_ids.includes(item.profile_id))
      .reduce((sum, item) => sum + dailyMetricValue(item, selectedMetric), 0),
  })), [data.analytics.groups, filteredDailyMetrics, selectedMetric]);
  const rankingValues = useMemo(() => dailyMetricRanking(filteredDailyMetrics, filteredProfiles.map((profile) => profile.id), selectedMetric), [filteredDailyMetrics, filteredProfiles, selectedMetric]);
  const profileRanking = useMemo(() => filteredProfiles.map((profile) => ({
    profile,
    value: rankingValues.get(profile.id) ?? 0,
  })).sort((a, b) => b.value - a.value || a.profile.username.localeCompare(b.profile.username)).slice(0, 10), [filteredProfiles, rankingValues]);
  // O cartão de saúde mostra QUEM está com problema, não os oito primeiros em
  // ordem alfabética. Desde a migration 383 o bootstrap manda só a lista de
  // atenção (no máximo 60) e a contagem por situação — perfil ausente daqui
  // está sincronizado, e presumir "pendente" pela ausência seria acender alarme
  // falso em toda a frota.
  const sourceHealth = useMemo(() => {
    const statusByProfile = new Map(filteredSnapshots.map((snapshot) => [snapshot.profile_id, snapshot.sync_status]));
    return filteredProfiles
      .filter((profile) => {
        const status = statusByProfile.get(profile.id);
        return status !== undefined && status !== 'synced';
      })
      .map((profile) => ({ profile, status: statusByProfile.get(profile.id)! }));
  }, [filteredProfiles, filteredSnapshots]);
  const effectiveDailyTotals = v2Analytics?.kpis ?? dailyTotals;
  const effectiveFollowersTotal = v2Analytics?.kpis.followers_total ?? followersTotal;
  const effectiveFollowersDelta = v2Analytics?.kpis.followers_delta ?? followersDelta;
  const effectiveEngagementRate = v2Analytics?.kpis.engagement_rate ?? engagementRate;
  const effectivePostsThisPeriod = v2Operations?.posts ?? v2Analytics?.kpis.posts ?? postsThisPeriod;
  // "Ainda não sei" só vale enquanto NENHUMA das duas metades trouxe o número.
  // Antes da migration 382 ele vem junto com os agregados, e nesse caso mostrar
  // travessão seria esconder um dado que já está na mão.
  const postsUnknown = !v2Operations && v2Analytics?.kpis.posts === undefined;
  const effectiveMetricPerSource = v2Analytics
    ? v2Analytics.metric_per_source.map((item) => ({ label: item.label === 'meta_official' ? 'API oficial' : item.label === 'zernio' ? 'Integração externa' : item.label, value: item.value }))
    : metricPerSource;
  const effectiveMetricPerGroup = v2Analytics?.metric_per_group ?? metricPerGroup;
  const effectiveProfileRanking = v2Analytics
    ? v2Analytics.ranking.map((item) => ({
      profile: data.analytics.profiles.find((profile) => profile.id === item.profile_id) ?? {
        id: item.profile_id,
        username: item.username,
        display_name: item.display_name,
        provider: 'zernio' as const,
        status: 'no_data',
      },
      value: item.value,
      removed: item.removed === true,
    }))
    : profileRanking;
  const effectiveTopPosts = v2TopPosts;
  const effectiveStatusRollups = v2Operations?.publication_status ?? v2Analytics?.publication_status;
  const effectiveFormatRollups = v2Operations?.publication_format ?? v2Analytics?.publication_format;
  const previousRange = useMemo(() => previousPeriodRange(periodRange), [periodRange]);
  const previousPeriodLabel = previousRange.startDate === previousRange.endDate
    ? formatShortDate(previousRange.startDate)
    : `${formatShortDate(previousRange.startDate)}–${formatShortDate(previousRange.endDate)}`;

  /**
   * A série de cada métrica.
   *
   * Desde a migration 382 a resposta traz TODAS as métricas de uma vez
   * (`series_by_metric`), então trocar de aba redesenha o gráfico na hora, sem
   * ir ao servidor. Os `??` cobrem o intervalo entre o deploy do app e o da
   * migração, e o modo de contingência (v1), que agrega no próprio navegador.
   */
  const chartSource = v2ChartWindow ?? v2Analytics;
  const seriesFor = (metric: DashboardMetric) => chartSource?.series_by_metric?.[metric]
    ?? (metric === selectedMetric ? chartSource?.metric_series : undefined)
    ?? dailyDateSeries(filteredDailyMetrics, metric);

  const chartSeries: ChartSeries[] = useMemo(() => {
    if (selectedTab === 'followers') {
      return [{ key: 'followers', label: 'Seguidores', color: SERIES_COLORS.primary, points: chartSource?.follower_series ?? [] }];
    }
    if (selectedTab === 'posts') {
      return [{ key: 'posts', label: 'Publicações', color: SERIES_COLORS.primary, points: v2Operations?.post_series ?? [] }];
    }
    if (selectedTab === 'reach') {
      return [
        { key: 'reach', label: 'Alcance', color: SERIES_COLORS.primary, points: seriesFor('reach') },
        { key: 'views', label: 'Visualizações', color: SERIES_COLORS.secondary, points: seriesFor('views') },
      ];
    }
    return [{ key: selectedTab, label: metricLabel(selectedTab), color: SERIES_COLORS.primary, points: seriesFor(selectedTab) }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTab, chartSource, v2Operations, filteredDailyMetrics, selectedMetric]);

  const tabValue = (key: DashboardTabKey, totals = effectiveDailyTotals, followers = effectiveFollowersTotal) => {
    if (key === 'reach') return totals.reach;
    if (key === 'followers') return followers;
    if (key === 'posts') return effectivePostsThisPeriod;
    return totals[key];
  };

  /**
   * Sem NENHUMA linha de métrica no período, o número é desconhecido — não é
   * zero. Mostrar "0" ali afirma que os posts do dia não tiveram visualização,
   * que é uma conclusão que a tela não tem como sustentar.
   */
  const metricsUnknown = Boolean(v2Analytics)
    && v2Analytics!.coverage.profiles_with_metrics === 0;

  const tabHeadline = (key: DashboardTabKey) => {
    if (key === 'posts') return postsUnknown ? '—' : formatCompact(effectivePostsThisPeriod);
    // Seguidores vêm da foto diária, não da métrica de post: eles continuam
    // válidos mesmo quando a janela não tem insight nenhum.
    if (key === 'followers') return formatCompact(tabValue(key));
    if (metricsUnknown) return '—';
    if (key === 'reach') return `${formatCompact(effectiveDailyTotals.reach)} · ${formatCompact(effectiveDailyTotals.views)}`;
    return formatCompact(tabValue(key));
  };

  // Sem número anterior não há variação — e inventar "+100%" contra zero seria
  // pior do que não mostrar nada. Posts ficam de fora porque a contagem vem da
  // metade cara, e buscá-la duas vezes pagaria caro por um enfeite.
  const tabDelta = useMemo(() => {
    if (selectedTab === 'posts' || !v2Previous) return null;
    if (metricsUnknown && selectedTab !== 'followers') return null;
    const previous = tabValue(selectedTab, v2Previous.kpis, v2Previous.kpis.followers_total);
    if (!previous) return null;
    return ((tabValue(selectedTab) - previous) / previous) * 100;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTab, v2Previous, metricsUnknown, effectiveDailyTotals, effectiveFollowersTotal, effectivePostsThisPeriod]);

  const coverageStatus = useMemo(() => dashboardCoverageStatus({
    // A cobertura tem uma perna em cada metade: quantos perfis têm métrica vem
    // dos agregados, e quantos publicaram sem receber métrica vem da fila.
    coverage: v2Analytics?.coverage && {
      ...v2Analytics.coverage,
      profiles_with_publications: v2Operations?.profiles_with_publications ?? v2Analytics.coverage.profiles_with_publications,
      profiles_pending_collection: v2Operations?.profiles_pending_collection ?? v2Analytics.coverage.profiles_pending_collection,
    },
    periodEndDate: periodRange.endDate,
    todayDate: saoPauloDateKey(),
    // Os perfis já filtrados pela seleção da tela: a capacidade fala do escopo
    // que o operador está olhando, não da organização inteira.
    profiles: filteredProfiles,
  }), [filteredProfiles, periodRange.endDate, v2Analytics, v2Operations]);

  /**
   * A tela mostra UMA linha de estado, nunca uma pilha.
   *
   * A ordem é a da urgência: erro de carregamento antes de tudo, porque nada
   * abaixo dele é confiável; depois a cobertura. "Carregando" virou barra fina
   * no cabeçalho, e o estado da coleta virou o indicador ao lado dos botões —
   * cada coisa no peso que merece.
   */
  const statusLine: DashboardCoverageNote | null = selectedPlatform !== 'instagram'
    ? null
    : v2Error
      ? { tone: 'alert', message: `${v2Error} Os cartões operacionais continuam válidos.` }
      : coverageStatus.note;

  return (
    <section className="analytics-page dash-page">
      <header className="analytics-page-header">
        <div>
          <h1>Dashboard {v2Loading && <span className="analytics-header-spinner" role="status" aria-label="Carregando indicadores" />}</h1>
          <p>
            {activeOrganization.name}
            {coverageStatus.capacity && (
              <>
                {' · '}
                <span
                  className="analytics-capacity-chip"
                  title={`${coverageStatus.capacity.offline} perfis aguardam reconexão pela API da Meta. O histórico deles continua somando nos números desta tela — o que muda é a capacidade de publicar agora.`}
                >
                  <strong>{formatCompact(coverageStatus.capacity.online)}</strong> de {formatCompact(coverageStatus.capacity.total)} publicando
                </span>
              </>
            )}
          </p>
        </div>
        {/* Ícone e nada mais. Os dois botões viviam no canto superior direito com
            texto de até 22 caracteres cada — "↻ Atualizar dados desatualizados"
            e "＋ Nova postagem" —, ocupando um quinto da largura do cabeçalho
            para duas ações que qualquer um reconhece pelo símbolo. O nome
            continua acessível: `title` para quem passa o mouse e `aria-label`
            para leitor de tela. */}
        <div className="analytics-page-actions">
          {statusLine && <StatusChip note={statusLine} />}
          {selectedPlatform === 'twitter'
            ? <IconButton label="Abrir Análises X" icon="activity" onClick={() => window.location.assign('/x/analises')} />
            : <CollectionIndicator status={collection} />}
          {(selectedPlatform === 'twitter' || legacySchedulingEnabled) && <IconButton label="Nova postagem" icon="plus" primary onClick={() => window.location.assign(selectedPlatform === 'twitter' ? '/x/postagem' : '/postagem')} />}
        </div>
      </header>


      <section className="dash-toolbar" aria-label="Filtros da dashboard">
        <div className="dash-pills" role="group" aria-label="Período">
          {(selectedPlatform === 'instagram' ? INSTAGRAM_PERIODS : TWITTER_PERIODS).map((period) => (
            <button
              key={period.value}
              type="button"
              className={period.value === selectedPeriod ? 'dash-pill dash-pill-active' : 'dash-pill'}
              aria-pressed={period.value === selectedPeriod}
              title={period.value === '1' ? DASHBOARD_TODAY_HINT : undefined}
              onClick={() => setSelectedPeriod(period.value)}
            >{period.label}</button>
          ))}
        </div>

        <div className="dash-selects">
          {twitterEnabled && (
            <select aria-label="Plataforma" value={selectedPlatform} onChange={(event) => { const platform = event.target.value; setSelectedPlatform(platform); setSelectedProfileId('all'); setSelectedGroupId('all'); setTwitterConnectionId('all'); if (platform === 'twitter' && Number(selectedPeriod) < 7) setSelectedPeriod('7'); }}>
              <option value="instagram">Instagram</option>
              <option value="twitter">X / Twitter</option>
            </select>
          )}
          {selectedPlatform === 'instagram' ? <>
            <select aria-label="Perfil" value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}><option value="all">Todos os perfis</option>{data.analytics.profiles.map((profile) => <option key={profile.id} value={profile.id}>@{profile.username}</option>)}</select>
            <select aria-label="Grupo" value={selectedGroupId} onChange={(event) => setSelectedGroupId(event.target.value)}><option value="all">Todos os grupos</option>{data.analytics.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
            <select aria-label="Fonte" value={selectedSource} onChange={(event) => setSelectedSource(event.target.value)}><option value="all">Todas as fontes</option><option value="meta_official">API da Meta</option><option value="zernio">Integração externa</option></select>
          </> : <>
            <select aria-label="Zernio" value={twitterConnectionId} onChange={(event) => { setTwitterConnectionId(event.target.value); setSelectedProfileId('all'); }}><option value="all">Todas as Zernios</option>{twitterDashboard?.filters.connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.label}{connection.analytics_enabled ? '' : ' · desligada'}</option>)}</select>
            <select aria-label="Perfil" value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}><option value="all">Todos os perfis</option>{twitterDashboard?.filters.profiles.map((profile) => <option key={profile.id} value={profile.id}>@{profile.username}</option>)}</select>
            <select aria-label="Grupo" value={selectedGroupId} onChange={(event) => setSelectedGroupId(event.target.value)}><option value="all">Todos os grupos</option>{twitterDashboard?.filters.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
            <select aria-label="Métrica" value={twitterMetric} onChange={(event) => setTwitterMetric(event.target.value as TwitterMetric)}><option value="engagement">Engajamento</option><option value="impressions">Impressões</option><option value="views">Visualizações</option><option value="likes">Curtidas</option><option value="comments">Comentários</option><option value="shares">Compartilhamentos</option></select>
          </>}
        </div>
      </section>

      {selectedPlatform === 'twitter' ? <TwitterDashboard dashboard={twitterDashboard} loading={twitterLoading} error={twitterLocalError} metric={twitterMetric} period={periodLabel(periodDays)} /> : <>
      {/* O bloco principal: as abas SÃO os indicadores, e clicar numa delas
          troca o gráfico inteiro. A tela antiga tinha um seletor de métrica
          dentro de cada cartão, então trocar de métrica exigia repetir a
          escolha em cada um — e os cartões discordavam entre si. */}
      <section className="dash-metrics" aria-label="Indicadores">
        <div className="dash-tabs" role="tablist" aria-label="Métrica exibida no gráfico">
          {DASH_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={tab.key === selectedTab}
              className={tab.key === selectedTab ? 'dash-tab dash-tab-active' : 'dash-tab'}
              onClick={() => { setSelectedTab(tab.key); if (tab.metric) setSelectedMetric(tab.metric); }}
            >
              <span>{tab.label}</span>
              <strong>{tabHeadline(tab.key)}</strong>
            </button>
          ))}
        </div>

        <div className="dash-chart-panel">
          <div className="dash-chart-head">
            <div className="dash-chart-headline">
              <strong>{tabHeadline(selectedTab)}</strong>
              {tabDelta !== null && (
                <em className={tabDelta >= 0 ? 'dash-delta dash-delta-up' : 'dash-delta dash-delta-down'}>
                  {tabDelta >= 0 ? '▲' : '▼'} {Math.abs(tabDelta).toFixed(1)}%
                </em>
              )}
              <small>{tabDelta === null ? 'sem período anterior para comparar' : `vs. ${previousPeriodLabel}`}</small>
            </div>
            <div className="dash-legend">
              {v2ChartWindow && <span className="dash-legend-note">gráfico: últimos 7 dias</span>}
              {chartSeries.map((serie) => <span key={serie.key}><i style={{ background: serie.color }} />{serie.label}</span>)}
            </div>
          </div>
          <DashboardAreaChart
            series={chartSeries}
            baseline={selectedTab === 'followers' ? 'auto' : 'zero'}
            empty={selectedTab === 'posts' && postsUnknown ? 'Carregando publicações…' : 'Sem dados coletados neste período'}
          />
        </div>
      </section>

      <section className="dash-grid" aria-label="Detalhamento">
        <RankingCard items={effectiveProfileRanking} metric={selectedMetric} />
        <BreakdownCard title={`${metricLabel(selectedMetric)} por fonte`} items={effectiveMetricPerSource} empty="Sem dados no período" />
        <BreakdownCard title={`${metricLabel(selectedMetric)} por grupo`} items={effectiveMetricPerGroup} empty="Nenhum grupo com dados no período" />
        <TopPostsCard posts={effectiveTopPosts} />
      </section>

      <section className="dash-grid dash-grid-ops" aria-label="Operação">
        <BreakdownCard title="Publicações por situação" items={effectiveStatusRollups ? publicationStatusItemsV2(effectiveStatusRollups) : publicationStatusItems(filteredPublicationRollups)} empty="Nenhuma publicação no filtro" />
        <BreakdownCard title="Publicações por formato" items={effectiveFormatRollups ? publicationFormatItemsV2(effectiveFormatRollups) : publicationFormatItems(filteredPublicationRollups)} empty="Nenhum formato no filtro" />
        <SourceHealthCard items={sourceHealth} counts={data.analytics.stateCounts} unavailable={data.summary.analyticsUnavailableProfiles} failedPublications={data.review.failedPublications} />
        <ScheduleCard data={data} />
      </section>

      <DashboardAccountFlowSection organizationId={activeOrganization.id} />
      </>}
    </section>
  );
}

function TwitterDashboard({ dashboard, loading, error, metric, period }: { dashboard: TwitterDashboardData | null; loading: boolean; error: string; metric: TwitterMetric; period: string }) {
  if (loading && !dashboard) return <section className={twitterStyles.loading} role="status"><span /><strong>Carregando analytics locais do X…</strong><p>Consolidando projeções, cobertura e rankings.</p></section>;
  if (error) return <section className={twitterStyles.error} role="alert"><strong>Não foi possível carregar a dashboard X</strong><p>{error}</p><button className="button button-ghost" type="button" onClick={() => window.location.reload()}>Tentar novamente</button></section>;
  if (!dashboard) return null;
  const { summary, coverage } = dashboard;
  const coverageTotal = coverage.eligibleProfiles + coverage.disabledProfiles;
  const coveragePercent = coverage.eligibleProfiles ? Math.round((coverage.profilesWithData / coverage.eligibleProfiles) * 100) : 0;
  return <div className={twitterStyles.dashboard} aria-busy={loading}>
    {loading && <div className={twitterStyles.refreshing} role="status">Atualizando o filtro…</div>}
    <section className={twitterStyles.notice}><div><span>Dados exclusivamente locais</span><p>Filtros e gráficos usam somente métricas já armazenadas. Nenhuma consulta paga é feita nesta tela.</p></div><small>{summary.lastCapturedAt ? `Última coleta: ${new Date(summary.lastCapturedAt).toLocaleString('pt-BR')}` : 'Nenhuma coleta local'}</small></section>
    <section className={twitterStyles.kpis} aria-label="Indicadores do X">
      <TwitterKpi label="Seguidores" value={formatCompact(summary.followers)} detail={`${summary.followerDelta >= 0 ? '+' : ''}${formatCompact(summary.followerDelta)} no período`} />
      <TwitterKpi label="Impressões" value={formatCompact(summary.impressions)} detail={`${summary.posts} posts com snapshot`} />
      <TwitterKpi label="Visualizações" value={formatCompact(summary.views)} />
      <TwitterKpi label="Curtidas" value={formatCompact(summary.likes)} />
      <TwitterKpi label="Comentários" value={formatCompact(summary.comments)} />
      <TwitterKpi label="Compartilhamentos" value={formatCompact(summary.shares)} />
      <TwitterKpi label="Engajamento" value={formatCompact(summary.engagement)} detail={`${summary.engagementRate.toFixed(2)}% por impressão`} accent />
    </section>
    <section className={twitterStyles.grid}>
      <article className={`${twitterStyles.card} ${twitterStyles.wide}`}><header><div><h2>Evolução de seguidores</h2><p>Total dos perfis no filtro · {period.toLowerCase()}</p></div></header><TwitterSeries points={dashboard.followerSeries} /></article>
      <article className={twitterStyles.card}><header><div><h2>Cobertura dos dados</h2><p>{coveragePercent}% dos perfis elegíveis com dados</p></div></header><div className={twitterStyles.coverage}><div className={twitterStyles.ring} style={{ '--coverage': `${coveragePercent * 3.6}deg` } as React.CSSProperties}><strong>{coveragePercent}%</strong></div><dl><div><dt>Elegíveis</dt><dd>{coverage.eligibleProfiles}</dd></div><div><dt>Com dados</dt><dd>{coverage.profilesWithData}</dd></div><div><dt>Sem dados</dt><dd>{coverage.missingProfiles}</dd></div><div><dt>Desabilitados</dt><dd>{coverage.disabledProfiles}</dd></div></dl></div><small>{coverageTotal} perfis no escopo selecionado</small></article>
      <article className={twitterStyles.card}><header><div><h2>Pendências de coleta</h2><p>Marcos de posts detectados localmente</p></div></header><div className={twitterStyles.milestones}><div><span>D+1</span><strong>{coverage.pendingD1}</strong></div><div><span>D+7</span><strong>{coverage.pendingD7}</strong></div><div><span>D+30</span><strong>{coverage.pendingD30}</strong></div></div><button className="button button-ghost" type="button" onClick={() => window.location.assign('/x/analises')}>Revisar coletas e custos</button></article>
      <article className={`${twitterStyles.card} ${twitterStyles.wide}`}><header><div><h2>Ranking de perfis</h2><p>{twitterMetricLabel(metric)} · {period.toLowerCase()}</p></div></header>{dashboard.ranking.some((item) => item.value > 0) ? <div className={twitterStyles.ranking}>{dashboard.ranking.slice(0, 10).map((item, index) => <div key={item.profileId}><span>{index + 1}</span>{item.avatarUrl ? <img src={item.avatarUrl} alt="" /> : <i>@</i>}<div><strong>@{item.username}</strong><small>{item.displayName || `${formatCompact(item.followers)} seguidores`}</small></div><em>{formatCompact(item.value)}</em></div>)}</div> : <TwitterEmpty text={`Nenhum dado de ${twitterMetricLabel(metric).toLowerCase()} neste filtro.`} />}</article>
      <article className={`${twitterStyles.card} ${twitterStyles.full}`}><header><div><h2>Posts com melhor desempenho</h2><p>Ordenados por {twitterMetricLabel(metric).toLowerCase()}</p></div></header>{dashboard.topPosts.length ? <div className={twitterStyles.tableWrap}><table><thead><tr><th>Post</th><th>Perfil</th><th>{twitterMetricLabel(metric)}</th><th>Impressões</th><th>Interações</th><th>Publicado</th><th /></tr></thead><tbody>{dashboard.topPosts.slice(0, 12).map((post) => <tr key={post.publicationItemId}><td><strong>{post.content.slice(0, 90) || 'Post no X'}</strong></td><td>@{post.username}</td><td><b>{formatCompact(post.value)}</b></td><td>{formatCompact(post.impressions)}</td><td>{formatCompact(post.engagement)}</td><td>{post.publishedAt ? new Date(post.publishedAt).toLocaleDateString('pt-BR') : '—'}</td><td>{post.url ? <a href={post.url} target="_blank" rel="noreferrer">Abrir ↗</a> : '—'}</td></tr>)}</tbody></table></div> : <TwitterEmpty text="Nenhum post com analytics local neste período." />}</article>
    </section>
  </div>;
}

function TwitterKpi({ label, value, detail, accent }: { label: string; value: string; detail?: string; accent?: boolean }) {
  return <article className={accent ? twitterStyles.kpiAccent : undefined}><span>{label}</span><strong>{value}</strong><small>{detail ?? 'No período selecionado'}</small></article>;
}

function TwitterSeries({ points }: { points: TwitterDashboardData['followerSeries'] }) {
  if (!points.length) return <TwitterEmpty text="O histórico aparecerá após uma coleta local de seguidores." />;
  const values = points.map((point) => point.followers);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.max(1, max - min);
  return <div className={twitterStyles.series}><div className={twitterStyles.seriesScale}><span>{formatCompact(max)}</span><span>{formatCompact(min)}</span></div><div className={twitterStyles.seriesBars}>{points.slice(-45).map((point) => <div key={point.date} title={`${new Date(`${point.date}T12:00:00`).toLocaleDateString('pt-BR')}: ${point.followers.toLocaleString('pt-BR')}`}><span style={{ height: `${12 + ((point.followers - min) / spread) * 88}%` }} /><small>{point.date.slice(5).replace('-', '/')}</small></div>)}</div></div>;
}

function TwitterEmpty({ text }: { text: string }) {
  return <div className={twitterStyles.empty}><span>◎</span><p>{text}</p></div>;
}

function twitterMetricLabel(metric: TwitterMetric) {
  return ({ impressions: 'Impressões', views: 'Visualizações', likes: 'Curtidas', comments: 'Comentários', shares: 'Compartilhamentos', engagement: 'Engajamento' })[metric];
}



function RankingCard({ items, metric }: { items: Array<{ profile: DashboardData['analytics']['profiles'][number]; value: number; removed?: boolean }>; metric: DashboardMetric }) {
  const top = items.filter((item) => item.value > 0).slice(0, 8);
  const max = Math.max(1, ...top.map((item) => item.value));
  return <article className="dash-card"><h3>Perfis com mais {metricLabel(metric).toLowerCase()}</h3>{top.length
    ? <div className="dash-rank">{top.map((item, index) => {
      // Perfil removido continua no ranking porque o que ele entregou aconteceu
      // (migration 386) — mas sem link: o @ não abre mais, e um link morto faz
      // o operador concluir que a tela está quebrada.
      const conteudo = <>
        <b>{index + 1}</b>
        <span>@{item.profile.username}{item.removed && <i className="dash-rank-gone">removido</i>}</span>
        <em><i style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }} /></em>
        <strong>{formatCompact(item.value)}</strong>
      </>;
      return item.removed
        ? <div key={item.profile.id} className="dash-rank-inactive" title="Perfil removido — o histórico dele continua contando nos números acima">{conteudo}</div>
        : <a key={item.profile.id} href={instagramProfileUrl(item.profile.username)} target="_blank" rel="noreferrer">{conteudo}</a>;
    })}</div>
    : <p className="dash-card-empty">Nenhum perfil com {metricLabel(metric).toLowerCase()} neste período</p>}</article>;
}

/**
 * Barra horizontal com rótulo, valor e participação.
 *
 * O cartão antigo desenhava a barra e escondia o quanto ela representava, então
 * "Instagram 1,2 mil" não dizia se era tudo ou um terço. A porcentagem à
 * direita responde isso sem ocupar mais uma linha.
 */
// Acima disto a lista rola dentro do cartão em vez de esticá-lo. Antes ela era
// cortada em seis e os demais grupos simplesmente não apareciam.
const BREAKDOWN_VISIBLE_ROWS = 6;

function BreakdownCard({ title, items, empty }: { title: string; items: Array<{ label: string; value: number }>; empty: string }) {
  const ordered = [...items].sort((left, right) => right.value - left.value);
  const max = Math.max(1, ...ordered.map((item) => item.value));
  // Sobre TODOS os itens: com a lista cortada, a porcentagem dividia pelo
  // total dos seis primeiros e somava 100% mesmo havendo mais grupos.
  const total = ordered.reduce((sum, item) => sum + item.value, 0);
  const scrolls = ordered.length > BREAKDOWN_VISIBLE_ROWS;
  return <article className="dash-card"><h3>{title}</h3>{ordered.some((item) => item.value > 0)
    ? <div className={scrolls ? 'dash-bars dash-bars-scroll' : 'dash-bars'}>{ordered.map((item, index) => <div key={`${item.label}-${index}`} title={`${item.label}: ${item.value.toLocaleString('pt-BR')}`}>
      <span>{item.label}</span>
      <em><i style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }} /></em>
      <strong>{formatCompact(item.value)}</strong>
      <small>{total > 0 ? `${Math.round((item.value / total) * 100)}%` : '—'}</small>
    </div>)}</div>
    : <p className="dash-card-empty">{empty}</p>}</article>;
}





/**
 * O número mostrado é o MESMO que ordenou a lista.
 *
 * Antes o cartão ordenava por curtidas (a métrica escolhida) e exibia
 * visualizações, então a coluna aparecia fora de ordem — 1,1 mil, 813, 65,2
 * mil — e a lista parecia quebrada quando estava certa.
 */
function topPostValue(post: DashboardData['analytics']['posts'][number] | DashboardV2TopPost) {
  return 'metric_value' in post ? post.metric_value : post.views || post.total_interactions;
}

function TopPostsCard({ posts }: { posts: DashboardData['analytics']['posts'] | DashboardV2TopPost[] }) {
  return <article className="dash-card"><h3>Posts com melhor desempenho</h3>{posts.length
    ? <div className="dash-posts">{posts.slice(0, 5).map((post) => <a key={post.id} href={post.platform_post_url ?? '#'} target="_blank" rel="noreferrer" className={post.platform_post_url ? undefined : 'dash-posts-nolink'}>
      {post.thumbnail_url ? <img src={post.thumbnail_url} alt="" loading="lazy" /> : <i aria-hidden="true">▤</i>}
      <span>
        <strong>{post.content?.slice(0, 60) || post.media_type || 'Publicação'}</strong>
        <small>{post.published_at ? new Date(post.published_at).toLocaleDateString('pt-BR') : 'sem data'}</small>
      </span>
      <b>{formatCompact(topPostValue(post))}</b>
    </a>)}</div>
    : <p className="dash-card-empty">Nenhum post com métrica coletada nesta janela</p>}</article>;
}



/**
 * Saúde das fontes sem barra de rolagem.
 *
 * A versão anterior listava perfil por perfil dentro de uma caixa rolável — a
 * lista nunca cabia, e rolar dentro de um cartão para ver o oitavo de mil e
 * quatrocentos não ajuda ninguém. Aqui o cartão resume por SITUAÇÃO (que é a
 * pergunta real: tem algo quebrado?) e nomeia no máximo três exemplos.
 */
function SourceHealthCard({ items, counts, unavailable, failedPublications }: { items: Array<{ profile: DashboardData['analytics']['profiles'][number]; status: string }>; counts: Record<string, number>; unavailable: number; failedPublications: number }) {
  const attention = Object.entries(counts)
    .filter(([status]) => status !== 'synced')
    .sort((left, right) => right[1] - left[1]);
  return <article className="dash-card"><h3>Saúde das fontes</h3>
    <div className="dash-health">
      <div className="dash-health-top"><strong>{formatCompact(counts.synced ?? 0)}</strong><span>coletando normalmente</span></div>
      {attention.length === 0
        ? <p className="dash-card-empty">Nenhuma fonte pedindo atenção.</p>
        : <ul>{attention.slice(0, 4).map(([status, value]) => <li key={status}><span>{statusLabel(status)}</span><b>{value}</b></li>)}</ul>}
      {items.length > 0 && <small>{items.slice(0, 3).map((item) => `@${item.profile.username}`).join(', ')}{items.length > 3 ? ` +${items.length - 3}` : ''}</small>}
    </div>
    <div className="dash-card-foot"><span>Sem analytics <b>{unavailable}</b></span><span>Falhas <b>{failedPublications}</b></span></div>
  </article>;
}

function ScheduleCard({ data }: { data: DashboardData }) {
  return <article className="dash-card"><h3>Fila</h3><dl className="dash-facts">
    <div><dt>Agendados</dt><dd>{formatCompact(data.scheduled.total)}</dd></div>
    <div><dt>Publicados</dt><dd>{formatCompact(data.summary.publishedPosts)}</dd></div>
    <div><dt>Total na agenda</dt><dd>{formatCompact(data.summary.totalPosts)}</dd></div>
    <div><dt>Próximo horário</dt><dd>{data.summary.nextScheduleAt ? new Date(data.summary.nextScheduleAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</dd></div>
  </dl></article>;
}


/**
 * O estado da tela em um ícone.
 *
 * Era uma faixa amarela ocupando a largura inteira, acesa a maior parte do
 * tempo — e um aviso permanente é indistinguível de decoração: some da vista em
 * dois dias e continua roubando espaço. Aqui ele é um botão do tamanho dos
 * outros, ao lado deles, com a cor dizendo o tom; o texto aparece ao passar o
 * mouse ou ao focar pelo teclado.
 *
 * É `<button>` e não um `<span title="…">` de propósito: o `title` do navegador
 * demora ~1s, não aceita quebra de linha e não abre no toque. Como botão, ele
 * recebe foco (teclado) e clique (celular), e o balão é nosso.
 */
function StatusChip({ note }: { note: DashboardCoverageNote }) {
  return <span className={`dash-status-chip dash-status-chip-${note.tone}`}>
    <button type="button" aria-label={note.message}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#icon-alert" /></svg>
    </button>
    <span role={note.tone === 'alert' ? 'alert' : 'status'} className="dash-status-pop">{note.message}</span>
  </span>;
}

/**
 * O estado da coleta, sem botão.
 *
 * O "atualizar" saiu porque ele custava caro e não resolvia nada: cada clique
 * varria a frota, e a pergunta real do operador é "esse número está fresco?".
 * Aqui a resposta está sempre visível — girando durante a rodada, apagado fora
 * dela — e o detalhe (progresso, horário da última, horário da próxima) fica no
 * balão, onde não ocupa espaço de quem não perguntou.
 */
function CollectionIndicator({ status }: { status: CollectionStatus | null }) {
  if (!status) return null;

  const run = status.run;
  // Data de Brasília, como `slot_date`. Em UTC, das 21:00 à meia-noite já é
  // amanhã e a rodada das 21:00 sumia do indicador.
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const rodadaDeHoje = run && run.slot_date === hoje ? run : null;
  const emAndamento = Boolean(rodadaDeHoje && !rodadaDeHoje.finished_at);

  const hora = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const detalhe = emAndamento && rodadaDeHoje
    ? `Coleta das ${rodadaDeHoje.slot_label} em andamento — ${rodadaDeHoje.processed_profiles.toLocaleString('pt-BR')} de ${rodadaDeHoje.total_profiles.toLocaleString('pt-BR')} perfis (${rodadaDeHoje.percent}%)`
    : rodadaDeHoje?.finished_at
      ? `Coleta das ${rodadaDeHoje.slot_label} concluída às ${hora(rodadaDeHoje.finished_at)} · próxima às ${status.next_slot}`
      : `Próxima coleta às ${status.next_slot}`;

  return <span className={`dash-collection${emAndamento ? ' dash-collection-running' : ''}`}>
    <span aria-hidden="true" />
    <span className="dash-collection-pop" role="status">
      {detalhe}
      <small>As métricas são atualizadas em {status.slots.join(', ')}.</small>
    </span>
  </span>;
}

function IconButton({ label, icon, onClick, primary, disabled, spinning }: { label: string; icon: string; onClick: () => void; primary?: boolean; disabled?: boolean; spinning?: boolean }) {
  return <button
    className={`dash-icon-button${primary ? ' dash-icon-button-primary' : ''}${spinning ? ' dash-icon-button-spinning' : ''}`}
    type="button"
    title={label}
    aria-label={label}
    disabled={disabled}
    onClick={onClick}
  ><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href={`#icon-${icon}`} /></svg></button>;
}

function shiftDay(date: string, days: number) {
  const moment = new Date(`${date}T12:00:00Z`);
  moment.setUTCDate(moment.getUTCDate() + days);
  return moment.toISOString().slice(0, 10);
}

function formatShortDate(date: string) {
  const [, month, day] = date.split('-');
  return month && day ? `${day}/${month}` : date;
}

/**
 * Série por data a partir das linhas diárias — só o caminho de contingência
 * (v1), em que o navegador agrega o que o servidor não agregou.
 */
function dailyDateSeries(rows: DashboardDailyMetric[], metric: DashboardMetric) {
  const grouped = new Map<string, number>();
  for (const row of rows) grouped.set(row.date, (grouped.get(row.date) ?? 0) + dailyMetricValue(row, metric));
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, value]) => ({ date, value }));
}

function formatCompact(value: number) {
  return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function sourceLabel(provider: string) {
  if (provider === 'meta_official') return 'API oficial';
  if (provider === 'zernio') return 'Integração externa';
  return 'Fonte conectada';
}

function statusLabel(status: string | undefined) {
  if (status === 'synced') return 'Ativo';
  if (status === 'unavailable_plan') return 'Aguardando métricas';
  if (status === 'no_data') return 'Sem dados no período';
  if (status === 'permission_missing') return 'Sem permissão';
  if (status === 'not_configured') return 'Não configurado';
  if (status === 'rate_limited') return 'Limite da fonte';
  if (status === 'failed') return 'Falha';
  return 'Pendente';
}

function profileProvider(data: DashboardData, profileId: string) {
  return data.analytics.profiles.find((profile) => profile.id === profileId)?.provider;
}

function instagramProfileUrl(username: string) {
  return `https://www.instagram.com/${encodeURIComponent(username.replace(/^@+/, ''))}/`;
}

function postMetricValue(item: DashboardData['analytics']['posts'][number] | DashboardV2TopPost, metric: DashboardMetric) {
  if (metric === 'likes') return item.likes;
  if (metric === 'comments') return item.comments;
  if (metric === 'views') return item.views;
  if (metric === 'reach') return item.reach;
  if (metric === 'shares') return item.shares;
  if (metric === 'saves') return item.saves;
  return item.total_interactions;
}

function metricLabel(metric: DashboardMetric) {
  const labels: Record<DashboardMetric, string> = { likes: 'Curtidas', comments: 'Comentários', views: 'Visualizações', reach: 'Alcance', shares: 'Compartilhamentos', saves: 'Salvos', interactions: 'Interações' };
  return labels[metric];
}

function periodLabel(days: number) {
  if (days === 1) return 'Hoje';
  if (days === 2) return 'Ontem';
  if (days === 3) return 'Anteontem';
  if (days === 7) return 'Últimos 7 dias';
  if (days === 30) return 'Últimos 30 dias';
  if (days === 90) return 'Últimos 90 dias';
  if (days === 180) return 'Últimos 6 meses';
  if (days === 365) return 'Último ano';
  return `${days} dias`;
}

function latestSnapshotsByProfile(snapshots: DashboardData['analytics']['snapshots']) {
  const latest = new Map<string, DashboardData['analytics']['snapshots'][number]>();
  snapshots.forEach((snapshot) => {
    const current = latest.get(snapshot.profile_id);
    if (!current || snapshot.period_end > current.period_end || (snapshot.period_end === current.period_end && (snapshot.synced_at ?? '') > (current.synced_at ?? ''))) latest.set(snapshot.profile_id, snapshot);
  });
  return Array.from(latest.values());
}




function rollupItems(rollups: DashboardData['analytics']['publicationRollups'], kind: string) {
  const grouped = new Map<string, number>();
  rollups.filter((item) => item.kind === kind).forEach((item) => grouped.set(item.label, (grouped.get(item.label) ?? 0) + item.total));
  return Array.from(grouped.entries()).map(([label, value]) => ({ label, value }));
}

function rollupValue(rollups: DashboardData['analytics']['publicationRollups'], kind: string, label: string) {
  return rollups.filter((item) => item.kind === kind && item.label === label).reduce((sum, item) => sum + item.total, 0);
}

function publicationStatusItems(rollups: DashboardData['analytics']['publicationRollups']) {
  const labels: Record<string, string> = { waiting: 'Aguardando', ready: 'Prontas', publishing: 'Publicando', published: 'Publicadas', failed: 'Falhas' };
  return ['waiting', 'ready', 'publishing', 'published', 'failed'].map((status) => ({ label: labels[status], value: rollupValue(rollups, 'status', status) }));
}

function publicationFormatItems(rollups: DashboardData['analytics']['publicationRollups']) {
  const labels: Record<string, string> = { image: 'Imagem', reel: 'Reel', story: 'Story', carousel: 'Carrossel' };
  return ['image', 'reel', 'story', 'carousel'].map((format) => ({ label: labels[format], value: rollupValue(rollups, 'format', format) }));
}

function publicationStatusItemsV2(items: Array<{ label: string; value: number }>) {
  const labels: Record<string, string> = { waiting: 'Aguardando', ready: 'Prontas', publishing: 'Publicando', published: 'Publicadas', failed: 'Falhas' };
  const values = new Map(items.map((item) => [item.label, item.value]));
  return ['waiting', 'ready', 'publishing', 'published', 'failed'].map((status) => ({ label: labels[status], value: values.get(status) ?? 0 }));
}

function publicationFormatItemsV2(items: Array<{ label: string; value: number }>) {
  const labels: Record<string, string> = { image: 'Imagem', reel: 'Reel', story: 'Story', carousel: 'Carrossel' };
  const values = new Map(items.map((item) => [item.label, item.value]));
  return ['image', 'reel', 'story', 'carousel'].map((format) => ({ label: labels[format], value: values.get(format) ?? 0 }));
}
