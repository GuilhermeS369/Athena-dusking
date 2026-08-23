'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Connection = {
  id: string;
  label: string;
  status: string;
  analytics_enabled: boolean;
  inbox_enabled: boolean;
  last_sync_at: string | null;
  last_error_message: string | null;
  wallet: { posted_balance_micros: number; reserved_micros: number; version: number } | null;
};

type TransferIdentity = { id:string;wallet:{posted_balance_micros:number;reserved_micros:number;version:number}|null;connectionActive:boolean;openReservation:boolean };
type Destination = { id:string;name:string };
type TransferEvent = { id:string;identity_id:string;reason:string;actor_email:string;created_at:string;fromOrganizationName:string;toOrganizationName:string };

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
    analyticsEnabled?: boolean;
  };
  if (!response.ok) throw new Error(body.error ?? 'A operação não pôde ser concluída.');
  return body;
}

export default function TwitterZernioClient({ connections, transferIdentities, destinations, transferEvents, canManage, analyticsGateEnabled }: { connections: Connection[];transferIdentities:TransferIdentity[];destinations:Destination[];transferEvents:TransferEvent[];canManage: boolean;analyticsGateEnabled:boolean }) {
  const router = useRouter();
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [transferIdentityId,setTransferIdentityId]=useState('');
  const [destinationId,setDestinationId]=useState('');
  const [transferReason,setTransferReason]=useState('');
  const [transferConfirmation,setTransferConfirmation]=useState('');

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

  async function setAnalyticsCapability(connection: Connection) {
    const enabling = !connection.analytics_enabled;
    if (enabling && !window.confirm('Ativar Analytics sync permite leituras cobradas em segundo plano pela Zernio. Inbox continuará desligado. Deseja continuar?')) return;
    const justification = window.prompt(enabling ? 'Justifique a ativação controlada do Analytics sync:' : 'Justifique a desativação do Analytics sync:');
    if (!justification) return;
    setBusy(`capabilities:${connection.id}`); setMessage(null);
    try {
      const body = await responseJson(await fetch(`/api/x/integrations/zernio/connections/${connection.id}/capabilities`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analyticsEnabled: enabling, justification, idempotencyKey: crypto.randomUUID() }),
      }));
      setMessage(body.analyticsEnabled ? 'Analytics sync ativado pela Athena. Inbox permanece desligado.' : 'Analytics sync e Inbox desligados pela Athena.');
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao alterar o Analytics sync.'); }
    finally { setBusy(null); }
  }

  async function transferIdentity(event:React.FormEvent){
    event.preventDefault();setBusy('transfer');setMessage(null);
    try{
      await responseJson(await fetch('/api/x/integrations/zernio/identities/transfer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identityId:transferIdentityId,destinationOrganizationId:destinationId,reason:transferReason,idempotencyKey:crypto.randomUUID()})}));
      setMessage('Identidade e saldo transferidos. O histórico financeiro foi preservado e nenhuma conexão ou fila foi recriada.');setTransferIdentityId('');setDestinationId('');setTransferReason('');setTransferConfirmation('');router.refresh();
    }catch(error){setMessage(error instanceof Error?error.message:'Falha na transferência.');}
    finally{setBusy(null);}
  }

  const onlineConnections=connections.filter(connection=>connection.status==='active'||connection.status==='online').length;
  const availableTotal=connections.reduce((sum,connection)=>sum+Number(connection.wallet?.posted_balance_micros??0)-Number(connection.wallet?.reserved_micros??0),0);
  return <div className="content-stack">
    {message ? <div className="notice-banner">{message}</div> : null}
    <section className="zernio-metrics"><article className="metric-card"><span className="metric-label">Conexões</span><strong>{onlineConnections}/{connections.length}</strong><small className="metric-caption">Contas X operacionais</small></article><article className="metric-card"><span className="metric-label">Saldo disponível</span><strong>{usd(availableTotal)}</strong><small className="metric-caption">Após reservas abertas</small></article><article className="metric-card"><span className="metric-label">Analytics</span><strong>{connections.filter(connection=>connection.analytics_enabled).length}</strong><small className="metric-caption">Conexões opt-in</small></article></section>
    {canManage ? <form className="panel auth-form zernio-create-panel" onSubmit={create}>
      <h2>Cadastrar identidade Zernio para o X</h2>
      <p className="muted">A identidade verificada recebe uma única concessão global de US$ 12,00. Trocar a chave não reinicia o saldo.</p>
      <label>Nome da conexão<input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={120} required /></label>
      <label>API key Zernio<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" required /></label>
      <button className="button button-primary" disabled={busy === 'create'}>{busy === 'create' ? 'Validando…' : 'Cadastrar conexão X'}</button>
    </form> : null}
    {canManage ? <form className="panel auth-form" onSubmit={transferIdentity}>
      <h2>Transferir identidade para outra organização</h2>
      <p className="muted">A transferência preserva o saldo restante e a auditoria. Ela nunca cria nova concessão, não move filas e exige que você seja admin nas duas organizações.</p>
      {destinations.length===0?<p className="field-error-message">Nenhuma outra organização habilitada para o X está disponível com seu papel de admin.</p>:<>
        <label>Identidade<select value={transferIdentityId} onChange={(event)=>setTransferIdentityId(event.target.value)} required><option value="">Selecione</option>{transferIdentities.map((identity)=>{const blocked=identity.connectionActive||identity.openReservation;return <option key={identity.id} value={identity.id} disabled={blocked}>{identity.id.slice(0,8)} · {usd(Number(identity.wallet?.posted_balance_micros??0))}{identity.connectionActive?' · remova a conexão':identity.openReservation?' · resolva reservas':''}</option>;})}</select></label>
        <label>Organização de destino<select value={destinationId} onChange={(event)=>setDestinationId(event.target.value)} required><option value="">Selecione</option>{destinations.map((destination)=><option key={destination.id} value={destination.id}>{destination.name}</option>)}</select></label>
        <label>Justificativa<textarea value={transferReason} onChange={(event)=>setTransferReason(event.target.value)} minLength={5} maxLength={1000} rows={3} required /></label>
        <label>Digite TRANSFERIR para confirmar<input value={transferConfirmation} onChange={(event)=>setTransferConfirmation(event.target.value)} autoComplete="off" required /></label>
        <button className="button button-danger" disabled={busy!==null||!transferIdentityId||!destinationId||transferReason.trim().length<5||transferConfirmation!=='TRANSFERIR'}>{busy==='transfer'?'Transferindo…':'Transferir identidade e saldo'}</button>
      </>}
    </form>:null}
    {canManage&&transferEvents.length?<section className="panel"><div className="panel-heading"><div><span className="section-kicker">Auditoria imutável</span><h2>Transferências recentes</h2><p>Eventos de origem ou destino desta organização. Eles não podem ser editados ou apagados.</p></div></div><div className="content-stack">{transferEvents.map((event)=><article key={event.id}><strong>{event.fromOrganizationName} → {event.toOrganizationName}</strong><p className="muted">Identidade {event.identity_id.slice(0,8)} · {new Date(event.created_at).toLocaleString('pt-BR')} · {event.actor_email}</p><p>{event.reason}</p></article>)}</div></section>:null}
    <section className="zernio-connection-grid">
      {connections.length === 0 ? <div className="empty-state"><h2>Nenhuma conexão X</h2><p>Cadastre uma API key Zernio exclusiva para iniciar.</p></div> : connections.map((connection) => {
        const posted = Number(connection.wallet?.posted_balance_micros ?? 0);
        const reserved = Number(connection.wallet?.reserved_micros ?? 0);
        return <article className="panel zernio-connection-card" key={connection.id}>
          <div className="standalone-header"><div><h2>{connection.label}</h2><p className="muted">Status: {connection.status} · Última sincronização: {connection.last_sync_at ? new Date(connection.last_sync_at).toLocaleString('pt-BR') : 'nunca'}</p></div></div>
          <div className="summary-grid">
            <div><span>Saldo contábil</span><strong>{usd(posted)}</strong></div>
            <div><span>Reservado</span><strong>{usd(reserved)}</strong></div>
            <div><span>Disponível</span><strong>{usd(posted - reserved)}</strong></div>
          </div>
          <p className="muted">Analytics sync: {connection.analytics_enabled ? 'ativo' : 'desligado'} · Inbox sync: desligado</p>
          {canManage ? <div className="notice-banner"><strong>Controle pelo Athena</strong><p>O Inbox nunca é ativado. Analytics é opt-in, auditado e só pode ser ligado quando o gate financeiro da organização estiver habilitado.</p></div> : null}
          {connection.last_error_message ? <p className="field-error-message">{connection.last_error_message}</p> : null}
          <div className="actions-row">
            {canManage ? <button type="button" className="button button-primary" onClick={() => connect(connection.id)} disabled={busy !== null}>Conectar contas X</button> : null}
            <button type="button" className="button button-ghost" onClick={() => sync(connection.id)} disabled={busy !== null}>Sincronizar</button>
            {canManage ? <button type="button" className="button button-ghost" onClick={() => setAnalyticsCapability(connection)} disabled={busy !== null || (!connection.analytics_enabled && !analyticsGateEnabled)}>{connection.analytics_enabled ? 'Desligar Analytics sync' : analyticsGateEnabled ? 'Ativar Analytics sync' : 'Analytics aguardando gate'}</button> : null}
            {canManage ? <button type="button" className="button button-danger" onClick={() => remove(connection.id)} disabled={busy !== null}>Remover</button> : null}
          </div>
        </article>;
      })}
    </section>
  </div>;
}
