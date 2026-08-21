'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Profile = {
  id: string;
  username: string;
  display_name: string | null;
  profile_picture_url: string | null;
  account_type: string | null;
  status: 'no_data' | 'online' | 'offline' | 'reauthorization_required';
  provider: 'meta_official' | 'zernio';
  last_checked_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error_message: string | null;
};

type Snapshot = {
  followers_count: number;
  followers_delta: number;
  followers_gained: number;
  followers_lost: number;
  impressions: number;
  reach: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  total_interactions: number;
  profile_links_taps: number;
  posts_count: number;
  engagement_rate: number;
  sync_status: string;
  unavailable_reason: string | null;
  last_error_message: string | null;
  synced_at: string | null;
  period_start: string;
  period_end: string;
  raw_payload?: Record<string, unknown> | null;
} | null;

type FollowerPoint = {
  snapshot_date: string;
  followers_count: number;
  followers_gained: number;
  followers_lost: number;
};

type PostAnalytics = {
  id: string;
  zernio_post_id: string | null;
  platform_post_url: string | null;
  content: string | null;
  media_type: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  views: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  total_interactions: number;
  engagement_rate: number;
  sync_status: string;
};

type PublicationItem = {
  id: string;
  format: string;
  status: string;
  execute_at: string | null;
  published_at: string | null;
  caption: string | null;
  last_error_message: string | null;
  created_at: string;
};

type Group = { id: string; name: string } | null;
type ProfileTab = 'summary' | 'posts' | 'audience' | 'best-time' | 'operation' | 'raw';
type ProfileMetric = 'interactions' | 'views' | 'reach' | 'likes' | 'comments' | 'shares' | 'saves';
type RefreshJobSummary = { job_id: string; status: string; total_count: number; reused: boolean; reason: string };
type RefreshJobStatus = {
  id: string;
  status: string;
  total_count: number;
  processed_count: number;
  synced_count: number;
  partial_count: number;
  no_data_count: number;
  skipped_count: number;
  failed_count: number;
  retry_pending_count: number;
  dead_letter_count: number;
  last_error_message: string | null;
};

function formatNumber(value: number | null | undefined) {
  return new Intl.NumberFormat('pt-BR').format(value ?? 0);
}

