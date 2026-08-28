'use client';

import { useEffect, useMemo, useState } from 'react';

import styles from './twitter-analytics.module.css';

type AnalyticsStage = 'followers_daily' | 'd1' | 'd7' | 'd30' | 'forced';
type AnalyticsTarget = {
  resourceType: 'profile' | 'post';
  resourceId: string;
  stage: AnalyticsStage;
  requestedFrom?: string;
  requestedTo?: string;
  force?: boolean;
};
type AnalyticsRequestV2 = {
  version: 2;
  targets: AnalyticsTarget[];
  postIds: string[];
  profileIds: string[];
};

export type TwitterAnalyticsConnection = {
  id: string;
  identityId: string;
  label: string;
  status: string;
  analyticsEnabled: boolean;
  lastSyncAt: string | null;
  errorMessage: string | null;
  postedBalanceMicros: number;
  reservedMicros: number;
};
export type TwitterAnalyticsProfile = {
  id: string;
  profileId: string;
  connectionId: string | null;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  accountTier: string;
  status: string;
  canFetchAnalytics: boolean;
  groupIds: string[];
  lastSnapshotAt: string | null;
  followerSnapshotDate: string | null;
  followerCount: number | null;
};
export type TwitterAnalyticsPost = {
  id: string;
  profileId: string;
  connectionId: string | null;
  occurredAt: string;
  content: string;
  completedStage: 'd1' | 'd7' | 'd30' | 'forced' | null;
  lastSnapshotAt: string | null;
};
type Group = { id: string; label: string; profileIds: string[] };
type Quote = {
  reviewToken: string;
  resourceCount: number;
  postCount: number;
  profileCount: number;
  totalMicros: number;
  postReadUnitMicros: number;
  postReadReserveUnits: number;
  postReadMaximumMicros: number;
  profileReadUnitMicros: number;
  profileReadReserveUnits: number;
  canConfirm: boolean;
  walletSnapshots: Array<{
    identityId: string;
    availableMicros: number;
    reservedMicros: number;
    analyticsCostMicros: number;
    projectedAvailableMicros: number;
    protectedFloorMicros: number;
    canFund: boolean;
  }>;
};

const PROFILE_PAGE_SIZE = 15;
const POST_PAGE_SIZE = 8;
const SP_TIME_ZONE = 'America/Sao_Paulo';
const usd = (micros: number) => `US$ ${(micros / 1e6).toFixed(3)}`;
const compactNumber = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const dateTime = (value: string | null) => value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: SP_TIME_ZONE }).format(new Date(value)) : 'Nunca';
const profileKey = (id: string) => `profile:${id}`;
const postKey = (id: string) => `post:${id}`;

function saoPauloDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}

function yesterdayWindow() {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  return saoPauloDate(now);
}

function postStage(post: TwitterAnalyticsPost): Exclude<AnalyticsStage, 'followers_daily' | 'forced'> {
  const days = Math.max(0, (Date.now() - new Date(post.occurredAt).getTime()) / 86_400_000);
  if (days >= 30) return 'd30';
  if (days >= 7) return 'd7';
  return 'd1';
}

function stageLabel(stage: AnalyticsStage) {
  return stage === 'followers_daily' ? 'Followers D-1' : stage === 'forced' ? 'Forçada' : stage.toUpperCase().replace('D', 'D+');
}

function postDue(post: TwitterAnalyticsPost) {
  const days = (Date.now() - new Date(post.occurredAt).getTime()) / 86_400_000;
  const targetStage = postStage(post);
  const stageDays = targetStage === 'd30' ? 30 : targetStage === 'd7' ? 7 : 1;
  if (days < stageDays) return false;
  if (!post.completedStage) return true;
  if (post.completedStage === 'forced') {
    return !post.lastSnapshotAt || new Date(post.lastSnapshotAt).getTime() < new Date(post.occurredAt).getTime() + stageDays * 86_400_000;
  }
  const rank = { d1: 1, d7: 7, d30: 30 } as const;
  return rank[post.completedStage] < rank[targetStage];
}

function profileDue(profile: TwitterAnalyticsProfile) {
  return profile.followerSnapshotDate !== yesterdayWindow();
}

