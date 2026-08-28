'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import type { AuthMirrorLinkState } from '@/lib/auth/mirror-link';
import {
  buildTwitterZernioBulkRows,
  resolveTwitterZernioTarget,
  twitterZernioCapacity,
  type TwitterBulkConnection,
  type TwitterBulkGroup,
} from '@/lib/twitter/zernio-bulk';

import styles from './twitter-profiles.module.css';

type Profile = {
  id: string; username: string; display_name: string | null; avatar_url: string | null;
  status: string; account_tier: string; can_post: boolean; token_valid: boolean;
  can_fetch_analytics: boolean; analytics_enabled: boolean; needs_reconnect: boolean;
  current_connection_id: string | null; connection_label: string | null; available_micros: number;
  group_ids: string[]; pending_count: number; text_count: number; image_count: number;
  gif_count: number; video_count: number; last_synced_at: string | null;
};
type Connection = TwitterBulkConnection & { status: string; available_micros: number; last_sync_at: string | null };
type Notice = { kind: 'success' | 'error'; text: string } | null;
type ConnectMode = 'bulk' | 'manual';

const money = (value: number) => `US$ ${(value / 1e6).toFixed(3).replace('.', ',')}`;
const dateTime = (value: string | null) => value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'Nunca';
const statusLabel = (value: string) => ({ active: 'Online', offline: 'Offline', needs_reauth: 'Reconectar' }[value] ?? value);