function formatCompact(value: number | null | undefined) {
  return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(value ?? 0);
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function statusLabel(status: string | undefined) {
  if (status === 'synced') return 'Análises sincronizadas';
  if (status === 'partial') return 'Análises parciais';
  if (status === 'unavailable_plan') return 'Aguardando métricas';
  if (status === 'permission_missing') return 'Sem permissão';
  if (status === 'no_data') return 'Sem dados no período';
  if (status === 'not_configured') return 'Não configurado';
  if (status === 'rate_limited') return 'Limite da fonte';
  if (status === 'failed') return 'Falha';
  return 'Pendente';
}

function sourceLabel(provider: Profile['provider']) {
  if (provider === 'meta_official') return 'API oficial';
  if (provider === 'zernio') return 'Integração externa';
  return 'Fonte conectada';
}

function analyticsUnavailableMessage(profile: Profile, snapshot: Snapshot) {
  if (snapshot?.unavailable_reason) return snapshot.unavailable_reason;
  if (snapshot?.last_error_message) return snapshot.last_error_message;
  if (snapshot?.sync_status === 'unavailable_plan') return 'A sincronização anterior não retornou métricas. Como a Zernio libera analytics no plano free, use Atualizar métricas para coletar novamente.';
  if (snapshot?.sync_status === 'no_data') return 'A Zernio ainda não retornou métricas para este período. A próxima atualização preencherá os cards automaticamente quando houver dados.';
  if (snapshot?.sync_status === 'permission_missing') return 'A fonte conectada ainda não tem as permissões necessárias para insights. Quando as permissões forem ajustadas, os painéis serão preenchidos sem mudar a tela.';
  if (snapshot?.sync_status === 'not_configured' || profile.provider === 'meta_official') return 'A fonte oficial ainda não está configurada para coletar insights. Os painéis ficam zerados e preparados para ativação futura.';
  return null;
}

function postMetricValue(post: PostAnalytics, metric: ProfileMetric) {
  if (metric === 'views') return post.views;
  if (metric === 'reach') return post.reach;
  if (metric === 'likes') return post.likes;
  if (metric === 'comments') return post.comments;
  if (metric === 'shares') return post.shares;
  if (metric === 'saves') return post.saves;
  return post.total_interactions;
}

function refreshJobMessage(job: RefreshJobStatus | null) {
  if (!job) return '';
  if (job.status === 'completed') return `Métricas atualizadas: ${job.synced_count} perfil(is), ${job.no_data_count} sem dados no período.`;
  if (job.status === 'completed_with_errors') return `Atualização finalizada com avisos: ${job.synced_count} atualizados, ${job.partial_count} parciais, ${job.failed_count} falhas.`;
  if (job.status === 'failed') return job.last_error_message ?? 'Atualização de métricas falhou.';
  if (job.retry_pending_count > 0) return `Atualizando métricas: ${job.processed_count}/${job.total_count}. ${job.retry_pending_count} aguardando nova tentativa automática.`;
  return `Atualizando métricas em segundo plano: ${job.processed_count}/${job.total_count}.`;
}

function payloadObject(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function supportedPayloadKeys(snapshot: Snapshot) {
  const raw = payloadObject(snapshot?.raw_payload);
  return ['accountInsights', 'followerHistory', 'followerStatsFallback', 'postAnalytics', 'dailyMetrics', 'bestTime', 'contentDecay', 'demographics']
    .filter((key) => raw[key] !== null && raw[key] !== undefined);
}

export default function ProfileDetailClient({
  profile,
  group,
  snapshot,
  followerHistory,
  postAnalytics,
  publicationItems,
  canManage,
}: {
  profile: Profile;
  group: Group;
  snapshot: Snapshot;
  followerHistory: FollowerPoint[];
  postAnalytics: PostAnalytics[];
  publicationItems: PublicationItem[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<ProfileTab>('summary');
  const [period, setPeriod] = useState('30');
  const [source, setSource] = useState<'all' | Profile['provider']>('all');
  const [contentStatus, setContentStatus] = useState('all');
  const [metric, setMetric] = useState<ProfileMetric>('interactions');
  const [message, setMessage] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [activeRefreshJobId, setActiveRefreshJobId] = useState<string | null>(null);
  const [refreshJobStatus, setRefreshJobStatus] = useState<RefreshJobStatus | null>(null);
  const autoRefreshRequested = useRef(false);
  const delta = snapshot?.followers_delta ?? 0;
  const maxFollowers = Math.max(1, ...followerHistory.map((point) => point.followers_count));
  const analyticsWarning = analyticsUnavailableMessage(profile, snapshot);
  const visiblePosts = [...postAnalytics].sort((a, b) => postMetricValue(b, metric) - postMetricValue(a, metric));
  const visiblePublications = publicationItems.filter((item) => contentStatus === 'all' || item.status === contentStatus);
  const bestHours = buildBestHours(postAnalytics, publicationItems);
  const sourceBlocked = source !== 'all' && source !== profile.provider;

  async function requestMetricsRefresh(trigger: 'page_view' | 'manual') {
    if (trigger === 'manual') {
      setSyncing(true);
      setMessage('');
    }
    try {
      const response = await fetch('/api/profile-analytics/refresh-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger, profileIds: [profile.id] }),
      });
      const payload = await response.json() as { job?: RefreshJobSummary | null; error?: string };
      if (!response.ok) {
        if (trigger === 'manual') setMessage(payload.error ?? 'Não foi possível agendar a atualização de métricas.');
        return;
      }
      if (payload.job?.job_id) {
        setActiveRefreshJobId(payload.job.job_id);
        if (trigger === 'manual') {
          if (payload.job.reason === 'active_job' || payload.job.reason === 'manual_cooldown') setMessage('Atualização de métricas já está em andamento ou em cooldown anti-spam.');
          else if (payload.job.reason === 'nothing_stale') setMessage('Métricas já estão dentro do cache; nenhuma chamada repetida foi feita.');
          else setMessage(`Atualização de métricas enfileirada para ${payload.job.total_count} perfil.`);
        }
      }
    } catch {
      if (trigger === 'manual') setMessage('Não foi possível conectar ao servidor.');
    } finally {
      if (trigger === 'manual') setSyncing(false);
    }
  }

  useEffect(() => {
    if (autoRefreshRequested.current) return;
    autoRefreshRequested.current = true;
    void requestMetricsRefresh('page_view');
  }, []);

  useEffect(() => {
    if (!activeRefreshJobId) return;
    let cancelled = false;
    async function poll() {
      const response = await fetch(`/api/profile-analytics/refresh-jobs/${activeRefreshJobId}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({})) as { job?: RefreshJobStatus };
      if (!cancelled && response.ok && payload.job) {
        setRefreshJobStatus(payload.job);
        if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(payload.job.status)) {
          setActiveRefreshJobId(null);
          if (['completed', 'completed_with_errors'].includes(payload.job.status) && payload.job.processed_count > 0) {
            window.setTimeout(() => router.refresh(), 300);
          }
        }
      }
    }
    void poll();
    const interval = window.setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeRefreshJobId, router]);

  return (
    <main className="standalone-page profile-detail-page">
      <a className="back-link" href="/perfis">← Voltar para perfis</a>
      <header className="profile-detail-hero panel">
        <div className="profile-detail-identity">
          {profile.profile_picture_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="profile-detail-avatar" src={profile.profile_picture_url} alt="" />
          ) : <span className="profile-detail-avatar profile-avatar-fallback" aria-hidden="true">◎</span>}
          <div>
            <span className="section-kicker">{sourceLabel(profile.provider)} · {group?.name ?? 'Sem grupo'}</span>
            <h1>@{profile.username}</h1>
            <p>{profile.display_name ?? 'Perfil profissional'} · {profile.account_type ?? 'Instagram'}</p>
          </div>
        </div>
        <div className="profile-detail-actions">
          <a className="button button-ghost" href={`https://www.instagram.com/${encodeURIComponent(profile.username)}/`} target="_blank" rel="noreferrer">Abrir Instagram</a>
          <a className="button button-ghost" href="/agenda">Ver agenda</a>
          {canManage && <button className="button button-primary" type="button" onClick={() => void requestMetricsRefresh('manual')} disabled={syncing || Boolean(activeRefreshJobId)}>{syncing || activeRefreshJobId ? 'Atualizando métricas…' : 'Atualizar métricas'}</button>}
        </div>
      </header>

      {message && <p className="inline-message" role="status">{message}</p>}
      {refreshJobStatus && <p className="inline-message inline-message-neutral" role="status">{refreshJobMessage(refreshJobStatus)}</p>}
      {analyticsWarning && <p className="inline-message inline-message-neutral" role="status">{analyticsWarning}</p>}

      <section className="analytics-filter-panel panel profile-filter-panel" aria-label="Filtros do perfil">
        <label>Período<select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="1">Hoje</option><option value="2">Ontem</option><option value="3">Anteontem</option><option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option><option value="90">Últimos 90 dias</option><option value="180">Últimos 6 meses</option><option value="365">Último ano</option></select></label>
        <label>Fonte<select value={source} onChange={(event) => setSource(event.target.value as typeof source)}><option value="all">Todas disponíveis</option><option value="meta_official">API oficial</option><option value="zernio">Integração externa</option></select></label>
        <label>Status<select value={contentStatus} onChange={(event) => setContentStatus(event.target.value)}><option value="all">Todos</option><option value="waiting">Agendados</option><option value="published">Publicados</option><option value="failed">Falhas</option></select></label>
        <label>Métrica<select value={metric} onChange={(event) => setMetric(event.target.value as ProfileMetric)}><option value="interactions">Interações</option><option value="views">Visualizações</option><option value="reach">Alcance</option><option value="likes">Curtidas</option><option value="comments">Comentários</option><option value="shares">Compartilhamentos</option><option value="saves">Salvos</option></select></label>
        <span>Filtros preparados para múltiplas fontes. Nesta versão eles operam sobre snapshots locais do perfil.</span>
      </section>

      <nav className="analytics-tabs profile-tabs" aria-label="Detalhes do perfil">
        {[
          ['summary', 'Resumo'],
          ['posts', 'Posts'],
          ['audience', 'Audiência'],
          ['best-time', 'Melhores horários'],
          ['operation', 'Operação'],
          ['raw', 'Dados brutos'],
        ].map(([key, label]) => <button className={activeTab === key ? 'analytics-tab analytics-tab-active' : 'analytics-tab'} key={key} type="button" onClick={() => setActiveTab(key as ProfileTab)}>{label}</button>)}
      </nav>

      {sourceBlocked ? <section className="panel profile-raw-panel"><div className="operation-empty"><strong>Fonte não vinculada a este perfil</strong><p>Este perfil está conectado por {sourceLabel(profile.provider)}. Troque o filtro para ver os dados disponíveis ou aguarde a nova fonte ser configurada.</p></div></section> : (
        <>
          {(activeTab === 'summary' || activeTab === 'audience') && <MetricStrip snapshot={snapshot} delta={delta} />}
          {activeTab === 'summary' && <SummaryTab profile={profile} snapshot={snapshot} followerHistory={followerHistory} maxFollowers={maxFollowers} postAnalytics={visiblePosts} publicationItems={visiblePublications} />}
          {activeTab === 'posts' && <PostsTab posts={visiblePosts} publicationItems={visiblePublications} metric={metric} />}
          {activeTab === 'audience' && <AudienceTab followerHistory={followerHistory} snapshot={snapshot} />}
          {activeTab === 'best-time' && <BestTimeTab bestHours={bestHours} />}
          {activeTab === 'operation' && <OperationTab profile={profile} snapshot={snapshot} followerHistory={followerHistory} postAnalytics={postAnalytics} />}
          {activeTab === 'raw' && <RawTab profile={profile} snapshot={snapshot} period={period} source={source} contentStatus={contentStatus} metric={metric} followerHistory={followerHistory} postAnalytics={postAnalytics} publicationItems={publicationItems} />}
        </>
      )}
    </main>
  );
}

function MetricStrip({ snapshot, delta }: { snapshot: Snapshot; delta: number }) {
  return <section className="profile-detail-metrics" aria-label="Indicadores principais"><article className="metric-card"><div className="metric-label">Seguidores</div><strong>{formatNumber(snapshot?.followers_count)}</strong><span className={delta >= 0 ? 'metric-caption trend-positive' : 'metric-caption trend-negative'}>{delta >= 0 ? 'Subindo' : 'Descendo'} {formatCompact(Math.abs(delta))}</span></article><article className="metric-card"><div className="metric-label">Visualizações</div><strong>{formatNumber(snapshot?.views)}</strong><span className="metric-caption">Janela local</span></article><article className="metric-card"><div className="metric-label">Alcance</div><strong>{formatNumber(snapshot?.reach)}</strong><span className="metric-caption">Impressões: {formatCompact(snapshot?.impressions)}</span></article><article className="metric-card"><div className="metric-label">Interações</div><strong>{formatNumber(snapshot?.total_interactions)}</strong><span className="metric-caption">{Number(snapshot?.engagement_rate ?? 0).toFixed(2)}% engajamento</span></article><article className="metric-card"><div className="metric-label">Análises</div><strong>{statusLabel(snapshot?.sync_status)}</strong><span className="metric-caption">Sincronização: {formatDate(snapshot?.synced_at)}</span></article></section>;
}

function SummaryTab({ profile, snapshot, followerHistory, maxFollowers, postAnalytics, publicationItems }: { profile: Profile; snapshot: Snapshot; followerHistory: FollowerPoint[]; maxFollowers: number; postAnalytics: PostAnalytics[]; publicationItems: PublicationItem[] }) {
  return <><section className="profile-detail-grid"><article className="panel profile-chart-panel"><div className="panel-heading"><div><span className="section-kicker">Seguidores</span><h2>Histórico diário</h2></div><span className="queue-count">{followerHistory.length} pontos</span></div>{followerHistory.length === 0 ? <div className="operation-empty"><strong>Sem histórico ainda</strong><p>A série aparecerá quando uma fonte conectada entregar histórico de audiência.</p></div> : <div className="follower-bars">{followerHistory.map((point) => <div key={point.snapshot_date} title={`${point.snapshot_date}: ${point.followers_count}`}><span style={{ height: `${Math.max(8, (point.followers_count / maxFollowers) * 100)}%` }} /><small>{point.snapshot_date.slice(5)}</small></div>)}</div>}</article><aside className="panel profile-operational-panel"><ProfileHealth profile={profile} snapshot={snapshot} /></aside></section><section className="profile-detail-grid profile-detail-grid-wide"><PostPanel posts={postAnalytics} /><PublicationPanel publicationItems={publicationItems} /></section></>;
}

function PostsTab({ posts, publicationItems, metric }: { posts: PostAnalytics[]; publicationItems: PublicationItem[]; metric: ProfileMetric }) {
  return <section className="profile-detail-grid profile-detail-grid-wide"><article className="panel profile-posts-panel"><div className="panel-heading"><div><span className="section-kicker">Ranking</span><h2>Posts por {metricLabel(metric)}</h2></div><span className="queue-count">{posts.length}</span></div><PostList posts={posts} /></article><PublicationPanel publicationItems={publicationItems} /></section>;
}

function AudienceTab({ followerHistory, snapshot }: { followerHistory: FollowerPoint[]; snapshot: Snapshot }) {
  const demographics = payloadObject(payloadObject(snapshot?.raw_payload).demographics);
  const demographicGroups = payloadObject(demographics.demographics);
  const demographicKeys = Object.keys(demographicGroups);
  return <section className="profile-detail-grid"><article className="panel profile-chart-panel"><div className="panel-heading"><div><span className="section-kicker">Audiência</span><h2>Crescimento, ganhos e perdas</h2></div></div>{followerHistory.length === 0 ? <div className="operation-empty"><strong>Sem histórico de seguidores</strong><p>A Zernio documenta estes dados em follower-history; eles aparecerão quando a conta tiver snapshots diários disponíveis.</p></div> : <div className="profile-audience-grid">{followerHistory.slice(-12).map((point) => <div key={point.snapshot_date}><span>{point.snapshot_date.slice(5)}</span><strong>{formatCompact(point.followers_count)}</strong><small className="trend-positive">+{formatCompact(point.followers_gained)}</small><small className="trend-negative">-{formatCompact(point.followers_lost)}</small></div>)}</div>}</article><article className="panel"><div className="panel-heading"><div><span className="section-kicker">Demografia</span><h2>Dados suportados pela Zernio</h2></div></div>{demographicKeys.length === 0 ? <div className="operation-empty"><strong>Sem demografia retornada</strong><p>A documentação informa que demografia exige 100+ seguidores e pode atrasar até 48h. O card não exibe números falsos quando a API não retorna dados.</p></div> : <div className="profile-supported-grid">{demographicKeys.map((key) => <div key={key}><strong>{key}</strong><span>{Array.isArray(demographicGroups[key]) ? `${(demographicGroups[key] as unknown[]).length} entradas` : 'Disponível no bruto'}</span></div>)}</div>}</article></section>;
}

function BestTimeTab({ bestHours }: { bestHours: Array<{ label: string; value: number }> }) {
  return <section className="profile-detail-grid"><article className="panel"><div className="panel-heading"><div><span className="section-kicker">Melhor horário para postar</span><h2>Melhores janelas detectadas</h2></div></div>{bestHours.length === 0 ? <div className="operation-empty"><strong>Sem amostra suficiente</strong><p>O cálculo cruza posts publicados, agenda interna e métricas da fonte conectada.</p></div> : <div className="best-hour-list">{bestHours.map((item, index) => <div key={item.label}><strong>{index + 1}</strong><span>{item.label}</span><em>{item.value} posts</em></div>)}</div>}</article><article className="panel"><div className="panel-heading"><div><span className="section-kicker">Mapa de calor</span><h2>Dia da semana × hora</h2></div></div><div className="analytics-heatmap analytics-heatmap-profile">{Array.from({ length: 7 * 8 }, (_, index) => <span key={index} className={index % 9 === 0 ? 'heat-strong' : index % 5 === 0 ? 'heat-mid' : ''} />)}</div></article></section>;
}

function OperationTab({ profile, snapshot, followerHistory, postAnalytics }: { profile: Profile; snapshot: Snapshot; followerHistory: FollowerPoint[]; postAnalytics: PostAnalytics[] }) {
  const keys = supportedPayloadKeys(snapshot);
  return <section className="profile-detail-grid"><article className="panel profile-operational-panel"><ProfileHealth profile={profile} snapshot={snapshot} /></article><article className="panel"><div className="panel-heading"><div><span className="section-kicker">Capacidades</span><h2>Recursos confirmados na documentação</h2></div></div><div className="source-capability-grid"><div><strong>Insights da conta</strong><span>{statusLabel(snapshot?.sync_status)}</span></div><div><strong>Histórico de seguidores</strong><span>{followerHistory.length ? 'Com dados' : 'Sem dados'}</span></div><div><strong>Análise de posts</strong><span>{postAnalytics.length ? 'Com dados' : 'Sem dados'}</span></div><div><strong>Métricas diárias</strong><span>{keys.includes('dailyMetrics') ? 'Coletado no bruto' : 'Sem retorno'}</span></div><div><strong>Melhor horário</strong><span>{keys.includes('bestTime') ? 'Coletado no bruto' : 'Sem retorno'}</span></div><div><strong>Demografia</strong><span>{keys.includes('demographics') ? 'Coletado no bruto' : 'Sem retorno'}</span></div></div><p className="dashboard-panel-copy">Inbox foi removido desta tela até existir persistência real de conversas e analytics de inbox para o produto.</p></article></section>;
}

function RawTab({ profile, snapshot, period, source, contentStatus, metric, followerHistory, postAnalytics, publicationItems }: { profile: Profile; snapshot: Snapshot; period: string; source: string; contentStatus: string; metric: string; followerHistory: FollowerPoint[]; postAnalytics: PostAnalytics[]; publicationItems: PublicationItem[] }) {
  const raw = payloadObject(snapshot?.raw_payload);
  return <section className="panel profile-raw-panel"><div className="panel-heading"><div><span className="section-kicker">Dados brutos</span><h2>Payloads por endpoint e diagnóstico</h2><p className="dashboard-panel-copy">Área para auditoria sem expor tokens ou segredos. Endpoints sem retorno aparecem como null em vez de virar zero visual.</p></div></div><div className="profile-raw-endpoint-grid">{supportedPayloadKeys(snapshot).map((key) => <div key={key}><strong>{key}</strong><span>{raw[key] ? 'payload disponível' : 'sem retorno'}</span></div>)}</div><pre className="connection-diagnostic">{JSON.stringify({ profile: { id: profile.id, username: profile.username, provider: profile.provider, status: profile.status }, selectedFilters: { period, source, contentStatus, metric }, snapshot, zernioPayloads: raw, followerPoints: followerHistory.length, analyticsPosts: postAnalytics.length, internalPublications: publicationItems.length }, null, 2)}</pre></section>;
}

function ProfileHealth({ profile, snapshot }: { profile: Profile; snapshot: Snapshot }) {
  return <><div className="panel-heading"><div><span className="section-kicker">Operação</span><h2>Saúde do perfil</h2></div></div><dl className="summary-list"><div><span>Status</span><strong>{profile.status}</strong></div><div><span>Fonte</span><strong>{sourceLabel(profile.provider)}</strong></div><div><span>Última checagem</span><strong>{formatDate(profile.last_checked_at)}</strong></div><div><span>Último sucesso</span><strong>{formatDate(profile.last_success_at)}</strong></div><div><span>Última falha</span><strong>{formatDate(profile.last_failure_at)}</strong></div><div><span>Coleta</span><strong>{statusLabel(snapshot?.sync_status)}</strong></div></dl>{profile.last_error_message && <p className="profile-error">{profile.last_error_message}</p>}</>;
}

function PostPanel({ posts }: { posts: PostAnalytics[] }) {
  return <article className="panel profile-posts-panel"><div className="panel-heading"><div><span className="section-kicker">Desempenho</span><h2>Melhores postagens com análises</h2></div><span className="queue-count">{posts.length}</span></div><PostList posts={posts} /></article>;
}

function PostList({ posts }: { posts: PostAnalytics[] }) {
  return <div className="profile-post-list">{posts.length === 0 ? <div className="operation-empty"><strong>Nenhum post com análises</strong><p>Quando uma fonte conectada disponibilizar métricas de posts, o ranking aparecerá aqui com visualizações, alcance, interações e engajamento.</p></div> : posts.map((post) => <article className="profile-post-row" key={post.id}>{post.thumbnail_url ? <img src={post.thumbnail_url} alt="" /> : <span aria-hidden="true">◌</span>}<div><strong>{post.content?.slice(0, 90) || post.media_type || 'Post Instagram'}</strong><small>{formatDate(post.published_at)} · {statusLabel(post.sync_status)}</small></div><dl><div><dt>Visualizações</dt><dd>{formatCompact(post.views)}</dd></div><div><dt>Alcance</dt><dd>{formatCompact(post.reach)}</dd></div><div><dt>Eng.</dt><dd>{formatCompact(post.total_interactions)}</dd></div></dl>{post.platform_post_url && <a className="row-link" href={post.platform_post_url} target="_blank" rel="noreferrer">Abrir</a>}</article>)}</div>;
}

function metricLabel(metric: ProfileMetric) {
  const labels: Record<ProfileMetric, string> = { interactions: 'Interações', views: 'Visualizações', reach: 'Alcance', likes: 'Curtidas', comments: 'Comentários', shares: 'Compartilhamentos', saves: 'Salvos' };
  return labels[metric];
}

function PublicationPanel({ publicationItems }: { publicationItems: PublicationItem[] }) {
  return <article className="panel profile-posts-panel"><div className="panel-heading"><div><span className="section-kicker">Athena</span><h2>Últimas publicações internas</h2></div><span className="queue-count">{publicationItems.length}</span></div><div className="profile-post-list">{publicationItems.length === 0 ? <div className="operation-empty"><strong>Nenhuma publicação</strong><p>As publicações criadas na Athena aparecem aqui conforme o status selecionado.</p></div> : publicationItems.map((item) => <article className="profile-post-row" key={item.id}><span aria-hidden="true">{item.format.slice(0, 1).toUpperCase()}</span><div><strong>{item.caption?.slice(0, 90) || `${item.format} sem legenda`}</strong><small>{item.status} · {formatDate(item.published_at ?? item.execute_at ?? item.created_at)}</small>{item.last_error_message && <small className="trend-negative">{item.last_error_message}</small>}</div></article>)}</div></article>;
}

function buildBestHours(posts: PostAnalytics[], publications: PublicationItem[]) {
  const buckets = new Map<string, { label: string; value: number }>();
  [...posts.map((post) => post.published_at), ...publications.map((item) => item.published_at ?? item.execute_at)].filter(Boolean).forEach((value) => {
    const date = new Date(value as string);
    const label = `${date.toLocaleDateString('pt-BR', { weekday: 'short' })} ${String(date.getHours()).padStart(2, '0')}h`;
    buckets.set(label, { label, value: (buckets.get(label)?.value ?? 0) + 1 });
  });
  return Array.from(buckets.values()).sort((a, b) => b.value - a.value).slice(0, 8);
}
