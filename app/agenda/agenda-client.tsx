'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type Organization = { id: string; name: string; role: 'admin' | 'operator' | 'viewer' };
type Profile = { id: string; username: string };
type Item = {
  id: string; profile_id: string; format: string; status: string; execute_at: string | null; caption: string | null;
  attempt_count: number; next_attempt_at: string | null; last_error_code: string | null; last_error_message: string | null; published_at: string | null; created_at: string;
  instagram_profiles: { username: string }[] | null; publication_batches: { name: string | null }[] | null;
};
type AgendaCursor = { executeAt: string; id: string };

const labels: Record<string, string> = { waiting: 'Agendado', ready: 'Pronto', preparing: 'Preparando', publishing: 'Publicando', published: 'Publicado', failed: 'Falhou', cancelled: 'Cancelado' };
const dayFormatter = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
const timeFormatter = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

function dayKey(value: string | null) {
  if (!value) return 'sem-horario';
  return new Intl.DateTimeFormat('en-CA').format(new Date(value));
}

export default function AgendaClient({ activeOrganization, profiles, items: initialItems }: { activeOrganization: Organization; profiles: Profile[]; items: Item[] }) {
  const [items, setItems] = useState(initialItems);
  const [profileId, setProfileId] = useState('');
  const [status, setStatus] = useState('all');
  const [windowDays, setWindowDays] = useState('30');
  const [cursor, setCursor] = useState<AgendaCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Item | null>(null);
  const [message, setMessage] = useState('');
  const [actionId, setActionId] = useState<string | null>(null);
  const canManage = activeOrganization.role !== 'viewer';

  const byDay = useMemo(() => items.reduce<Record<string, Item[]>>((groups, item) => { const key = dayKey(item.execute_at ?? item.published_at); (groups[key] ??= []).push(item); return groups; }, {}), [items]);

  async function loadAgendaPage(append = false) {
    if (append && (!hasMore || !cursor || loading)) return;
    if (!append && loading) return;

    setLoading(true);
    try {
      const start = new Date();
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + Number(windowDays));
      const params = new URLSearchParams({
        limit: '80',
        start: start.toISOString(),
        end: end.toISOString(),
        status,
      });
      if (profileId) params.set('profileId', profileId);
      if (append && cursor) {
        params.set('cursorExecuteAt', cursor.executeAt);
        params.set('cursorId', cursor.id);
      }
      const response = await fetch(`/api/agenda-items?${params.toString()}`, { cache: 'no-store' });
      const body = await response.json() as { items?: Item[]; hasMore?: boolean; nextCursor?: AgendaCursor | null; error?: string };
      if (!response.ok || !body.items) {
        setMessage(body.error ?? 'Não foi possível carregar a agenda.');
        return;
      }
      setItems((current) => append ? [...current, ...body.items!] : body.items!);
      setCursor(body.nextCursor ?? null);
      setHasMore(Boolean(body.hasMore));
      if (!append) setSelected(null);
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAgendaPage(false);
  // Recarrega a agenda quando filtros/janela mudam.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, status, windowDays]);

  async function runAction(item: Item, action: 'cancel' | 'retry') {
    setActionId(item.id); setMessage('');
    try {
      const response = await fetch(`/api/publications/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const body = await response.json() as { item?: { status: string }; error?: string };
      if (!response.ok || !body.item) { setMessage(body.error ?? 'Não foi possível atualizar a publicação.'); return; }
      const updated = { ...item, status: body.item.status, last_error_message: action === 'retry' ? null : item.last_error_message };
      setItems((current) => current.map((entry) => entry.id === item.id ? updated : entry)); setSelected(updated);
      setMessage(action === 'retry' ? 'Publicação enviada novamente para a fila.' : 'Publicação cancelada.');
    } catch { setMessage('Não foi possível conectar ao servidor.'); } finally { setActionId(null); }
  }

  return <main className="standalone-page agenda-page">
    <header className="standalone-header"><div><span className="section-kicker">{activeOrganization.name} · Agenda</span><h1>Agenda de publicação</h1><p>Visualize horários, acompanhe o processamento e aja sobre publicações pendentes.</p></div><Link className="button button-secondary" href="/postagem">＋ Nova postagem</Link></header>
    {message && <p className="inline-message" role="status">{message}</p>}
    <section className="agenda-toolbar panel"><label>Perfil<select value={profileId} onChange={(event) => setProfileId(event.target.value)}><option value="">Todos os perfis</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>@{profile.username}</option>)}</select></label><label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">Todos</option><option value="waiting">Agendados</option><option value="ready">Prontos</option><option value="preparing">Processando</option><option value="publishing">Publicando</option><option value="failed">Falhos</option><option value="published">Publicados</option><option value="cancelled">Cancelados</option></select></label><label>Janela<select value={windowDays} onChange={(event) => setWindowDays(event.target.value)}><option value="7">Próximos 7 dias</option><option value="30">Próximos 30 dias</option><option value="90">Próximos 90 dias</option><option value="180">Próximos 6 meses</option></select></label><button type="button" className="button button-ghost" disabled={loading} aria-busy={loading} onClick={() => void loadAgendaPage(false)}>{loading ? 'Carregando…' : 'Atualizar'}</button><span>{items.length} publicação(ões){hasMore ? ' nesta página' : ''}</span></section>
    <div className="agenda-layout"><section className="agenda-timeline">{Object.entries(byDay).length === 0 ? <div className="panel empty-state"><span className="empty-state-icon">◷</span><h2>{loading ? 'Carregando agenda…' : 'Agenda sem publicações'}</h2><p>{loading ? 'Buscando a janela selecionada.' : 'Crie uma postagem para vê-la organizada por horário.'}</p></div> : <>{Object.entries(byDay).map(([day, entries]) => <section className="agenda-day" key={day}><h2>{day === 'sem-horario' ? 'Sem horário definido' : dayFormatter.format(new Date(`${day}T12:00:00`))}</h2><div>{entries.map((item) => <button type="button" key={item.id} className={`agenda-card status-${item.status}`} onClick={() => setSelected(item)}><time>{item.execute_at ? timeFormatter.format(new Date(item.execute_at)) : 'Agora'}</time><span><strong>{item.publication_batches?.[0]?.name || 'Publicação sem nome'}</strong><small>@{item.instagram_profiles?.[0]?.username ?? 'perfil'} · {item.format}</small></span><em>{labels[item.status] ?? item.status}</em></button>)}</div></section>)}{hasMore && <div className="agenda-load-more"><button type="button" className="button button-ghost" onClick={() => void loadAgendaPage(true)} disabled={loading} aria-busy={loading}>{loading ? 'Carregando…' : 'Ver mais publicações'}</button></div>}</>}</section>
      <aside className="panel agenda-detail">{selected ? <><span className="section-kicker">Detalhes da publicação</span><h2>{selected.publication_batches?.[0]?.name || 'Publicação sem nome'}</h2><dl className="summary-list"><div><dt>Status</dt><dd>{labels[selected.status] ?? selected.status}</dd></div><div><dt>Perfil</dt><dd>@{selected.instagram_profiles?.[0]?.username ?? '—'}</dd></div><div><dt>Execução</dt><dd>{selected.execute_at ? `${dayFormatter.format(new Date(selected.execute_at))}, ${timeFormatter.format(new Date(selected.execute_at))}` : 'Imediata'}</dd></div><div><dt>Tentativas</dt><dd>{selected.attempt_count}</dd></div></dl>{selected.caption && <p className="preview-caption">{selected.caption}</p>}{selected.last_error_message && <p className="queue-error"><strong>{selected.last_error_code ?? 'Erro'}</strong>{selected.last_error_message}</p>}{canManage && <div className="detail-actions">{selected.status === 'failed' && <button className="button button-secondary" type="button" disabled={actionId === selected.id} onClick={() => runAction(selected, 'retry')}>Reprocessar</button>}{['waiting', 'ready', 'failed'].includes(selected.status) && <button className="button button-danger" type="button" disabled={actionId === selected.id} onClick={() => runAction(selected, 'cancel')}>Cancelar</button>}</div>}</> : <div className="agenda-detail-empty"><span>◷</span><h2>Selecione uma publicação</h2><p>Os detalhes, tentativas e ações disponíveis aparecerão aqui.</p></div>}</aside></div>
  </main>;
}
