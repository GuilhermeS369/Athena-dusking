'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Connection = {
  id: string;
  label: string;
  status: string;
  last_sync_at: string | null;
  last_error_message: string | null;
  wallet: { posted_balance_micros: number; reserved_micros: number; version: number } | null;
};

function usd(micros: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }).format(micros / 1_000_000);
}

async function responseJson(response: Response) {
  const body = await response.json().catch(() => ({})) as {
    error?: string;
    authUrl?: string;
    adoptedExistingProfile?: boolean;
    jobId?: string;
    status?: string;
    error_message?: string | null;
  };
  if (!response.ok) throw new Error(body.error ?? 'A operação não pôde ser concluída.');
  return body;
}

export default function TwitterZernioClient({ connections, canManage }: { connections: Connection[]; canManage: boolean }) {
  const router = useRouter();
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy('create'); setMessage(null);
    try {
      const body = await responseJson(await fetch('/api/x/integrations/zernio/connections', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, apiKey }),
      }));
      setApiKey(''); setLabel(''); setMessage(body.adoptedExistingProfile ? 'Conexão cadastrada e profile X existente reconhecido. Agora sincronize.' : 'Conexão cadastrada. Agora conecte as contas X.'); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha no cadastro.'); }
    finally { setBusy(null); }
  }

  async function connect(connectionId: string) {
    setBusy(`connect:${connectionId}`); setMessage(null);
    try {
      const body = await responseJson(await fetch(`/api/x/integrations/zernio/connections/${connectionId}/connect`, { method: 'POST' }));
      if (!body.authUrl) throw new Error('A Zernio não retornou a autorização.');
      window.location.assign(body.authUrl);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao conectar.'); setBusy(null); }
  }

  async function sync(connectionId: string) {
    setBusy(`sync:${connectionId}`); setMessage(null);
    try {
      const started = await responseJson(await fetch(`/api/x/integrations/zernio/connections/${connectionId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      }));
      if (!started.jobId) throw new Error('A fila não retornou o job de sincronização.');
      setMessage('Sincronização X enfileirada no worker dedicado.');
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        const current = await responseJson(await fetch(
          `/api/x/integrations/zernio/connections/${connectionId}/sync?jobId=${encodeURIComponent(started.jobId)}`,
          { cache: 'no-store' },
        ));
        if (current.status === 'succeeded') {
          setMessage('Perfis X sincronizados.'); router.refresh(); return;
        }
        if (current.status === 'failed' || current.status === 'cancelled') {
          throw new Error(current.error_message ?? 'A sincronização X falhou.');
        }
      }
      setMessage('A sincronização continua na fila. Você pode atualizar a página depois.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao sincronizar.'); }
    finally { setBusy(null); }
  }

  async function remove(connectionId: string) {
    const reason = window.prompt('Informe o motivo da remoção. A fila futura será cancelada e reservas utilizáveis serão liberadas:');
    if (!reason) return;
    setBusy(`delete:${connectionId}`); setMessage(null);
    try {
      await responseJson(await fetch(`/api/x/integrations/zernio/connections/${connectionId}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
      }));
      setMessage('Conexão removida sem apagar o histórico financeiro.'); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao remover.'); }
    finally { setBusy(null); }
  }

  return <div className="content-stack">
    {message ? <div className="notice-banner">{message}</div> : null}
    {canManage ? <form className="panel auth-form" onSubmit={create}>
      <h2>Cadastrar identidade Zernio para o X</h2>
      <p className="muted">A identidade verificada recebe uma única concessão global de US$ 12,00. Trocar a chave não reinicia o saldo.</p>
      <label>Nome da conexão<input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={120} required /></label>
      <label>API key Zernio<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" required /></label>
      <button className="button button-primary" disabled={busy === 'create'}>{busy === 'create' ? 'Validando…' : 'Cadastrar conexão X'}</button>
    </form> : null}
    <section className="content-stack">
      {connections.length === 0 ? <div className="empty-state"><h2>Nenhuma conexão X</h2><p>Cadastre uma API key Zernio exclusiva para iniciar.</p></div> : connections.map((connection) => {
        const posted = Number(connection.wallet?.posted_balance_micros ?? 0);
        const reserved = Number(connection.wallet?.reserved_micros ?? 0);
        return <article className="panel" key={connection.id}>
          <div className="standalone-header"><div><h2>{connection.label}</h2><p className="muted">Status: {connection.status} · Última sincronização: {connection.last_sync_at ? new Date(connection.last_sync_at).toLocaleString('pt-BR') : 'nunca'}</p></div></div>
          <div className="summary-grid">
            <div><span>Saldo contábil</span><strong>{usd(posted)}</strong></div>
            <div><span>Reservado</span><strong>{usd(reserved)}</strong></div>
            <div><span>Disponível</span><strong>{usd(posted - reserved)}</strong></div>
          </div>
          {connection.last_error_message ? <p className="field-error-message">{connection.last_error_message}</p> : null}
          <div className="actions-row">
            {canManage ? <button type="button" className="button button-primary" onClick={() => connect(connection.id)} disabled={busy !== null}>Conectar contas X</button> : null}
            <button type="button" className="button button-ghost" onClick={() => sync(connection.id)} disabled={busy !== null}>Sincronizar</button>
            {canManage ? <button type="button" className="button button-danger" onClick={() => remove(connection.id)} disabled={busy !== null}>Remover</button> : null}
          </div>
        </article>;
      })}
    </section>
  </div>;
}
