'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type AdditionState = {
  phase: 'pending' | 'processing' | 'recovery_paused' | 'completed' | 'failed';
  message: string;
  syncedCount: number;
  groupName: string | null;
  correlationId: string;
  errorCode: string | null;
  queuePosition: number;
  connectionId?: string | null;
  zernioProfileId?: string | null;
  recovery?: {
    deadlineAt: string | null;
    nextAttemptAt: string | null;
    observationCount: number;
    canResume: boolean;
  };
};

export default function ZernioAdditionCompletionClient({ attemptId, returnTo }: { attemptId: string; returnTo: string }) {
  const [state, setState] = useState<AdditionState>({
    phase: 'pending', message: 'Preparando a confirmação final…', syncedCount: 0,
    groupName: null, correlationId: attemptId, errorCode: null, queuePosition: 0,
  });
  const [resuming, setResuming] = useState(false);
  const [recoveryRun, setRecoveryRun] = useState(0);

  useEffect(() => {
    if (!attemptId) {
      setState((current) => ({ ...current, phase: 'failed', message: 'Esta tentativa não é válida.' }));
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/integrations/zernio/addition-status?attemptId=${encodeURIComponent(attemptId)}`, { cache: 'no-store' });
        const payload = await response.json() as AdditionState & { error?: string };
        if (cancelled) return;
        if (!response.ok) throw new Error(payload.error ?? 'Não foi possível consultar a confirmação.');
        setState(payload);
        if (!['completed', 'failed', 'recovery_paused'].includes(payload.phase)) timer = window.setTimeout(poll, 1500);
      } catch (error) {
        if (cancelled) return;
        setState((current) => ({ ...current, message: error instanceof Error ? error.message : 'Reconectando ao servidor…' }));
        timer = window.setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [attemptId, recoveryRun]);

  const done = state.phase === 'completed';
  const failed = state.phase === 'failed';
  const paused = state.phase === 'recovery_paused';
  const recoveryDeadline = state.recovery?.deadlineAt
    ? new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short' }).format(new Date(state.recovery.deadlineAt))
    : null;

  async function resumeRecovery() {
    if (resuming) return;
    setResuming(true);
    try {
      const response = await fetch('/api/integrations/zernio/resume-recovery', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attemptId }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Não foi possível retomar a confirmação.');
      setState((current) => ({
        ...current,
        phase: 'pending',
        message: 'Recuperação reiniciada. Consultando a Zernio sem abrir outro OAuth…',
        errorCode: null,
      }));
      setRecoveryRun((current) => current + 1);
    } catch (error) {
      setState((current) => ({
        ...current,
        message: error instanceof Error ? error.message : 'Não foi possível retomar a confirmação.',
      }));
    } finally {
      setResuming(false);
    }
  }

  return <main className={`zernio-mobile-flow ${done ? 'is-success' : failed ? 'is-failure' : ''}`}>
    <section className="zernio-mobile-card" aria-live="polite">
      <div className={`zernio-mobile-orbit ${done ? 'is-check' : failed ? 'is-error' : paused ? 'is-error' : ''}`} aria-hidden="true"><span>{done ? '✓' : failed || paused ? '!' : ''}</span></div>
      <span className="zernio-mobile-kicker">Atena + Zernio</span>
      <h1>{done ? 'Tudo concluído!' : failed ? 'Não foi possível concluir' : paused ? 'Confirmação pausada' : state.phase === 'processing' ? 'Confirmando sua conta' : 'Autorização recebida'}</h1>
      <p className="zernio-mobile-lead">{state.message}</p>
      {!done && !failed && !paused && <><div className="zernio-mobile-progress"><i /></div><p className="zernio-mobile-note"><strong>{state.phase === 'processing' ? 'Processamento final em andamento.' : `Aguardando a etapa final${state.queuePosition > 0 ? ` — posição ${state.queuePosition}` : ''}.`}</strong> A autorização no Instagram já terminou. A confirmação continua no servidor, então você pode fechar este celular sem interromper a conta, a chave ou o grupo.{recoveryDeadline ? ` A confirmação automática tenta até ${recoveryDeadline}.` : ''}</p></>}
      {done && <div className="zernio-mobile-success" role="status">
        <strong>Conexão confirmada</strong>
        <p>{state.syncedCount} conta adicionada ao Atena{state.groupName ? ` e vinculada ao grupo “${state.groupName}”` : ''}.</p>
        <p>Agora você pode fechar este celular.</p>
      </div>}
      {failed && <div className="zernio-mobile-failure" role="alert"><strong>Nenhuma confirmação falsa foi registrada. Você pode fechar este celular.</strong><p>{state.errorCode ? `Código: ${state.errorCode}` : 'A solicitação pode ser tentada novamente com segurança após corrigir o motivo informado pela Zernio.'}</p></div>}
      {paused && <div className="zernio-mobile-failure" role="status"><strong>A conta não foi confirmada nem duplicada.</strong><p>Isso pode ocorrer quando a proxy do aparelho cai ou a Zernio demora a propagar a autorização. Retomar consulta o mesmo profile isolado e não abre outro Instagram.</p>{state.recovery?.canResume && <button className="button button-primary zernio-mobile-action" type="button" onClick={resumeRecovery} disabled={resuming}>{resuming ? 'Retomando confirmação…' : 'Retomar confirmação'}</button>}</div>}
      {(done || failed || paused) && <Link className="button button-secondary zernio-mobile-action" href={returnTo}>{done ? 'Fechar e voltar' : 'Voltar para Perfis'}</Link>}
      <small className="zernio-mobile-id">ID {state.correlationId || attemptId}</small>
      {state.zernioProfileId && <small className="zernio-mobile-id">Profile Zernio {state.zernioProfileId}</small>}
    </section>
  </main>;
}
