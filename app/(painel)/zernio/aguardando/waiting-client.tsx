'use client';

import { useEffect, useState } from 'react';

export default function ZernioOauthWaitingClient({ turnId, returnTo }: { turnId: string; returnTo: string }) {
  const [position, setPosition] = useState<number | null>(null);
  const [message, setMessage] = useState('Sua solicitação está protegida. Aguarde esta tela avançar automaticamente.');
  const [connectionError, setConnectionError] = useState(false);

  useEffect(() => {
    if (!turnId) {
      setMessage('Este turno não é válido. Volte para Perfis e inicie somente a conexão faltante.');
      return;
    }
    let cancelled = false; let timer = 0; let failures = 0;
    const schedule = (delay: number) => { if (!cancelled) timer = window.setTimeout(poll, delay); };
    const poll = async () => {
      if (cancelled) return;
      try {
        const response = await fetch(`/api/integrations/zernio/turn-status?turnId=${encodeURIComponent(turnId)}`, { cache: 'no-store' });
        const payload = await response.json() as { status?: string; position?: number; error?: string };
        if (cancelled) return;
        if (!response.ok) throw new Error(payload.error ?? 'A fila não pôde ser consultada.');
        failures = 0;
        setConnectionError(false);
        setPosition(payload.position ?? null);
        if (payload.status === 'active') {
          window.location.assign(`/api/integrations/zernio/continue?turnId=${encodeURIComponent(turnId)}&returnTo=${encodeURIComponent(returnTo)}`);
          return;
        }
        if (['failed', 'expired', 'completed'].includes(payload.status ?? '')) {
          window.location.assign(`${returnTo}?error=zernio_intent_failed`);
          return;
        }
        schedule(1500);
      } catch (error) {
        // Sem o guard de `cancelled` e sem limpar o timer no cleanup, esta ramificação
        // seguia consultando indefinidamente após o unmount enquanto o fetch falhasse.
        if (cancelled) return;
        failures += 1;
        setConnectionError(true);
        setMessage(error instanceof Error ? error.message : 'A fila não pôde ser consultada.');
        schedule(Math.min(30_000, 3000 * 2 ** Math.min(failures - 1, 3)));
      }
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [returnTo, turnId]);

  return <main className="zernio-mobile-flow">
    <section className="zernio-mobile-card" aria-live="polite">
      <div className="zernio-mobile-orbit" aria-hidden="true"><span /></div>
      <span className="zernio-mobile-kicker">Conexão segura</span>
      <h1>{connectionError ? 'Reconectando à fila…' : 'Aguarde a sua vez'}</h1>
      <p className="zernio-mobile-lead">{message}</p>
      {position !== null && <div className="zernio-mobile-position" role="status"><span>Posição atual</span><strong>{position}</strong></div>}
      <div className="zernio-mobile-progress"><i /></div>
      <p className="zernio-mobile-note"><strong>Mantenha esta tela aberta.</strong> Quando chegar sua vez, o Instagram abrirá sozinho. Nenhuma solicitação duplicada será criada.</p>
    </section>
  </main>;
}