export default function TwitterProfilesClient({
  activeOrganization, profiles: initialProfiles, groups, connections: initialConnections, authMirrorLink: initialMirror, initialHasMore, initialCursor,
}: {
  activeOrganization: { id: string; name: string; role: string };
  profiles: Profile[]; groups: TwitterBulkGroup[]; connections: Connection[]; authMirrorLink: AuthMirrorLinkState; initialHasMore: boolean; initialCursor: string | null;
}) {
  const [profiles, setProfiles] = useState(initialProfiles);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [cursor, setCursor] = useState(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [connections, setConnections] = useState(initialConnections);
  const [mirror, setMirror] = useState(initialMirror);
  const [mirrorUrl, setMirrorUrl] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState('');
  const [analyticsByProfile, setAnalyticsByProfile] = useState<Record<string, boolean>>(() => Object.fromEntries(profiles.map((profile) => [profile.id, profile.analytics_enabled])));
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('all');
  const [status, setStatus] = useState('all');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectMode, setConnectMode] = useState<ConnectMode>('bulk');
  const [quantity, setQuantity] = useState('10');
  const [bulkGroup, setBulkGroup] = useState('');
  const [target, setTarget] = useState('');
  const [manualConnection, setManualConnection] = useState('');
  const [manualGroup, setManualGroup] = useState('');
  const canManageMirror = ['admin', 'operator'].includes(activeOrganization.role);
  const canConnect = activeOrganization.role === 'admin';

  async function loadMore() {
    if (!hasMore || !cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await fetch(`/api/x/profiles?limit=100&cursor=${encodeURIComponent(cursor)}`, { cache: 'no-store' });
      const body = await response.json() as { profiles?: Profile[]; hasMore?: boolean; nextCursor?: string | null; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Não foi possível carregar mais perfis X.');
      const incoming = body.profiles ?? [];
      setProfiles((current) => [...current, ...incoming.filter((item) => !current.some((known) => known.id === item.id))]);
      setAnalyticsByProfile((current) => ({ ...current, ...Object.fromEntries(incoming.map((profile) => [profile.id, profile.analytics_enabled])) }));
      setHasMore(Boolean(body.hasMore)); setCursor(body.nextCursor ?? null);
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Falha ao carregar perfis X.' }); }
    finally { setLoadingMore(false); }
  }

  const filtered = useMemo(() => profiles.filter((profile) => {
    const attention = profile.status !== 'active' || !profile.token_valid || profile.needs_reconnect;
    return (group === 'all' || profile.group_ids.includes(group))
      && (status === 'all' || (status === 'attention' ? attention : profile.status === status))
      && `${profile.username} ${profile.display_name ?? ''} ${profile.connection_label ?? ''}`.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR'));
  }), [profiles, group, status, search]);
  const active = profiles.filter((profile) => profile.status === 'active' && profile.token_valid && !profile.needs_reconnect).length;
  const attention = profiles.length - active;
  const selectedGroup = groups.find((item) => item.id === bulkGroup)?.name ?? null;
  const bulk = useMemo(() => buildTwitterZernioBulkRows(connections, Number(quantity), selectedGroup), [connections, quantity, selectedGroup]);
  const resolvedTarget = useMemo(() => resolveTwitterZernioTarget(connections, groups, target), [connections, groups, target]);

  async function refreshConnections(sync = false) {
    setBusy(sync ? 'sync' : 'inventory'); setNotice(null);
    try {
      if (sync) {
        const jobs = await Promise.all(connections.map(async (connection) => {
          const response = await fetch(`/api/x/integrations/zernio/connections/${connection.id}/sync`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
          });
          const payload = await response.json() as { jobId?: string; error?: string };
          if (!response.ok) throw new Error(payload.error ?? `Falha ao sincronizar ${connection.label}.`);
          return { connectionId: connection.id, jobId: payload.jobId };
        }));
        let pending = jobs.filter((job) => job.jobId);
        for (let cycle = 0; cycle < 20 && pending.length; cycle += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
          const states = await Promise.all(pending.map(async (job) => {
            const response = await fetch(`/api/x/integrations/zernio/connections/${job.connectionId}/sync?jobId=${encodeURIComponent(job.jobId!)}`, { cache: 'no-store' });
            return response.ok ? response.json() as Promise<{ status: string }> : { status: 'failed' };
          }));
          pending = pending.filter((_, index) => !['succeeded', 'failed'].includes(states[index]?.status));
        }
      }
      const response = await fetch('/api/x/integrations/zernio/connections', { cache: 'no-store' });
      const payload = await response.json() as { connections?: Array<Connection & { wallet?: { posted_balance_micros?: number; reserved_micros?: number } }>; error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Não foi possível atualizar os inventários.');
      setConnections((payload.connections ?? []).map((item) => ({
        ...item,
        available_micros: Number(item.wallet?.posted_balance_micros ?? item.available_micros ?? 0) - Number(item.wallet?.reserved_micros ?? 0),
        remote_inventory_error_code: item.remote_inventory_error_code ?? (!item.remote_inventory_checked_at ? 'inventory_unavailable' : null),
      })));
      setNotice({ kind: 'success', text: sync ? 'Sincronização concluída ou encaminhada; inventários recarregados.' : 'Inventários atualizados.' });
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Falha ao atualizar.' }); }
    finally { setBusy(''); }
  }

  async function manageMirror(method: 'POST' | 'DELETE') {
    setBusy('mirror'); setNotice(null);
    try {
      const response = await fetch('/api/auth/mirror-link', { method });
      const payload = await response.json() as { mirrorLink?: AuthMirrorLinkState; mirrorUrl?: string; error?: string };
      if (!response.ok || !payload.mirrorLink) throw new Error(payload.error ?? 'Não foi possível alterar o Acesso rápido.');
      setMirror(payload.mirrorLink); setMirrorUrl(payload.mirrorUrl ?? '');
      setNotice({ kind: 'success', text: method === 'DELETE' ? 'Acesso rápido desativado.' : 'Novo link gerado. O link anterior deixou de funcionar.' });
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Falha no Acesso rápido.' }); }
    finally { setBusy(''); }
  }

  async function copy(value: string, message: string) {
    try { await navigator.clipboard.writeText(value); setNotice({ kind: 'success', text: message }); }
    catch { setNotice({ kind: 'error', text: 'O navegador não permitiu copiar automaticamente.' }); }
  }

  async function enqueue() {
    setBusy('connect'); setNotice(null);
    const isBulk = connectMode === 'bulk';
    if (isBulk && !resolvedTarget.valid) { setNotice({ kind: 'error', text: 'Cole exatamente uma linha gerada pelo Bulk Zernio X.' }); return; }
    if (!isBulk && !manualConnection) { setNotice({ kind: 'error', text: 'Selecione uma conexão Zernio.' }); return; }
    try {
      const response = await fetch('/api/x/integrations/zernio/connect-intents', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(isBulk
          ? { mode: 'bulk', target, idempotencyKey: crypto.randomUUID() }
          : { mode: 'manual', connectionId: manualConnection, groupId: manualGroup || null, idempotencyKey: crypto.randomUUID() }),
      });
      const payload = await response.json() as { intentId?: string; error?: string };
      if (!response.ok || !payload.intentId) throw new Error(payload.error ?? 'Não foi possível iniciar a conexão.');
      window.location.assign(`/x/zernio/aguardando?intent=${encodeURIComponent(payload.intentId)}`);
    } catch (error) { setBusy(''); setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Falha ao conectar.' }); }
  }

  async function changeAnalytics(profile: Profile) {
    const enabled = !(analyticsByProfile[profile.id] ?? profile.analytics_enabled);
    if (!enabled && !window.confirm(`Desativar o Analytics de @${profile.username}? Coletas ainda não iniciadas deste perfil serão canceladas.`)) return;
    setBusy(`analytics:${profile.id}`); setNotice(null);
    try {
      const response = await fetch(`/api/x/profiles/${profile.id}/analytics`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, idempotencyKey: crypto.randomUUID() }),
      });
      const payload = await response.json() as { analyticsEnabled?: boolean; error?: string };
      if (!response.ok || typeof payload.analyticsEnabled !== 'boolean') throw new Error(payload.error ?? 'Não foi possível alterar o Analytics.');
      setAnalyticsByProfile((current) => ({ ...current, [profile.id]: payload.analyticsEnabled! }));
      setNotice({ kind: 'success', text: payload.analyticsEnabled ? `Analytics de @${profile.username} ativado.` : `Analytics de @${profile.username} desativado.` });
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Falha ao alterar o Analytics.' }); }
    finally { setBusy(''); }
  }

  return <main className={styles.page}>
    <header className={styles.hero}>
      <div className={styles.heroCopy}><span className={styles.kicker}>{activeOrganization.name} · X / Twitter</span><h1>Perfis X</h1><p>Contas, capacidade, saldo e conexões Zernio em uma visão clara.</p></div>
      <div className={styles.heroActions}>
        {canManageMirror ? <button className={styles.secondaryButton} disabled={busy === 'sync'} onClick={() => void refreshConnections(true)}>{busy === 'sync' ? 'Sincronizando…' : 'Sincronizar'}</button> : null}
        {canConnect ? <><button className={styles.secondaryButton} onClick={() => setBulkOpen(true)}>Bulk Zernio</button><button className={styles.primaryButton} onClick={() => setConnectOpen(true)}>＋ Conectar conta</button></> : null}
      </div>
    </header>

    {notice ? <div className={`${styles.notice} ${notice.kind === 'error' ? styles.noticeError : styles.noticeSuccess}`} role="status"><span>{notice.text}</span><button aria-label="Fechar aviso" onClick={() => setNotice(null)}>×</button></div> : null}

    {canManageMirror ? <section className={styles.quickAccess}>
      <div className={styles.quickIcon}>↗</div><div className={styles.quickCopy}><span className={styles.kicker}>Acesso rápido compartilhado</span><h2>{mirror.active ? 'Link ativo para esta organização' : 'Nenhum link ativo'}</h2><p>É o mesmo link do Instagram e continua abrindo em <strong>/perfis</strong>. Gerar outro invalida o anterior.</p></div>
      <dl className={styles.quickStats}><div><dt>Status</dt><dd>{mirror.active ? 'Ativo' : 'Inativo'}</dd></div><div><dt>Autor</dt><dd>{mirror.createdByEmail ?? '—'}</dd></div><div><dt>Usos</dt><dd>{mirror.useCount}</dd></div><div><dt>Último uso</dt><dd>{dateTime(mirror.lastUsedAt)}</dd></div></dl>
      <div className={styles.quickActions}>
        <button className={styles.primaryButton} disabled={busy === 'mirror'} onClick={() => void manageMirror('POST')}>{mirror.active ? 'Rotacionar link' : 'Gerar link'}</button>
        {mirrorUrl ? <button className={styles.secondaryButton} onClick={() => void copy(mirrorUrl, 'Link copiado.')}>Copiar link novo</button> : null}
        {mirror.active ? <button className={styles.dangerButton} disabled={busy === 'mirror'} onClick={() => void manageMirror('DELETE')}>Desativar</button> : null}
      </div>
    </section> : null}

    <section className={styles.toolbar}>
      <div className={styles.tabs}>
        {[['all', 'Todas', profiles.length], ['active', 'Online', active], ['attention', 'Atenção', attention]].map(([value, label, count]) => <button key={String(value)} className={status === value ? styles.activeTab : ''} onClick={() => setStatus(String(value))}><span>{label}</span><strong>{count}</strong></button>)}
      </div>
      <div className={styles.filters}>
        <label><span>Grupo</span><select value={group} onChange={(event) => setGroup(event.target.value)}><option value="all">Todos os grupos</option>{groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">Todos</option><option value="active">Online</option><option value="attention">Com atenção</option><option value="offline">Offline</option><option value="needs_reauth">Reconectar</option></select></label>
        <label className={styles.search}><span>Buscar</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="@usuário, nome ou conexão" /></label>
        <output>{filtered.length} perfil(is)</output>
      </div>
    </section>

    {!filtered.length ? <section className={styles.empty}><span>𝕏</span><h2>{profiles.length ? 'Nenhum perfil neste filtro' : 'Nenhum perfil X conectado'}</h2><p>{profiles.length ? 'Ajuste os filtros para encontrar outras contas.' : 'Use Conectar conta para reservar uma vaga e iniciar o OAuth.'}</p></section> : <section className={styles.grid}>
      {filtered.map((profile) => {
        const profileGroups = groups.filter((item) => profile.group_ids.includes(item.id));
        const healthy = profile.status === 'active' && profile.token_valid && !profile.needs_reconnect;
        const analyticsEnabled = analyticsByProfile[profile.id] ?? profile.analytics_enabled;
        return <article className={styles.card} key={profile.id}>
          <div className={styles.cardTop}>
            {profile.avatar_url ? <img className={styles.avatar} src={profile.avatar_url} alt="" /> : <span className={styles.avatarFallback}>{profile.username.slice(0, 1).toUpperCase()}</span>}
            <div className={styles.identity}><h2><a href={`https://x.com/${encodeURIComponent(profile.username)}`} target="_blank" rel="noreferrer">@{profile.username} ↗</a></h2><p>{profile.display_name ?? 'Perfil X'}</p></div>
            <span className={`${styles.state} ${healthy ? styles.stateOk : styles.stateWarn}`}>{healthy ? 'Online' : statusLabel(profile.status)}</span>
          </div>
          <div className={styles.chips}><span>{profile.connection_label ?? 'Sem conexão'}</span><span>{profile.account_tier === 'premium' ? 'Premium' : '280 caracteres'}</span><span className={analyticsEnabled ? styles.analyticsOn : styles.analyticsOff}>Analytics {analyticsEnabled ? 'ativo' : 'desligado'}</span>{profileGroups.map((item) => <span key={item.id}>{item.name}</span>)}</div>
          <div className={styles.metrics}><div><strong>{profile.pending_count}</strong><span>Na fila</span></div><div><strong>{profile.text_count}</strong><span>Texto</span></div><div><strong>{profile.image_count}</strong><span>Imagem</span></div><div><strong>{profile.video_count + profile.gif_count}</strong><span>Vídeo/GIF</span></div></div>
          <dl className={styles.details}><div><dt>Saldo</dt><dd>{money(profile.available_micros)}</dd></div><div><dt>Postagem</dt><dd>{profile.can_post ? 'Liberada' : 'Bloqueada'}</dd></div><div><dt>Token</dt><dd>{profile.token_valid ? 'Válido' : 'Atenção'}</dd></div><div><dt>Última sincronização</dt><dd>{dateTime(profile.last_synced_at)}</dd></div></dl>
          <div className={styles.cardActions}><Link className={styles.cardAction} href={`/x/perfis/${profile.id}`}>Ver detalhes <span>→</span></Link>{activeOrganization.role === 'admin' ? <button className={analyticsEnabled ? styles.analyticsDisableButton : styles.analyticsEnableButton} disabled={Boolean(busy) || !profile.current_connection_id} onClick={() => void changeAnalytics(profile)}>{busy === `analytics:${profile.id}` ? 'Salvando…' : analyticsEnabled ? 'Desativar Analytics' : 'Ativar Analytics'}</button> : null}</div>
        </article>;
      })}
    </section>}
    {hasMore ? <button className="button button-secondary" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Carregando…' : 'Carregar mais perfis'}</button> : null}

    {bulkOpen ? <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setBulkOpen(false); }}><section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="bulk-title"><div className={styles.modalHeader}><div><span className={styles.kicker}>Planejamento de vagas</span><h2 id="bulk-title">Bulk Zernio X</h2></div><button className={styles.close} onClick={() => setBulkOpen(false)} aria-label="Fechar">×</button></div>
      <div className={styles.formGrid}><label><span>Quantidade</span><input type="number" min="1" step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label><label><span>Grupo X opcional</span><select value={bulkGroup} onChange={(event) => setBulkGroup(event.target.value)}><option value="">Sem grupo</option>{groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
      <div className={styles.summary}><div><strong>{bulk.requested}</strong><span>Solicitadas</span></div><div><strong>{bulk.rows.length}</strong><span>Geradas</span></div><div><strong>{bulk.availableSlots}</strong><span>Vagas reais</span></div><div><strong>{bulk.fullConnections}</strong><span>Lotadas</span></div><div><strong>{bulk.unavailableConnections}</strong><span>Sem inventário</span></div></div>
      <label className={styles.textareaLabel}><span>Linhas para Excel</span><textarea readOnly value={bulk.text} placeholder="Nenhuma vaga válida disponível." /></label>
      <div className={styles.connectionList}>{connections.map((item) => { const capacity = twitterZernioCapacity(item); return <div key={item.id}><span><strong>{item.label}</strong><small>{capacity.snapshotValid ? `${capacity.occupied} ocupadas + ${capacity.reservations} reservadas` : 'Inventário indisponível'}</small></span><b>{capacity.freeSlots} vagas</b></div>; })}</div>
      <div className={styles.modalActions}><button className={styles.secondaryButton} disabled={busy === 'sync'} onClick={() => void refreshConnections(true)}>{busy === 'sync' ? 'Atualizando…' : 'Atualizar inventários'}</button><button className={styles.primaryButton} disabled={!bulk.text} onClick={() => void copy(bulk.text, 'Linhas copiadas para colar no Excel.')}>Copiar linhas</button></div>
    </section></div> : null}

    {connectOpen ? <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setConnectOpen(false); }}><section className={styles.modalSmall} role="dialog" aria-modal="true" aria-labelledby="connect-title"><div className={styles.modalHeader}><div><span className={styles.kicker}>Nova conta X</span><h2 id="connect-title">Conectar conta</h2></div><button className={styles.close} onClick={() => setConnectOpen(false)} aria-label="Fechar">×</button></div>
      <div className={styles.modeTabs}><button className={connectMode === 'bulk' ? styles.activeMode : ''} onClick={() => setConnectMode('bulk')}>Zernio em massa</button><button className={connectMode === 'manual' ? styles.activeMode : ''} onClick={() => setConnectMode('manual')}>Zernio manual</button></div>
      {connectMode === 'bulk' ? <div className={styles.connectBody}><label><span>Linha do Bulk</span><input autoComplete="off" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="Conta Zernio;Grupo X" /></label><div className={`${styles.validation} ${resolvedTarget.valid ? styles.validationOk : ''}`}><span>Conexão: {resolvedTarget.connectionStatus === 'found' ? resolvedTarget.connection?.label : 'não encontrada exatamente'}</span><span>Grupo: {resolvedTarget.groupStatus === 'not_requested' ? 'não solicitado' : resolvedTarget.groupStatus === 'found' ? resolvedTarget.group?.name : 'não encontrado exatamente'}</span></div><p>A validação respeita o texto gerado e o Analytics será ativado obrigatoriamente ao concluir o OAuth.</p></div>
      : <div className={styles.connectBody}><label><span>Conexão Zernio</span><select value={manualConnection} onChange={(event) => setManualConnection(event.target.value)}><option value="">Selecione</option>{connections.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label><span>Grupo X opcional</span><select value={manualGroup} onChange={(event) => setManualGroup(event.target.value)}><option value="">Sem grupo</option>{groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><p>A vaga será reservada atomicamente e o Analytics será ativado obrigatoriamente ao concluir o OAuth.</p></div>}
      <div className={styles.modalActions}><button className={styles.secondaryButton} onClick={() => setConnectOpen(false)}>Cancelar</button><button className={styles.primaryButton} disabled={busy === 'connect'} onClick={() => void enqueue()}>{busy === 'connect' ? 'Enfileirando…' : 'Conectar neste navegador'}</button></div>
    </section></div> : null}
  </main>;
}