function Avatar({ profile }: { profile: TwitterAnalyticsProfile }) {
  return profile.avatarUrl ? <img className={styles.avatar} src={profile.avatarUrl} alt="" /> : <span className={styles.avatarFallback} aria-hidden="true">{profile.username.slice(0, 1).toUpperCase()}</span>;
}

export function TwitterAnalyticsClient({ profiles, groups, connections, enabled, snapshotCount }: {
  profiles: TwitterAnalyticsProfile[];
  groups: Group[];
  connections: TwitterAnalyticsConnection[];
  enabled: boolean;
  snapshotCount: number;
}) {
  const [search, setSearch] = useState('');
  const [groupId, setGroupId] = useState('');
  const [metricType, setMetricType] = useState<'all' | 'profile' | 'post'>('all');
  const [availability, setAvailability] = useState<'all' | 'eligible' | 'unavailable'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [forced, setForced] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [profileLimits, setProfileLimits] = useState<Record<string, number>>({});
  const [postLimits, setPostLimits] = useState<Record<string, number>>({});
  const [loadedPosts, setLoadedPosts] = useState<Record<string, TwitterAnalyticsPost[]>>({});
  const [postPaging, setPostPaging] = useState<Record<string, { cursor: string | null; hasMore: boolean; loading: boolean; error?: string }>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);

  const connectionById = useMemo(() => new Map(connections.map((connection) => [connection.id, connection])), [connections]);
  const profileById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const posts = useMemo(() => Object.values(loadedPosts).flat(), [loadedPosts]);
  const postsByProfile = useMemo(() => {
    const map = new Map<string, TwitterAnalyticsPost[]>();
    for (const post of posts) map.set(post.profileId, [...(map.get(post.profileId) ?? []), post]);
    return map;
  }, [posts]);

  const eligible = (profile: TwitterAnalyticsProfile) => {
    const connection = profile.connectionId ? connectionById.get(profile.connectionId) : null;
    return Boolean(connection?.analyticsEnabled && connection.status === 'active' && profile.canFetchAnalytics && profile.status === 'active');
  };

  const visibleProfiles = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('pt-BR');
    const groupProfiles = groupId ? new Set(groups.find((group) => group.id === groupId)?.profileIds ?? []) : null;
    return profiles.filter((profile) => {
      const connection = profile.connectionId ? connectionById.get(profile.connectionId) : null;
      const canUse = eligible(profile);
      if (availability === 'eligible' && !canUse) return false;
      if (availability === 'unavailable' && canUse) return false;
      if (groupProfiles && !groupProfiles.has(profile.id)) return false;
      if (needle && !`${profile.username} ${profile.displayName ?? ''} ${connection?.label ?? ''}`.toLocaleLowerCase('pt-BR').includes(needle)) return false;
      return true;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availability, connectionById, groupId, groups, profiles, search]);

  const sections = useMemo(() => {
    const ids = new Set(visibleProfiles.map((profile) => profile.connectionId ?? 'unassigned'));
    const rows: Array<{ connection: TwitterAnalyticsConnection | null; profiles: TwitterAnalyticsProfile[] }> = connections.filter((connection) => ids.has(connection.id)).map((connection) => ({ connection, profiles: visibleProfiles.filter((profile) => profile.connectionId === connection.id) }));
    const orphanProfiles = visibleProfiles.filter((profile) => !profile.connectionId || !connectionById.has(profile.connectionId));
    if (orphanProfiles.length) rows.push({ connection: null, profiles: orphanProfiles });
    return rows.sort((a, b) => Number(Boolean(b.connection?.analyticsEnabled)) - Number(Boolean(a.connection?.analyticsEnabled)) || (a.connection?.label ?? '').localeCompare(b.connection?.label ?? ''));
  }, [connectionById, connections, visibleProfiles]);

  const targets = useMemo<AnalyticsTarget[]>(() => {
    const result: AnalyticsTarget[] = [];
    const day = yesterdayWindow();
    for (const key of selected) {
      const [kind, id] = key.split(':');
      const force = forced.has(key);
      if (kind === 'profile' && profileById.has(id)) result.push({ resourceType: 'profile', resourceId: id, stage: force ? 'forced' : 'followers_daily', requestedFrom: day, requestedTo: day, ...(force ? { force: true } : {}) });
      const post = kind === 'post' ? posts.find((item) => item.id === id) : null;
      if (post) result.push({ resourceType: 'post', resourceId: id, stage: force ? 'forced' : postStage(post), ...(force ? { force: true } : {}) });
    }
    return result.sort((a, b) => `${a.resourceType}:${a.resourceId}`.localeCompare(`${b.resourceType}:${b.resourceId}`));
  }, [forced, posts, profileById, selected]);

  const request = useMemo<AnalyticsRequestV2>(() => ({
    version: 2,
    targets,
    postIds: targets.filter((target) => target.resourceType === 'post').map((target) => target.resourceId),
    profileIds: targets.filter((target) => target.resourceType === 'profile').map((target) => target.resourceId),
  }), [targets]);

  const totalAvailable = connections.reduce((sum, connection) => sum + connection.postedBalanceMicros - connection.reservedMicros, 0);
  const pendingCount = profiles.filter((profile) => eligible(profile) && profileDue(profile)).length + posts.filter((post) => {
    const profile = profileById.get(post.profileId);
    return profile && eligible(profile) && postDue(post);
  }).length;

  function invalidateReview() {
    setQuote(null);
    setReviewOpen(false);
    setIdempotencyKey(null);
  }

  function setSelection(next: Set<string>) {
    setSelected(next);
    setForced((current) => new Set([...current].filter((key) => next.has(key))));
    invalidateReview();
  }

  function toggleSelection(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelection(next);
  }

  function selectKeys(keys: string[]) {
    setSelection(new Set([...selected, ...keys]));
  }

  function selectPreset(preset: 'yesterday' | 'all_due' | 'followers' | 'posts') {
    const next: string[] = [];
    for (const profile of profiles) {
      if (!eligible(profile)) continue;
      if ((preset === 'yesterday' || preset === 'all_due' || preset === 'followers') && profileDue(profile)) next.push(profileKey(profile.id));
      if (preset === 'followers') continue;
      for (const post of postsByProfile.get(profile.id) ?? []) if (postDue(post) && (preset !== 'yesterday' || postStage(post) === 'd1')) next.push(postKey(post.id));
    }
    setSelection(new Set(next));
    setMessage((preset === 'posts' || preset === 'all_due') && !posts.length
      ? { tone: 'error', text: 'Expanda os perfis desejados para carregar e selecionar posts por páginas.' }
      : null);
  }

  async function loadPosts(profileId: string, cursor: string | null = null) {
    if (postPaging[profileId]?.loading) return;
    setPostPaging((current) => ({ ...current, [profileId]: { ...(current[profileId] ?? { cursor: null, hasMore: true }), loading: true, error: undefined } }));
    try {
      const params = new URLSearchParams({ profileId });
      if (cursor) params.set('cursor', cursor);
      const response = await fetch(`/api/x/analytics/resources?${params}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? 'Falha ao carregar posts.');
      const incoming = (payload.posts ?? []) as TwitterAnalyticsPost[];
      setLoadedPosts((current) => {
        const previous = cursor ? current[profileId] ?? [] : [];
        return { ...current, [profileId]: [...new Map([...previous, ...incoming].map((post) => [post.id, post])).values()] };
      });
      setPostPaging((current) => ({ ...current, [profileId]: { cursor: payload.nextCursor ?? null, hasMore: Boolean(payload.hasMore), loading: false } }));
    } catch (error) {
      setPostPaging((current) => ({ ...current, [profileId]: { ...(current[profileId] ?? { cursor: null, hasMore: true }), loading: false, error: error instanceof Error ? error.message : 'Falha ao carregar posts.' } }));
    }
  }

  async function review() {
    if (!targets.length) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/x/analytics/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? 'Falha na revisão.');
      setQuote(payload as Quote);
      setReviewOpen(true);
      const signature = JSON.stringify(targets);
      const storageKey = `twitter-analytics-confirm:${signature}`;
      const saved = sessionStorage.getItem(storageKey);
      const key = saved ?? crypto.randomUUID();
      sessionStorage.setItem(storageKey, key);
      setIdempotencyKey(key);
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Não foi possível revisar o custo.' });
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!quote) return;
    const signature = JSON.stringify(targets);
    const storageKey = `twitter-analytics-confirm:${signature}`;
    const key = idempotencyKey ?? sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
    sessionStorage.setItem(storageKey, key);
    setIdempotencyKey(key);
    setBusy(true);
    try {
      const response = await fetch('/api/x/analytics/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request, reviewToken: quote.reviewToken, idempotencyKey: key }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? 'Falha na confirmação.');
      sessionStorage.removeItem(storageKey);
      setReviewOpen(false);
      setSelection(new Set());
      setMessage({ tone: 'success', text: `Coleta criada para ${payload.resourceCount ?? quote.resourceCount} recurso(s). Você pode acompanhar o processamento nos logs.` });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Não foi possível confirmar a análise.' });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    function close(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) { setReviewOpen(false); setForceOpen(false); }
    }
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [busy]);

  if (!enabled) return <main className={styles.page}><div className={styles.empty}><span aria-hidden="true">◌</span><h1>Análises X desabilitadas</h1><p>Nenhuma leitura será feita enquanto o recurso estiver desabilitado.</p></div></main>;

  return <main className={styles.page}>
    <header className={styles.hero}>
      <div><span className={styles.kicker}>X / Central de análises</span><h1>Coletas sob controle.</h1><p>Encontre perfis, revise pendências e saiba o custo antes de consultar qualquer métrica.</p></div>
      <div className={styles.heroStatus}><span className={styles.liveDot} /> Somente coleta manual</div>
    </header>

    {message ? <div className={`${styles.notice} ${message.tone === 'success' ? styles.noticeSuccess : styles.noticeError}`} role="status"><span>{message.text}</span><button type="button" aria-label="Fechar aviso" onClick={() => setMessage(null)}>×</button></div> : null}

    <section className={styles.overview} aria-label="Resumo">
      <div><span>Zernios ativas</span><strong>{connections.filter((connection) => connection.analyticsEnabled && connection.status === 'active').length}</strong><small>de {connections.length} conectadas</small></div>
      <div><span>Perfis elegíveis</span><strong>{profiles.filter(eligible).length}</strong><small>{profiles.length} perfis locais</small></div>
      <div><span>Pendências</span><strong>{pendingCount}</strong><small>followers e marcos</small></div>
      <div><span>Snapshots locais</span><strong>{snapshotCount}</strong><small>já armazenados</small></div>
      <div className={styles.balanceCard}><span>Saldo disponível</span><strong>{usd(totalAvailable)}</strong><small>somado; revisão separa por Zernio</small></div>
    </section>

    <section className={styles.workspace}>
      <div className={styles.toolbar}>
        <label className={styles.search}><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar Zernio ou @perfil" aria-label="Buscar Zernio ou perfil" /></label>
        <select value={groupId} onChange={(event) => setGroupId(event.target.value)} aria-label="Filtrar por grupo"><option value="">Todos os grupos</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}</select>
        <select value={metricType} onChange={(event) => setMetricType(event.target.value as typeof metricType)} aria-label="Filtrar por métrica"><option value="all">Followers + posts</option><option value="profile">Só followers</option><option value="post">Só posts</option></select>
        <select value={availability} onChange={(event) => setAvailability(event.target.value as typeof availability)} aria-label="Filtrar disponibilidade"><option value="all">Todos os estados</option><option value="eligible">Disponíveis</option><option value="unavailable">Indisponíveis</option></select>
      </div>
      <div className={styles.presets}><span>Seleções rápidas</span><button type="button" onClick={() => selectPreset('yesterday')}>Pendências de ontem</button><button type="button" onClick={() => selectPreset('all_due')}>Todos os marcos vencidos</button><button type="button" onClick={() => selectPreset('followers')}>Followers faltantes</button><button type="button" onClick={() => selectPreset('posts')}>Posts faltantes</button></div>
    </section>

    <div className={styles.connectionList}>
      {sections.map(({ connection, profiles: sectionProfiles }) => {
        const connectionEnabled = Boolean(connection?.analyticsEnabled && connection.status === 'active');
        const visibleLimit = profileLimits[connection?.id ?? 'unassigned'] ?? PROFILE_PAGE_SIZE;
        const displayedProfiles = sectionProfiles.slice(0, visibleLimit);
        const selectableKeys = sectionProfiles.flatMap((profile) => {
          if (!eligible(profile)) return [];
          const keys: string[] = metricType !== 'post' ? [profileKey(profile.id)] : [];
          if (metricType !== 'profile') keys.push(...(postsByProfile.get(profile.id) ?? []).filter(postDue).map((post) => postKey(post.id)));
          return keys;
        });
        const connectionSelected = selectableKeys.length > 0 && selectableKeys.every((key) => selected.has(key));
        const available = (connection?.postedBalanceMicros ?? 0) - (connection?.reservedMicros ?? 0);
        return <section className={`${styles.connectionCard} ${!connectionEnabled ? styles.connectionDisabled : ''}`} key={connection?.id ?? 'unassigned'}>
          <header className={styles.connectionHeader}>
            <div className={styles.connectionMark} aria-hidden="true">Z</div>
            <div className={styles.connectionIdentity}><div><h2>{connection?.label ?? 'Perfis sem conexão'}</h2><span className={`${styles.status} ${connectionEnabled ? styles.statusOn : styles.statusOff}`}>{connectionEnabled ? 'Analytics ativo' : 'Somente leitura'}</span></div><p>{sectionProfiles.length} perfil(is) · sincronizado {dateTime(connection?.lastSyncAt ?? null)}</p></div>
            <div className={styles.wallet}><span>Disponível</span><strong>{usd(available)}</strong><small>{usd(connection?.reservedMicros ?? 0)} reservado</small></div>
            {connectionEnabled && selectableKeys.length ? <button className={styles.bulkButton} type="button" onClick={() => connectionSelected ? setSelection(new Set([...selected].filter((key) => !selectableKeys.includes(key)))) : selectKeys(selectableKeys)}>{connectionSelected ? 'Desmarcar visíveis' : 'Selecionar pendências'}</button> : <span className={styles.readOnlyHint}>{connection?.errorMessage ?? 'Ative Analytics na conexão para coletar.'}</span>}
          </header>

          <div className={styles.tableHeader}><span>Perfil</span><span>Followers D-1</span><span>Última coleta</span><span>Posts pendentes</span><span>Ações</span></div>
          <div className={styles.profileRows}>
            {displayedProfiles.map((profile) => {
              const canSelect = eligible(profile);
              const profilePosts = postsByProfile.get(profile.id) ?? [];
              const duePosts = profilePosts.filter(postDue);
              const profileSelected = selected.has(profileKey(profile.id));
              const isExpanded = expanded.has(profile.id);
              const limit = postLimits[profile.id] ?? POST_PAGE_SIZE;
              return <article className={`${styles.profileBlock} ${!canSelect ? styles.profileUnavailable : ''}`} key={profile.id}>
                <div className={styles.profileRow}>
                  <div className={styles.profileIdentity}>
                    {metricType !== 'post' ? <input type="checkbox" aria-label={`Selecionar followers de @${profile.username}`} disabled={!canSelect} checked={profileSelected} onChange={() => toggleSelection(profileKey(profile.id))} /> : null}
                    <Avatar profile={profile} /><span><strong>@{profile.username}</strong><small>{profile.displayName || profile.accountTier}{!canSelect ? ` · ${!connectionEnabled ? 'analytics desligado' : !profile.canFetchAnalytics ? 'sem permissão de métricas' : 'perfil indisponível'}` : ''}</small></span>
                  </div>
                  <div className={styles.mobileMetric}><span>Followers D-1</span><strong>{compactNumber(profile.followerCount)}</strong><small>{profileDue(profile) && canSelect ? 'atualização pendente' : 'consolidado'}</small></div>
                  <div className={styles.mobileMetric}><span>Última coleta</span><strong>{dateTime(profile.lastSnapshotAt)}</strong></div>
                  <div className={styles.stageCounts}><span className={duePosts.some((post) => postStage(post) === 'd1') ? styles.stageDue : ''}>D+1 {duePosts.filter((post) => postStage(post) === 'd1').length}</span><span className={duePosts.some((post) => postStage(post) === 'd7') ? styles.stageDue : ''}>D+7 {duePosts.filter((post) => postStage(post) === 'd7').length}</span><span className={duePosts.some((post) => postStage(post) === 'd30') ? styles.stageDue : ''}>D+30 {duePosts.filter((post) => postStage(post) === 'd30').length}</span></div>
                  <div className={styles.rowActions}>{canSelect && metricType !== 'profile' && duePosts.length ? <button type="button" onClick={() => selectKeys(duePosts.map((post) => postKey(post.id)))}>Selecionar pendentes</button> : null}<button type="button" className={styles.expandButton} onClick={() => { const next = new Set(expanded); if (next.has(profile.id)) next.delete(profile.id); else { next.add(profile.id); if (!(profile.id in loadedPosts)) void loadPosts(profile.id); } setExpanded(next); }} aria-expanded={isExpanded}>{isExpanded ? 'Recolher' : `Ver posts${profile.id in loadedPosts ? ` (${profilePosts.length}${postPaging[profile.id]?.hasMore ? '+' : ''})` : ''}`} <span aria-hidden="true">⌄</span></button></div>
                </div>
                {isExpanded ? <div className={styles.postsPanel}>
                  <div className={styles.postsHeading}><strong>Posts publicados</strong><span>Selecionar não consulta nem reserva saldo.</span></div>
                  {postPaging[profile.id]?.loading && !profilePosts.length ? <p className={styles.inlineEmpty}>Carregando primeira página de posts…</p> : null}
                  {postPaging[profile.id]?.error ? <p className={styles.inlineError}>{postPaging[profile.id]?.error} <button type="button" onClick={() => void loadPosts(profile.id, postPaging[profile.id]?.cursor ?? null)}>Tentar novamente</button></p> : null}
                  {profilePosts.length ? profilePosts.slice(0, limit).map((post) => {
                    const due = postDue(post);
                    const key = postKey(post.id);
                    return <label className={styles.postRow} key={post.id}>
                      <input type="checkbox" disabled={!canSelect || metricType === 'profile'} checked={selected.has(key)} onChange={() => toggleSelection(key)} />
                      <span className={styles.postDate}>{new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', timeZone: SP_TIME_ZONE }).format(new Date(post.occurredAt))}</span>
                      <span className={styles.postCopy}>{post.content || 'Post sem texto'}</span>
                      <span className={`${styles.stage} ${due ? styles.stageDue : styles.stageDone}`}>{stageLabel(postStage(post))} · {due ? 'pendente' : 'coletado'}</span>
                      <span className={styles.postLast}>{dateTime(post.lastSnapshotAt)}</span>
                    </label>;
                  }) : !postPaging[profile.id]?.loading && !postPaging[profile.id]?.error ? <p className={styles.inlineEmpty}>Nenhum post publicado neste perfil.</p> : null}
                  {profilePosts.length > limit || postPaging[profile.id]?.hasMore ? <button className={styles.loadMore} type="button" disabled={postPaging[profile.id]?.loading} onClick={() => profilePosts.length > limit ? setPostLimits((current) => ({ ...current, [profile.id]: limit + POST_PAGE_SIZE })) : void loadPosts(profile.id, postPaging[profile.id]?.cursor ?? null)}>{postPaging[profile.id]?.loading ? 'Carregando…' : profilePosts.length > limit ? `Mostrar mais ${Math.min(POST_PAGE_SIZE, profilePosts.length - limit)} posts` : 'Carregar próxima página'}</button> : null}
                </div> : null}
              </article>;
            })}
          </div>
          {sectionProfiles.length > displayedProfiles.length ? <button className={styles.loadMore} type="button" onClick={() => setProfileLimits((current) => ({ ...current, [connection?.id ?? 'unassigned']: visibleLimit + PROFILE_PAGE_SIZE }))}>Mostrar mais {Math.min(PROFILE_PAGE_SIZE, sectionProfiles.length - displayedProfiles.length)} perfis</button> : null}
        </section>;
      })}
      {!sections.length ? <div className={styles.empty}><span aria-hidden="true">⌕</span><h2>Nenhum perfil encontrado</h2><p>Ajuste a busca ou os filtros para continuar.</p></div> : null}
    </div>

    {targets.length ? <aside className={styles.tray} aria-label="Seleção atual"><div className={styles.trayCount}><strong>{targets.length}</strong><span>selecionados</span></div><div className={styles.trayBreakdown}><span>{request.profileIds.length} followers</span><span>{request.postIds.length} posts</span>{forced.size ? <span className={styles.forceTag}>{forced.size} forçados</span> : null}</div><div className={styles.trayEstimate}><span>Reserva preliminar</span><strong>{usd(request.profileIds.length * 10_000 + request.postIds.length * 45_000)}</strong><small>valor exato na revisão</small></div><button className={styles.ghostButton} type="button" onClick={() => setForceOpen(true)}>Forçar nova coleta</button><button className={styles.clearButton} type="button" onClick={() => setSelection(new Set())}>Limpar</button><button className={styles.primaryButton} type="button" disabled={busy} onClick={review}>{busy ? 'Revisando…' : 'Revisar custo →'}</button></aside> : null}

    {forceOpen ? <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setForceOpen(false); }}><section className={styles.modalSmall} role="dialog" aria-modal="true" aria-labelledby="force-title"><header className={styles.modalHeader}><div><span className={styles.kicker}>Nova cobrança</span><h2 id="force-title">Forçar nova coleta?</h2></div><button type="button" onClick={() => setForceOpen(false)} aria-label="Fechar">×</button></header><div className={styles.warningBox}><strong>Os {selected.size} recursos serão consultados novamente.</strong><p>Mesmo que já exista uma coleta recente, a Zernio poderá cobrar uma nova leitura. A revisão financeira ainda será obrigatória.</p></div><div className={styles.modalActions}><button className={styles.ghostButton} type="button" onClick={() => setForceOpen(false)}>Cancelar</button><button className={styles.warningButton} type="button" onClick={() => { setForced(new Set(selected)); invalidateReview(); setForceOpen(false); }}>Entendi, marcar como forçada</button></div></section></div> : null}

    {reviewOpen && quote ? <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setReviewOpen(false); }}><section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="review-title"><header className={styles.modalHeader}><div><span className={styles.kicker}>Revisão financeira</span><h2 id="review-title">Confira antes de reservar</h2><p>Nenhuma métrica foi consultada até aqui.</p></div><button type="button" onClick={() => setReviewOpen(false)} aria-label="Fechar">×</button></header>
      <div className={styles.reviewSummary}><div><span>Perfis</span><strong>{quote.profileCount}</strong><small>{usd(quote.profileReadUnitMicros)} cada</small></div><div><span>Posts</span><strong>{quote.postCount}</strong><small>até {quote.postReadReserveUnits} leituras</small></div><div><span>Forçados</span><strong>{forced.size}</strong><small>nova cobrança possível</small></div><div className={styles.reviewTotal}><span>Reserva máxima</span><strong>{usd(quote.totalMicros)}</strong><small>só o uso comprovado será debitado</small></div></div>
      <div className={styles.walletList}>{quote.walletSnapshots.map((wallet) => { const connection = connections.find((item) => item.identityId === wallet.identityId); return <article className={`${styles.walletReview} ${!wallet.canFund ? styles.walletInsufficient : ''}`} key={wallet.identityId}><div><strong>{connection?.label ?? 'Carteira Zernio'}</strong><span>{wallet.canFund ? 'Saldo aprovado' : 'Saldo insuficiente'}</span></div><dl><div><dt>Disponível</dt><dd>{usd(wallet.availableMicros)}</dd></div><div><dt>Já reservado</dt><dd>{usd(wallet.reservedMicros)}</dd></div><div><dt>Esta coleta</dt><dd>− {usd(wallet.analyticsCostMicros)}</dd></div><div><dt>Saldo projetado</dt><dd>{usd(wallet.projectedAvailableMicros)}</dd></div><div><dt>Piso protegido</dt><dd>{usd(wallet.protectedFloorMicros)}</dd></div></dl></article>; })}</div>
      <div className={styles.billingNote}><span aria-hidden="true">i</span><p>A reserva máxima bloqueia o pior cenário. O excedente é liberado após a comprovação; resultados incertos podem permanecer reservados para reconciliação.</p></div>
      <div className={styles.modalActions}><button className={styles.ghostButton} type="button" disabled={busy} onClick={() => setReviewOpen(false)}>Voltar à seleção</button><button className={styles.primaryButton} type="button" disabled={busy || !quote.canConfirm} onClick={confirm}>{busy ? 'Confirmando…' : `Confirmar e reservar até ${usd(quote.totalMicros)}`}</button></div>
    </section></div> : null}
  </main>;
}
