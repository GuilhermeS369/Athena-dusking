'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type State = { status: string; queuePosition: number | null; authUrl: string | null; username: string | null; profileId: string | null; errorMessage: string | null };
const TERMINAL_STATUSES = ['completed', 'failed', 'expired', 'cancelled'];
const copy: Record<string, { title: string; detail: string }> = {
  queued: { title: 'Sua conexão entrou na fila', detail: 'Este navegador pode ficar aberto. A URL segura será preparada automaticamente.' },
  preparing: { title: 'Preparando autorização', detail: 'A Athena está reservando esta conexão na Zernio.' },
  ready: { title: 'Abrindo o X', detail: 'Você será enviado para autorizar esta conta usando a proxy deste navegador.' },
  callback_received: { title: 'Autorização recebida', detail: 'A confirmação foi enviada ao worker; não abra outro OAuth.' },
  reconciling: { title: 'Confirmando a conta', detail: 'Estamos vinculando exatamente o accountId devolvido pela Zernio.' },
  completed: { title: 'Conta X conectada', detail: 'O perfil já está disponível na Athena.' },
  failed: { title: 'A conexão não foi concluída', detail: 'Nenhuma confirmação falsa foi registrada.' },
  expired: { title: 'Esta solicitação expirou', detail: 'A vaga foi liberada. Gere uma nova solicitação em Perfis X.' },
  cancelled: { title: 'Solicitação cancelada', detail: 'A vaga foi liberada com segurança.' },
};

export default function TwitterConnectProgress({ intentId, completion = false }: { intentId: string; completion?: boolean }) {
  const [state, setState] = useState<State>({ status: completion ? 'callback_received' : 'queued', queuePosition: null, authUrl: null, username: null, profileId: null, errorMessage: null });
  const [networkError, setNetworkError] = useState('');
  useEffect(() => {
    let stopped = false; let redirected = false; let timer = 0; let failures = 0;
    const schedule = (delay: number) => { if (!stopped) timer = window.setTimeout(poll, delay); };
    async function poll() {
      if (stopped) return;
      // Aba oculta não precisa consultar: reavalia localmente, sem rede.
      if (document.visibilityState === 'hidden') { schedule(3000); return; }
      try {
        const response = await fetch(`/api/x/integrations/zernio/connect-intents/${encodeURIComponent(intentId)}`, { cache: 'no-store' });
        const payload = await response.json() as State & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? 'Não foi possível acompanhar esta solicitação.');
        if (stopped) return;
        failures = 0;
        setState(payload); setNetworkError('');
        if (payload.status === 'ready' && payload.authUrl && !redirected) { redirected = true; window.location.assign(payload.authUrl); return; }
        // Estado terminal não muda mais. Sem esta parada, uma aba esquecida aberta
        // consultava indefinidamente a cada 1,8 s (~33 requisições/min).
        if (TERMINAL_STATUSES.includes(payload.status)) return;
        schedule(1800);
      } catch (error) {
        if (stopped) return;
        setNetworkError(error instanceof Error ? error.message : 'Falha de rede.');
        failures += 1;
        schedule(Math.min(30_000, 1800 * 2 ** Math.min(failures, 4)));
      }
    }
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [intentId]);
  const content = copy[state.status] ?? copy.queued;
  const terminal = TERMINAL_STATUSES.includes(state.status);
  return <main className={`xConnectFlow ${state.status === 'completed' ? 'xConnectSuccess' : state.status === 'failed' ? 'xConnectFailure' : ''}`}>
    <section className="xConnectCard" aria-live="polite">
      <span className="xConnectKicker">Athena · Zernio · X</span>
      <div className={`xConnectOrbit ${terminal ? 'xConnectOrbitTerminal' : ''}`} aria-hidden="true"><span>{state.status === 'completed' ? '✓' : state.status === 'failed' ? '!' : '𝕏'}</span></div>
      <div><h1>{content.title}</h1><p>{state.errorMessage || content.detail}</p></div>
      {state.status === 'queued' && state.queuePosition ? <div className="xConnectPosition"><span>Posição aproximada</span><strong>{state.queuePosition}</strong></div> : null}
      {!terminal ? <div className="xConnectProgress"><i /></div> : null}
      {networkError ? <p className="xConnectError">{networkError}</p> : null}
      <p className="xConnectNote"><strong>Não conecte outra conta nesta aba.</strong> Cada navegador acompanha uma solicitação independente e usará a própria proxy ao abrir o X.</p>
      {terminal ? <Link className="button button-primary xConnectAction" href={state.status === 'completed' && state.profileId ? `/x/perfis/${state.profileId}` : '/x/perfis'}>{state.status === 'completed' && state.profileId ? 'Abrir perfil conectado' : 'Voltar para Perfis X'}</Link> : null}
    </section>
  </main>;
}
