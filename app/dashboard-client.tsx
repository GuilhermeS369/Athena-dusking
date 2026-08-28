'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import type { DashboardData } from '@/lib/dashboard/server';
import { buildDailyMetricTimeSeries, dailyMetricRanking, dailyMetricValue, dashboardPeriodRange, filterDailyMetricsForPeriod, sumDailyMetrics, type DashboardMetric } from '@/lib/dashboard/analytics-period';
import type { DashboardV2Analytics, DashboardV2Section, DashboardV2TopPost } from '@/lib/dashboard/v2-types';
import twitterStyles from './x/twitter-dashboard.module.css';

type Organization = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  role: 'admin' | 'operator' | 'viewer';
};

type RefreshJobSummary = { job_id: string; status: string; total_count: number; reason: string };
type RefreshJobStatus = { status: string; total_count: number; processed_count: number; synced_count: number; partial_count: number; failed_count: number; last_error_message: string | null };
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
  const [selectedPlatform, setSelectedPlatform] = useState('instagram');
  const [selectedProfileId, setSelectedProfileId] = useState('all');
  const [selectedSource, setSelectedSource] = useState('all');
  const [selectedGroupId, setSelectedGroupId] = useState('all');
  const [selectedPeriod, setSelectedPeriod] = useState('30');
  const [selectedMetric, setSelectedMetric] = useState<DashboardMetric>('likes');
  const [activeRefreshJobId, setActiveRefreshJobId] = useState<string | null>(null);
  const [refreshMessage, setRefreshMessage] = useState('');
  const [v2Analytics, setV2Analytics] = useState<DashboardV2Analytics | null>(null);
  const [v2TopPosts, setV2TopPosts] = useState<DashboardV2TopPost[]>([]);
  const [v2Loading, setV2Loading] = useState(data.version === 'v2');
  const [v2Error, setV2Error] = useState('');
  const [analyticsRevision, setAnalyticsRevision] = useState(0);
  const pendingRefreshMessageRef = useRef<string | null>(null);
  const [twitterDashboard, setTwitterDashboard] = useState<TwitterDashboardData | null>(null);
  const [twitterLoading, setTwitterLoading] = useState(false);
  const [twitterLocalError, setTwitterLocalError] = useState('');
  const [twitterConnectionId, setTwitterConnectionId] = useState('all');
  const [twitterMetric, setTwitterMetric] = useState<TwitterMetric>('engagement');

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

  async function requestMetricsRefresh(trigger: 'page_view' | 'manual') {
    try {
      if (trigger === 'manual') setRefreshMessage('Agendando atualização das métricas…');
      const selectedGroupProfileIds = selectedGroupId !== 'all'
        ? (data.analytics.groups.find((group) => group.id === selectedGroupId)?.profile_ids ?? [])
        : null;
      const manualProfileIds = selectedProfileId !== 'all'
        ? [selectedProfileId]
        : selectedGroupProfileIds;

      if (trigger === 'manual' && manualProfileIds?.length === 0) {
        setRefreshMessage('O grupo selecionado não possui perfis para atualizar.');
        return;
      }

      const response = await fetch('/api/profile-analytics/refresh-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger,
          // No escopo global, atualiza somente perfis stale. Um perfil ou
          // grupo explicitamente selecionado pode ser forçado pelo usuário.
          force: trigger === 'manual' && Boolean(manualProfileIds),
          profileIds: trigger === 'manual' ? manualProfileIds : undefined,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { job?: RefreshJobSummary | null; error?: string };
      if (!response.ok) {
        if (trigger === 'manual') setRefreshMessage(payload.error ?? 'Não foi possível atualizar as métricas.');
        return;
      }
      if (payload.job?.job_id) {
        setActiveRefreshJobId(payload.job.job_id);
        setRefreshMessage(payload.job.reason === 'nothing_stale'
          ? 'As métricas já estão atualizadas.'
          : manualProfileIds
            ? `Atualizando ${payload.job.total_count} perfil(is) do escopo selecionado…`
            : `Atualizando ${payload.job.total_count} perfil(is) com dados desatualizados…`);
      } else if (trigger === 'manual') {
        setRefreshMessage('As métricas já estão atualizadas.');
      }
    } catch {
      if (trigger === 'manual') setRefreshMessage('Não foi possível conectar ao servidor.');
    }
  }

  useEffect(() => {
    if (!activeRefreshJobId) return;
    let cancelled = false;
    async function poll() {
      const response = await fetch(`/api/profile-analytics/refresh-jobs/${activeRefreshJobId}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({})) as { job?: RefreshJobStatus };
      if (cancelled || !response.ok || !payload.job) return;
      const job = payload.job;
      setRefreshMessage(`Atualizando métricas… ${job.processed_count}/${job.total_count}`);
      if (!['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(job.status)) return;
      setActiveRefreshJobId(null);
      if (job.status === 'completed' || job.status === 'completed_with_errors') {
        const completionMessage = job.failed_count > 0
          ? `Métricas atualizadas; ${job.failed_count} perfil(is) mantiveram o último dado válido.`
          : 'Métricas atualizadas agora.';
        if (data.version === 'v2') {
          pendingRefreshMessageRef.current = completionMessage;
          setRefreshMessage('Coleta concluída; carregando os novos indicadores…');
          setAnalyticsRevision((revision) => revision + 1);
        } else {
          setRefreshMessage(completionMessage);
        }
        router.refresh();
      } else {
        setRefreshMessage(job.last_error_message ?? 'A atualização falhou; exibindo o último dado válido.');
      }
    }
    void poll();
    const interval = window.setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeRefreshJobId, data.version, router]);

  useEffect(() => {
    if (data.version !== 'v2' || selectedPlatform !== 'instagram') { setV2Loading(false); return; }
    const controller = new AbortController();
    const params = new URLSearchParams({
      start: dashboardPeriodRange(selectedPeriod).startDate,
      end: dashboardPeriodRange(selectedPeriod).endDate,
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
        if (pendingRefreshMessageRef.current) {
          setRefreshMessage(pendingRefreshMessageRef.current);
          pendingRefreshMessageRef.current = null;
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setV2Error(error instanceof Error ? error.message : 'Analytics indisponível.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setV2Loading(false);
      });
    return () => controller.abort();
  }, [analyticsRevision, data.version, selectedGroupId, selectedMetric, selectedPeriod, selectedPlatform, selectedProfileId, selectedSource]);

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
  const topPost = useMemo(() => [...filteredPosts].sort((a, b) => (
    postMetricValue(b, selectedMetric) - postMetricValue(a, selectedMetric)
    || b.total_interactions - a.total_interactions
  ))[0], [filteredPosts, selectedMetric]);
  // Publicações são uma métrica operacional: contam itens efetivamente
  // publicados no Athena, e não o postCount parcial retornado pela analytics.
  const postsThisPeriod = publishedItemsThisPeriod.length;
  const postsPerPlatform = [{ label: 'Instagram', value: postsThisPeriod }];
  const postsOverTime = buildPublishedItemTimeSeries(publishedItemsThisPeriod);
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
  const metricOverTime = buildDailyMetricTimeSeries(filteredDailyMetrics, selectedMetric);
  const followerSeries = buildFollowerSeries(filteredFollowerHistory);
  const rankingValues = useMemo(() => dailyMetricRanking(filteredDailyMetrics, filteredProfiles.map((profile) => profile.id), selectedMetric), [filteredDailyMetrics, filteredProfiles, selectedMetric]);
  const profileRanking = useMemo(() => filteredProfiles.map((profile) => ({
    profile,
    value: rankingValues.get(profile.id) ?? 0,
  })).sort((a, b) => b.value - a.value || a.profile.username.localeCompare(b.profile.username)).slice(0, 10), [filteredProfiles, rankingValues]);
  const bestHours = buildBestHours(filteredPosts);
  const sourceHealth = filteredProfiles.map((profile) => {
    const snapshot = filteredSnapshots.find((item) => item.profile_id === profile.id);
    return { profile, status: snapshot?.sync_status ?? 'pending' };
  });
  const effectiveDailyTotals = v2Analytics?.kpis ?? dailyTotals;
  const effectiveFollowersTotal = v2Analytics?.kpis.followers_total ?? followersTotal;
  const effectiveFollowersDelta = v2Analytics?.kpis.followers_delta ?? followersDelta;
  const effectiveEngagementRate = v2Analytics?.kpis.engagement_rate ?? engagementRate;
  const effectivePostsThisPeriod = v2Analytics?.kpis.posts ?? postsThisPeriod;
  const effectiveMetricPerSource = v2Analytics
    ? v2Analytics.metric_per_source.map((item) => ({ label: item.label === 'meta_official' ? 'API oficial' : item.label === 'zernio' ? 'Integração externa' : item.label, value: item.value }))
    : metricPerSource;
  const effectiveMetricPerGroup = v2Analytics?.metric_per_group ?? metricPerGroup;
  const effectiveMetricOverTime = v2Analytics
    ? v2Analytics.metric_series.map((point) => ({ label: point.date.slice(5), value: point.value }))
    : metricOverTime;
  const effectivePostsOverTime = v2Analytics
    ? v2Analytics.post_series.map((point) => ({ label: point.date.slice(5), value: point.value }))
    : postsOverTime;
  const effectiveFollowerSeries = v2Analytics
    ? v2Analytics.follower_series.map((point) => ({ label: point.date.slice(5), value: point.value }))
    : followerSeries;
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
    }))
    : profileRanking;
  const effectiveTopPosts = data.version === 'v2' ? v2TopPosts : filteredPosts;
  const effectiveTopPost = effectiveTopPosts[0];
  const effectiveStatusRollups = v2Analytics?.publication_status;
  const effectiveFormatRollups = v2Analytics?.publication_format;
  const v2CoverageWarning = v2Analytics && (
    v2Analytics.coverage.profiles_with_metrics < v2Analytics.coverage.selected_profiles
    || v2Analytics.coverage.last_metric_date !== periodRange.endDate
  )
    ? `Cobertura parcial: ${v2Analytics.coverage.profiles_with_metrics}/${v2Analytics.coverage.selected_profiles} perfis com métricas; última data disponível ${v2Analytics.coverage.last_metric_date ?? 'indisponível'}.`
    : '';

  return (
    <section className="analytics-page">
      <header className="analytics-page-header">
        <div>
          <h1>Análises</h1>
          <p>{activeOrganization.name} · desempenho, conteúdo, caixa de entrada e saúde operacional.</p>
        </div>
        <div className="analytics-page-actions">
          {selectedPlatform === 'twitter' ? <button className="button button-ghost" type="button" onClick={() => window.location.assign('/x/analises')}>Abrir Análises X</button> : <button className="button button-ghost" type="button" onClick={() => void requestMetricsRefresh('manual')} disabled={Boolean(activeRefreshJobId)}>{activeRefreshJobId ? 'Atualizando dados recentes…' : selectedProfileId !== 'all' ? '↻ Atualizar perfil' : selectedGroupId !== 'all' ? '↻ Atualizar grupo' : '↻ Atualizar dados desatualizados'}</button>}
          <button className="button button-primary" type="button" onClick={() => window.location.assign(selectedPlatform === 'twitter' ? '/x/postagem' : '/postagem')}>＋ Nova postagem</button>
        </div>
      </header>

      {refreshMessage && <div className="analytics-refresh-status" role="status">{refreshMessage}</div>}
      {selectedPlatform === 'instagram' && data.version === 'v1' && <div className="analytics-refresh-status" role="alert">Analytics em modo de contingência. Os dias mais recentes permanecem visíveis, mas períodos extensos podem ter cobertura parcial.</div>}
      {selectedPlatform === 'instagram' && data.version === 'v2' && v2Loading && <div className="analytics-refresh-status" role="status">Carregando agregados do filtro…</div>}
      {selectedPlatform === 'instagram' && data.version === 'v2' && v2Error && <div className="analytics-refresh-status" role="alert">{v2Error} O resumo operacional continua disponível.</div>}
      {selectedPlatform === 'instagram' && data.version === 'v2' && v2CoverageWarning && <div className="analytics-refresh-status" role="status">{v2CoverageWarning}</div>}

      <section className="analytics-filter-panel analytics-filter-panel-compact panel" aria-label="Filtros de analytics">
        <label>Plataforma<select value={selectedPlatform} onChange={(event) => { setSelectedPlatform(event.target.value); setSelectedProfileId('all'); setSelectedGroupId('all'); setTwitterConnectionId('all'); }}><option value="instagram">Instagram</option>{twitterEnabled?<option value="twitter">X / Twitter</option>:null}</select></label>
        {selectedPlatform==='instagram'?<><label>Perfil<select value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}><option value="all">Todos os perfis</option>{data.analytics.profiles.map((profile) => <option key={profile.id} value={profile.id}>@{profile.username}</option>)}</select></label>
        <label>Fonte<select value={selectedSource} onChange={(event) => setSelectedSource(event.target.value)}><option value="all">Todas as fontes</option><option value="meta_official">API oficial</option><option value="zernio">Integração externa</option></select></label>
        <label>Grupo<select value={selectedGroupId} onChange={(event) => setSelectedGroupId(event.target.value)}><option value="all">Todos os grupos</option>{data.analytics.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
        <label>Período<select value={selectedPeriod} onChange={(event) => setSelectedPeriod(event.target.value)}><option value="1">Hoje</option><option value="2">Ontem</option><option value="3">Anteontem</option><option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option><option value="90">Últimos 90 dias</option><option value="180">Últimos 6 meses</option><option value="365">Último ano</option></select></label></>:<><label>Zernio<select value={twitterConnectionId} onChange={(event) => { setTwitterConnectionId(event.target.value); setSelectedProfileId('all'); }}><option value="all">Todas as Zernios</option>{twitterDashboard?.filters.connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.label}{connection.analytics_enabled ? '' : ' · desligada'}</option>)}</select></label><label>Perfil<select value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}><option value="all">Todos os perfis</option>{twitterDashboard?.filters.profiles.map((profile) => <option key={profile.id} value={profile.id}>@{profile.username}</option>)}</select></label><label>Grupo<select value={selectedGroupId} onChange={(event) => setSelectedGroupId(event.target.value)}><option value="all">Todos os grupos</option>{twitterDashboard?.filters.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label><label>Período<select value={selectedPeriod} onChange={(event) => setSelectedPeriod(event.target.value)}><option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option><option value="90">Últimos 90 dias</option><option value="180">Últimos 6 meses</option><option value="365">Último ano</option></select></label><label>Métrica<select value={twitterMetric} onChange={(event) => setTwitterMetric(event.target.value as TwitterMetric)}><option value="engagement">Engajamento</option><option value="impressions">Impressões</option><option value="views">Visualizações</option><option value="likes">Curtidas</option><option value="comments">Comentários</option><option value="shares">Compartilhamentos</option></select></label></>}
      </section>

      {selectedPlatform === 'twitter' ? <TwitterDashboard dashboard={twitterDashboard} loading={twitterLoading} error={twitterLocalError} metric={twitterMetric} period={periodLabel(periodDays)} /> : <><section className="analytics-kpi-strip" aria-label="Indicadores de análise de postagens">
        <KpiCard label="Taxa de engajamento" value={`${effectiveEngagementRate.toFixed(1)}%`} />
        <KpiCard label="Alcance total" value={formatCompact(effectiveDailyTotals.reach)} icon="◉" />
        <KpiCard label="Seguidores totais" value={formatCompact(effectiveFollowersTotal)} icon="♙" caption={`${effectiveFollowersDelta >= 0 ? '+' : ''}${formatCompact(effectiveFollowersDelta)} no período`} />
        <KpiCard label="Posts no período" value={String(effectivePostsThisPeriod)} icon="▤" />
        <KpiCard label={`Melhor post · ${metricLabel(selectedMetric)}`} value={effectiveTopPost ? formatCompact(postMetricValue(effectiveTopPost, selectedMetric)) : 'Sem dados'} caption={effectiveTopPost?.content?.slice(0, 34) ?? undefined} />
      </section>

      <section className="analytics-board" aria-label="Análise de postagens">
        <ProfileRankingCard items={effectiveProfileRanking} metric={selectedMetric} period={periodLabel(periodDays)} action={<MetricSelector value={selectedMetric} onChange={setSelectedMetric} />} />
        <ChartCard title="Posts por plataforma" subtitle="Posts nesta janela" items={[{ label: 'Instagram', value: effectivePostsThisPeriod }]} empty="Nenhum post ainda" />
        <TimeSeriesCard title="Posts ao longo do tempo" subtitle={`Posts por semana · ${periodLabel(periodDays).toLowerCase()}`} points={effectivePostsOverTime} empty="Nenhum post ainda" />
         <ChartCard title={`${metricLabel(selectedMetric)} por fonte`} subtitle={`${metricLabel(selectedMetric)} no período selecionado`} items={effectiveMetricPerSource} empty={`Sem dados de ${metricLabel(selectedMetric).toLowerCase()} ainda`} action={<MetricSelector value={selectedMetric} onChange={setSelectedMetric} />} />
         <ChartCard title={`${metricLabel(selectedMetric)} por grupo`} subtitle={`${metricLabel(selectedMetric)} no período selecionado`} items={effectiveMetricPerGroup} empty={`Sem dados de ${metricLabel(selectedMetric).toLowerCase()} por grupo ainda`} />
        <TimeSeriesCard title={`${metricLabel(selectedMetric)} ao longo do tempo`} subtitle={`${metricLabel(selectedMetric)} no período selecionado`} points={effectiveMetricOverTime} empty={`Sem dados de ${metricLabel(selectedMetric).toLowerCase()} ainda`} />
        <SkeletonInsightCard />
        <BestHourCard items={bestHours} />
        <FollowerHistoryCard points={effectiveFollowerSeries} />
        <TopPostsCard posts={effectiveTopPosts} />
      </section>

      <section className="analytics-section-title"><h2>Análise da caixa de entrada</h2><p>Mensagens, conversas, resposta e volume por horário quando uma fonte liberar dados de caixa de entrada.</p></section>
      <section className="analytics-kpi-strip analytics-kpi-strip-six" aria-label="Indicadores de inbox">
        <KpiCard label="Recebidas" value="0" icon="✉" />
        <KpiCard label="Enviadas" value="0" icon="↗" />
        <KpiCard label="Lidas" value="0" icon="◎" />
        <KpiCard label="Falhas" value="0" icon="△" />
        <KpiCard label="Conversas" value="0" icon="◌" />
        <KpiCard label="Resposta mediana" value="—" icon="◷" />
      </section>

      <section className="analytics-board" aria-label="Análise da caixa de entrada">
        <TimeSeriesCard title="Mensagens ao longo do tempo" subtitle="Recebidas vs enviadas vs lidas por dia" points={[]} empty="Sem dados de caixa de entrada nesta janela" />
        <ChartCard title="Mensagens por plataforma" subtitle="Sem dados nesta janela" items={[{ label: 'Instagram', value: 0 }]} empty="Sem mensagens por plataforma ainda" />
        <EmptyPanel title="Tempo de resposta" subtitle="Tempo até enviar a primeira resposta depois de uma mensagem recebida" empty="Nenhuma conversa pareada ainda" />
        <EmptyPanel title="Principais contas por volume" subtitle="Contas conectadas ordenadas pelo total de mensagens nesta janela" empty="Sem dados nesta janela" />
        <EmptyPanel title="Saídas por fonte" subtitle="Mensagens enviadas agrupadas por fonte" empty="Sem mensagens enviadas nesta janela" />
        <HeatmapPanel />
      </section>

      <section className="analytics-section-title"><h2>Operação e conteúdo</h2><p>Resumo operacional no fim da tela, sem travar ranking nem roubar espaço dos gráficos.</p></section>
      <section className="analytics-board analytics-board-compact" aria-label="Operação e conteúdo">
        <ChartCard title="Publicações por status" subtitle="Agenda interna" items={effectiveStatusRollups ? publicationStatusItemsV2(effectiveStatusRollups) : publicationStatusItems(filteredPublicationRollups)} empty="Nenhuma publicação no filtro" />
        <ChartCard title="Publicações por formato" subtitle="Imagem, reel, story e carrossel" items={effectiveFormatRollups ? publicationFormatItemsV2(effectiveFormatRollups) : publicationFormatItems(filteredPublicationRollups)} empty="Nenhum formato no filtro" />
        <SourceHealthCard items={sourceHealth} unavailable={data.summary.analyticsUnavailableProfiles} failedPublications={data.review.failedPublications} />
        <ScheduleCard data={data} />
      </section>
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

function KpiCard({ label, value, icon, caption }: { label: string; value: string; icon?: string; caption?: string }) {
  return <article className="analytics-kpi-card"><span>{label}</span><strong>{icon && <em>{icon}</em>}{value}</strong>{caption && <small>{caption}</small>}</article>;
}

function MetricSelector({ value, onChange }: { value: DashboardMetric; onChange: (value: DashboardMetric) => void }) {
  return <select className="analytics-card-select" value={value} onChange={(event) => onChange(event.target.value as DashboardMetric)}><option value="likes">Curtidas</option><option value="comments">Comentários</option><option value="views">Visualizações</option><option value="reach">Alcance</option><option value="shares">Compartilhamentos</option><option value="saves">Salvos</option><option value="interactions">Interações</option></select>;
}

function ProfileRankingCard({ items, metric, period, action }: { items: Array<{ profile: DashboardData['analytics']['profiles'][number]; value: number }>; metric: DashboardMetric; period: string; action: ReactNode }) {
  return <article className="analytics-card analytics-card-wide"><header><div><h3>Ranking de perfis por {metricLabel(metric).toLowerCase()}</h3><p>Top 10 · {period}</p></div>{action}</header>{items.length ? <div className="analytics-profile-ranking">{items.map((item, index) => <div key={item.profile.id}><strong>{index + 1}</strong><span><a href={instagramProfileUrl(item.profile.username)} target="_blank" rel="noreferrer">@{item.profile.username} <i aria-hidden="true">↗</i></a>{item.profile.display_name && <small>{item.profile.display_name}</small>}</span><em>{formatCompact(item.value)}</em></div>)}</div> : <div className="analytics-empty-center">Nenhum perfil no filtro selecionado</div>}</article>;
}

function ChartCard({ title, subtitle, items, empty, action }: { title: string; subtitle: string; items: Array<{ label: string; value: number }>; empty: string; action?: ReactNode }) {
  const max = Math.max(1, ...items.map((item) => item.value));
  const hasData = items.some((item) => item.value > 0);
  return <article className="analytics-card analytics-card-tall"><header><div><h3>{title}</h3><p>{subtitle}</p></div>{action}</header>{hasData ? <div className="analytics-bar-list analytics-bar-list-large">{items.map((item) => <div key={item.label}><span>{item.label}</span><strong>{formatCompact(item.value)}</strong><em style={{ width: `${Math.max(4, (item.value / max) * 100)}%` }} /></div>)}</div> : <div className="analytics-empty-center">{empty}</div>}</article>;
}

function TimeSeriesCard({ title, subtitle, points, empty }: { title: string; subtitle: string; points: Array<{ label: string; value: number }>; empty: string }) {
  const max = Math.max(1, ...points.map((point) => point.value));
  return <article className="analytics-card analytics-card-tall"><header><div><h3>{title}</h3><p>{subtitle}</p></div></header>{points.length ? <div className="analytics-line-area"><div className="analytics-line-grid" /><div className="analytics-spark-bars analytics-spark-bars-line">{points.map((point) => <div key={point.label} title={`${point.label}: ${point.value}`}><span style={{ height: `${Math.max(8, (point.value / max) * 100)}%` }} /><small>{point.label}</small></div>)}</div></div> : <div className="analytics-empty-center">{empty}</div>}</article>;
}

function SkeletonInsightCard() {
  return <article className="analytics-card analytics-skeleton-card"><div>{Array.from({ length: 4 }, (_, column) => <section key={column}>{Array.from({ length: 6 }, (_, row) => <span key={row} />)}</section>)}</div><strong>Dados incrementais preparados</strong></article>;
}

function BestHourCard({ items }: { items: Array<{ label: string; value: number }> }) {
  return <article className="analytics-card"><header><div><h3>Melhor horário para postar</h3><p>Janelas com maior amostra no filtro atual</p></div></header>{items.length ? <div className="best-hour-list">{items.map((item, index) => <div key={item.label}><strong>{index + 1}</strong><span>{item.label}</span><em>{item.value} posts</em></div>)}</div> : <div className="analytics-empty-center analytics-empty-left">Ainda não há dados suficientes. Publique mais para ver os melhores horários.</div>}</article>;
}

function FollowerHistoryCard({ points }: { points: Array<{ label: string; value: number }> }) {
  return <article className="analytics-card"><header><div><h3>Histórico de seguidores</h3><p>Seguidores coletados ao longo do tempo</p></div></header>{points.length ? <TimeBars points={points} /> : <div className="analytics-empty-icon"><span>♙</span><strong>Sem dados disponíveis</strong><p>O histórico de seguidores aparecerá aqui quando os dados forem coletados.</p></div>}</article>;
}

function TopPostsCard({ posts }: { posts: DashboardData['analytics']['posts'] | DashboardV2TopPost[] }) {
  return <article className="analytics-card analytics-card-wide"><header><div><h3>Posts com melhor performance</h3><p>Posts com engajamento nesta janela</p></div></header>{posts.length ? <div className="analytics-post-ranking">{posts.slice(0, 8).map((post, index) => <article key={post.id}><span>{index + 1}</span>{post.thumbnail_url ? <img src={post.thumbnail_url} alt="" /> : <em>◌</em>}<div><strong>{post.content?.slice(0, 100) || post.media_type || 'Post'}</strong><small>{post.published_at ? new Date(post.published_at).toLocaleString('pt-BR') : 'Sem data'} · {statusLabel(post.sync_status)}</small></div><dl><div><dt>Visualizações</dt><dd>{formatCompact(post.views)}</dd></div><div><dt>Alcance</dt><dd>{formatCompact(post.reach)}</dd></div><div><dt>Eng.</dt><dd>{formatCompact(post.total_interactions)}</dd></div></dl>{post.platform_post_url && <a href={post.platform_post_url} target="_blank" rel="noreferrer">Abrir</a>}</article>)}</div> : <div className="analytics-empty-center">Nenhum post com engajamento nesta janela</div>}</article>;
}

function EmptyPanel({ title, subtitle, empty }: { title: string; subtitle: string; empty: string }) {
  return <article className="analytics-card analytics-card-tall"><header><div><h3>{title}</h3><p>{subtitle}</p></div></header><div className="analytics-empty-center">{empty}</div></article>;
}

function HeatmapPanel() {
  return <article className="analytics-card analytics-card-tall"><header><div><h3>Quando as mensagens chegam</h3><p>Volume por dia da semana e hora</p></div></header><div className="analytics-heatmap analytics-heatmap-large">{Array.from({ length: 7 * 12 }, (_, index) => <span key={index} />)}</div><div className="analytics-empty-center analytics-empty-under">Ainda sem volume de mensagens</div></article>;
}

function SourceHealthCard({ items, unavailable, failedPublications }: { items: Array<{ profile: DashboardData['analytics']['profiles'][number]; status: string }>; unavailable: number; failedPublications: number }) {
  return <article className="analytics-card"><header><div><h3>Saúde das fontes</h3><p>Permissões, coleta e falhas</p></div></header><div className="source-health-list source-health-list-compact">{items.slice(0, 8).map((item) => <article key={item.profile.id} className="source-health-row"><div><strong>@{item.profile.username}</strong><small>{sourceLabel(item.profile.provider)} · {item.profile.status}</small></div><span>{statusLabel(item.status)}</span></article>)}</div><div className="analytics-mini-summary"><span>Sem analytics: <strong>{unavailable}</strong></span><span>Falhas: <strong>{failedPublications}</strong></span></div></article>;
}

function ScheduleCard({ data }: { data: DashboardData }) {
  return <article className="analytics-card"><header><div><h3>Agenda</h3><p>Fila e próximos posts</p></div></header><div className="summary-list"><div><span>Total de posts</span><strong>{data.summary.totalPosts}</strong></div><div><span>Publicados</span><strong>{data.summary.publishedPosts}</strong></div><div><span>Agendados</span><strong>{data.scheduled.total}</strong></div><div><span>Próximo horário</span><strong>{data.summary.nextScheduleAt ? new Date(data.summary.nextScheduleAt).toLocaleString('pt-BR') : '—'}</strong></div></div></article>;
}

function TimeBars({ points }: { points: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...points.map((point) => point.value));
  return <div className="analytics-spark-bars analytics-spark-bars-line">{points.map((point) => <div key={point.label} title={`${point.label}: ${point.value}`}><span style={{ height: `${Math.max(8, (point.value / max) * 100)}%` }} /><small>{point.label}</small></div>)}</div>;
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

function buildFollowerSeries(points: DashboardData['analytics']['followerHistory']) {
  const grouped = new Map<string, number>();
  points.forEach((point) => grouped.set(point.snapshot_date, (grouped.get(point.snapshot_date) ?? 0) + point.followers_count));
  return Array.from(grouped.entries()).slice(-30).map(([label, value]) => ({ label: label.slice(5), value }));
}

function buildPublishedItemTimeSeries(items: DashboardData['analytics']['publishedItems']) {
  const grouped = new Map<string, number>();
  items.forEach((item) => {
    const date = item.published_at.slice(0, 10);
    grouped.set(date, (grouped.get(date) ?? 0) + 1);
  });
  return Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b)).slice(-30).map(([label, value]) => ({ label: label.slice(5), value }));
}

function buildBestHours(posts: DashboardData['analytics']['posts']) {
  const grouped = new Map<string, number>();
  posts.forEach((post) => {
    if (!post.published_at) return;
    const date = new Date(post.published_at);
    const label = `${['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][date.getDay()]} ${String(date.getHours()).padStart(2, '0')}h`;
    grouped.set(label, (grouped.get(label) ?? 0) + 1);
  });
  return Array.from(grouped.entries()).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 6);
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
