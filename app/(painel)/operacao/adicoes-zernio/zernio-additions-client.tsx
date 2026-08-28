'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type ZernioAddition = {
  id: string;
  correlationId: string;
  status: 'not_ready' | 'pending' | 'processing' | 'completed' | 'conflict' | 'failed';
  attemptStatus: string;
  attemptCount: number;
  connectionLabel: string | null;
  syncedCount: number;
  errorCode: string | null;
  errorStage: string | null;
  errorMessage: string | null;
  results: Array<{ zernioAccountId: string; username: string; profileId: string | null; status: string; reason: string | null }>;
  createdAt: string;
  callbackReceivedAt: string | null;
  completedAt: string | null;
};

function formatDate(value: string | null) {
  if (!value) return 'Ainda não concluído';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function additionLabel(status: ZernioAddition['status']) {
  if (status === 'completed') return 'Adicionado';
  if (status === 'conflict') return 'Conflito';
  if (status === 'failed') return 'Falhou';
  if (status === 'processing') return 'Verificando na VPS';
  if (status === 'pending') return 'Solicitação enviada';
  return 'Aguardando autorização';
}

export default function ZernioAdditionsClient({ organizationName }: { organizationName: string }) {
  const [additions, setAdditions] = useState<ZernioAddition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadAdditions() {
      try {
        const response = await fetch('/api/integrations/zernio/additions', { cache: 'no-store' });
        const payload = await response.json().catch(() => ({})) as { additions?: ZernioAddition[]; error?: string };
        if (cancelled) return;
        if (!response.ok) {
          setError(payload.error ?? 'Não foi possível carregar o histórico de adições Zernio.');
          return;
        }
        setAdditions(payload.additions ?? []);
        setError('');
      } catch {
        if (!cancelled) setError('Não foi possível conectar ao servidor.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadAdditions();
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void loadAdditions(); }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return <main className="standalone-page operation-page">
    <header className="standalone-header operation-hero">
      <div>
        <span className="section-kicker">{organizationName} · Status / Logs</span>
        <h1>Histórico de adições Zernio</h1>
        <p>Resultados atualizados automaticamente pela VPS. Conflitos e erros aparecem sem executar “Sincronizar contas”.</p>
      </div>
      <div className="operation-header-actions">
        <Link className="button button-secondary" href="/operacao">Voltar à operação</Link>
        <Link className="button button-secondary" href="/perfis">Perfis</Link>
      </div>
    </header>

    {error && <p className="inline-message operation-notice" role="alert">{error}</p>}

    <section className="panel operation-events-panel" aria-label="Histórico de adições Zernio">
      <div className="panel-heading">
        <div><span className="section-kicker">Processamento independente</span><h2>Adições recentes</h2><p>A página atualiza automaticamente a cada quatro segundos.</p></div>
        <span className="queue-count">{additions.length}</span>
      </div>
      <div className="operation-list operation-issue-list">
        {loading ? <div className="operation-empty"><strong>Carregando histórico…</strong></div> : additions.length === 0 ? <div className="operation-empty"><strong>Nenhuma adição registrada</strong><p>As próximas solicitações de adição Zernio aparecerão aqui.</p></div> : additions.map((addition) => (
          <article className={`operation-row ${addition.status === 'conflict' || addition.status === 'failed' ? 'operation-row-warning' : 'operation-row-info'}`} key={addition.id}>
            <span className={`status-dot status-dot-${addition.status === 'conflict' || addition.status === 'failed' ? 'warning' : addition.status === 'completed' ? 'positive' : 'neutral'}`} />
            <div>
              <strong>{additionLabel(addition.status)} · {addition.connectionLabel ?? 'Chave Zernio'}</strong>
              <small>{formatDate(addition.createdAt)} · ID {addition.correlationId} · Tentativa {addition.attemptCount}</small>
              {addition.results.map((result) => <p key={`${addition.id}-${result.zernioAccountId}`}><strong>@{result.username}</strong> · {result.status}{result.reason ? ` — ${result.reason}` : ''} · accountId {result.zernioAccountId}</p>)}
              {addition.errorMessage && <details><summary>Erro detalhado</summary><pre className="connection-diagnostic">{[`etapa=${addition.errorStage ?? 'desconhecida'}`, `codigo=${addition.errorCode ?? 'unknown_error'}`, `mensagem=${addition.errorMessage}`].join('\n')}</pre></details>}
            </div>
          </article>
        ))}
      </div>
    </section>
  </main>;
}
