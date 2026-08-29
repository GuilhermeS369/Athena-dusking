'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { describeBulkPlanAttention, type BulkPlanAttention } from '@/lib/bulk-plan-attention';

import styles from './bulk-plan-progress-list.module.css';

export type BulkPlanProgress = {
  planId: string;
  batchId: string;
  name: string;
  status: string;
  operationalStatus: string;
  eligibleChunks: number;
  format: 'image' | 'reel' | 'story';
  profileCount: string;
  mediaCount: string;
  slotsPerProfile: string;
  expectedPublications: string;
  generatedPublications: string;
  suspendedPublications: string;
  ignoredPublications: string;
  failedPublications: string;
  expectedChunks: string;
  chunks: Record<'queued' | 'processing' | 'paused' | 'completed' | 'failed' | 'cancelled', string>;
  attention: BulkPlanAttention | null;
  firstExecuteAt: string | null;
  lastExecuteAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByEmail: string | null;
};

export const activeBulkPlanStatuses = new Set(['queued', 'generating', 'paused']);
const listLimit = 20;
const activePollIntervalMs = 4000;
const idlePollIntervalMs = 60_000;
const operationalStatusLabels: Record<string, string> = {
  queued: 'Aguardando geração',
  generating: 'Gerando',
  paused: 'Pausado',
  completed: 'Concluído',
  completed_with_errors: 'Concluído com avisos',
  failed: 'Falhou',
  cancelled: 'Cancelado',
};

// `refreshSignal` sobe de quem confirma uma programação: sem isso o lote
// recém-criado só aparecia depois de um F5, porque este efeito não tinha
// nenhuma dependência e nada externo o acordava.
export function BulkPlanProgressFeed({ location, refreshSignal = 0 }: { location: 'postagem' | 'queue'; refreshSignal?: number }) {
  const [plans, setPlans] = useState<BulkPlanProgress[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: number | null = null;
    const refresh = async () => {
      let nextDelay = idlePollIntervalMs;
      try {
        const response = await fetch(`/api/bulk-publications?limit=${listLimit}`, { cache: 'no-store' });
        const payload = await response.json() as { plans?: BulkPlanProgress[] };
        if (!active) return;
        if (response.ok) {
          const nextPlans = payload.plans ?? [];
          setPlans(nextPlans);
          if (nextPlans.some((plan) => activeBulkPlanStatuses.has(plan.status))) nextDelay = activePollIntervalMs;
        }
        setLoaded(true);
      } catch {
        if (active) setLoaded(true);
      } finally {
        // Sempre reagenda. Antes, o próximo ciclo só era criado se o payload
        // trouxesse um plano ativo — então uma página aberta sem nenhum plano
        // em geração congelava o feed para sempre.
        if (active) timer = window.setTimeout(() => void refresh(), nextDelay);
      }
    };
    void refresh();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [refreshSignal]);

  return loaded ? <BulkPlanProgressList plans={plans} location={location} /> : null;
}

function integer(value: string) {
  try {
    return BigInt(value).toLocaleString('pt-BR');
  } catch {
    return '0';
  }
}

function percent(plan: BulkPlanProgress) {
  try {
    const expected = BigInt(plan.expectedPublications);
    if (expected === BigInt(0)) return 0;
    const handled = BigInt(plan.generatedPublications) + BigInt(plan.ignoredPublications) + BigInt(plan.failedPublications);
    return Number((handled * BigInt(10000)) / expected) / 100;
  } catch {
    return 0;
  }
}

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value));
}

export default function BulkPlanProgressList({ plans, location }: { plans: BulkPlanProgress[]; location: 'postagem' | 'queue' }) {
  if (!plans.length) return null;
  return (
    <section className={`${styles.section} ${location === 'postagem' ? styles.postingSection : ''}`} aria-labelledby={`bulk-progress-${location}`}>
      {location === 'queue' && <header className={styles.header}>
        <div><span className="section-kicker">Programação em massa</span><h2 id={`bulk-progress-${location}`}>Acompanhamento da organização</h2><p>Todos os membros veem estes planos e o progresso da geração, mesmo após sair da tela.</p></div>
      </header>}
      {location === 'postagem' && <h2 className={styles.srOnly} id={`bulk-progress-${location}`}>Acompanhamento das programações em massa</h2>}
      <div className={styles.list}>
        {plans.map((plan) => {
          const progress = percent(plan);
          const active = activeBulkPlanStatuses.has(plan.status);
          const statusLabel = operationalStatusLabels[plan.operationalStatus] ?? plan.operationalStatus.replaceAll('_', ' ');
          return <article className={styles.card} key={plan.planId}>
            <header><div><span className={`${styles.status} ${active ? styles.active : ''}`}>{statusLabel}</span><h3>{plan.name}</h3><small>Por {plan.createdByEmail ?? 'membro da organização'} · atualizado {formatDate(plan.updatedAt)}</small></div><strong>{progress.toLocaleString('pt-BR')}%</strong></header>
            <div className={styles.track} aria-label={`Progresso de ${plan.name}: ${progress}%`}><span style={{ width: `${Math.min(100, progress)}%` }} /></div>
            <dl>
              <div><dt>Geradas</dt><dd>{integer(plan.generatedPublications)} / {integer(plan.expectedPublications)}</dd></div>
              <div><dt>Perfis</dt><dd>{integer(plan.profileCount)}</dd></div>
              <div><dt>Chunks</dt><dd>{integer(plan.chunks.completed)} / {integer(plan.expectedChunks)}</dd></div>
              <div><dt>Falhas</dt><dd>{integer(plan.failedPublications)}</dd></div>
              <div><dt>Primeira execução</dt><dd>{formatDate(plan.firstExecuteAt)}</dd></div>
              <div><dt>Última execução</dt><dd>{formatDate(plan.lastExecuteAt)}</dd></div>
            </dl>
            {plan.attention && <aside className={styles.attention} aria-label={`Aviso sobre a programação ${plan.name}`}>
              <strong>{active ? 'Atenção na programação' : 'Programação incompleta'}</strong>
              <p>{describeBulkPlanAttention(plan.attention, plan.format, plan.generatedPublications, plan.status)}</p>
            </aside>}
            <footer><span>{active
              ? 'Atualização automática enquanto a geração estiver ativa.'
              : 'Geração finalizada; os itens permanecem na fila operacional.'}</span>{location === 'queue' && <Link href="/postagem" prefetch={false}>Ver programação</Link>}</footer>
          </article>;
        })}
      </div>
    </section>
  );
}
