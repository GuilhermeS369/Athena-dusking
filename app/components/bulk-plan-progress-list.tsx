'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { describeBulkPlanAttention, type BulkPlanAttention } from '@/lib/bulk-plan-attention';
import { bulkPlanCount as count, groupOfBulkPlan as groupOf, type BulkPlanGroup } from '@/lib/publications/bulk-plan-grouping';

import styles from './bulk-plan-progress-list.module.css';

export type BulkPlanProgress = {
  planId: string;
  batchId: string;
  name: string;
  status: string;
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
  attention: BulkPlanAttention | null;
  firstExecuteAt: string | null;
  lastExecuteAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByEmail: string | null;
};

export const activeBulkPlanStatuses = new Set(['queued', 'generating', 'paused']);

const listLimit = 20;
// Com o horizonte de 48h removido (migration 328) um plano é gerado em segundos
// ou minutos, então o painel precisa de um ciclo curto para o usuário ver o
// progresso acontecer. Só é seguro porque a rota deixou de embutir todos os
// chunks: a consulta agora é barata.
const activePollIntervalMs = 3000;
const idlePollIntervalMs = 20_000;
const visibleFinishedPlans = 5;

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

export function BulkPlanProgressFeed({ location, refreshSignal = 0 }: { location: 'postagem' | 'queue'; refreshSignal?: number }) {
  const [plans, setPlans] = useState<BulkPlanProgress[]>([]);
  const [loaded, setLoaded] = useState(false);

  // `refreshSignal` sobe quando alguém confirma uma programação nesta página.
  // Sem isso o lote recém-criado só aparecia depois de um F5, porque este efeito
  // não tinha nenhuma dependência e nada externo o acordava.
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
          if (nextPlans.some((plan) => {
            const group = groupOf(plan);
            return group === 'waiting' || group === 'running';
          })) nextDelay = activePollIntervalMs;
        }
        setLoaded(true);
      } catch {
        if (active) setLoaded(true);
      } finally {
        // Sempre reagenda. Antes, o próximo ciclo só era criado se o payload
        // trouxesse um plano ativo — então uma página aberta sem nada gerando
        // congelava o painel para sempre.
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

function AttentionNote({ plan }: { plan: BulkPlanProgress }) {
  if (!plan.attention) return null;
  return (
    <aside className={styles.attention} aria-label={`Aviso sobre a programação ${plan.name}`}>
      <strong>{activeBulkPlanStatuses.has(plan.status) ? 'Atenção na programação' : 'Programação incompleta'}</strong>
      <p>{describeBulkPlanAttention(plan.attention, plan.format, plan.generatedPublications, plan.status)}</p>
    </aside>
  );
}

function PlanIdentity({ plan }: { plan: BulkPlanProgress }) {
  return (
    <div className={styles.identity}>
      <h3>{plan.name}</h3>
      <small>{integer(plan.profileCount)} perfis · {plan.format === 'reel' ? 'Reels' : plan.format === 'story' ? 'Stories' : 'Imagens'} · por {plan.createdByEmail ?? 'membro da organização'}</small>
    </div>
  );
}

function WaitingCard({ plan }: { plan: BulkPlanProgress }) {
  return (
    <article className={`${styles.card} ${styles.waitingCard}`}>
      <header>
        <PlanIdentity plan={plan} />
        <span className={styles.waitingBadge}>Na fila</span>
      </header>
      <p className={styles.cardLine}>
        Aguardando o gerador começar · <strong>0 de {integer(plan.expectedPublications)}</strong> publicações
      </p>
      <AttentionNote plan={plan} />
    </article>
  );
}

function RunningCard({ plan }: { plan: BulkPlanProgress }) {
  const progress = percent(plan);
  return (
    <article className={`${styles.card} ${styles.runningCard}`}>
      <header>
        <PlanIdentity plan={plan} />
        <strong className={styles.percent}>{progress.toLocaleString('pt-BR')}%</strong>
      </header>
      <div className={styles.track} aria-label={`Progresso de ${plan.name}: ${progress}%`}>
        <span style={{ width: `${Math.min(100, progress)}%` }} />
      </div>
      <p className={styles.cardLine}>
        <strong>{integer(plan.generatedPublications)} de {integer(plan.expectedPublications)}</strong> publicações criadas
        {count(plan.ignoredPublications) > 0 && <> · {integer(plan.ignoredPublications)} ignoradas</>}
      </p>
      <AttentionNote plan={plan} />
    </article>
  );
}

function FinishedRow({ plan }: { plan: BulkPlanProgress }) {
  return (
    <article className={`${styles.card} ${styles.finishedCard}`}>
      <header>
        <PlanIdentity plan={plan} />
        <span className={styles.finishedBadge}>{plan.attention ? 'Concluído com avisos' : 'Concluído'}</span>
      </header>
      <p className={styles.cardLine}>
        <strong>{integer(plan.generatedPublications)}</strong> publicações na fila · até {formatDate(plan.lastExecuteAt)}
      </p>
      <AttentionNote plan={plan} />
    </article>
  );
}

function AttentionCard({ plan }: { plan: BulkPlanProgress }) {
  return (
    <article className={`${styles.card} ${styles.attentionCard}`}>
      <header>
        <PlanIdentity plan={plan} />
        <span className={styles.attentionBadge}>{plan.status === 'paused' ? 'Pausado' : 'Falhou'}</span>
      </header>
      <p className={styles.cardLine}>
        <strong>{integer(plan.generatedPublications)} de {integer(plan.expectedPublications)}</strong> publicações criadas antes de parar
      </p>
      <AttentionNote plan={plan} />
    </article>
  );
}

function Group({ title, hint, children, tone }: { title: string; hint: string; children: React.ReactNode; tone: BulkPlanGroup }) {
  return (
    <section className={`${styles.group} ${styles[`${tone}Group`]}`} aria-label={title}>
      <header className={styles.groupHeader}>
        <h3>{title}</h3>
        <p>{hint}</p>
      </header>
      <div className={styles.list}>{children}</div>
    </section>
  );
}

export default function BulkPlanProgressList({ plans, location }: { plans: BulkPlanProgress[]; location: 'postagem' | 'queue' }) {
  const waiting = plans.filter((plan) => groupOf(plan) === 'waiting');
  const running = plans.filter((plan) => groupOf(plan) === 'running');
  const attention = plans.filter((plan) => groupOf(plan) === 'attention');
  const finished = plans.filter((plan) => groupOf(plan) === 'finished');
  if (!waiting.length && !running.length && !attention.length && !finished.length) return null;

  const hiddenFinished = Math.max(0, finished.length - visibleFinishedPlans);

  return (
    <section className={`${styles.section} ${location === 'postagem' ? styles.postingSection : ''}`} aria-labelledby={`bulk-progress-${location}`}>
      <header className={styles.header}>
        <div>
          <span className="section-kicker">Programação em massa</span>
          <h2 id={`bulk-progress-${location}`}>Acompanhamento da geração</h2>
          <p>Cada programação confirmada entra numa fila e vira publicações agendadas. Esta área atualiza sozinha.</p>
        </div>
        {location === 'queue' && <Link href="/postagem" prefetch={false}>Nova programação</Link>}
      </header>

      {waiting.length > 0 && (
        <Group tone="waiting" title={`Na fila para começar · ${waiting.length}`} hint="Confirmadas e aguardando o gerador. Nenhuma publicação foi criada ainda.">
          {waiting.map((plan) => <WaitingCard key={plan.planId} plan={plan} />)}
        </Group>
      )}

      {running.length > 0 && (
        <Group tone="running" title={`Gerando agora · ${running.length}`} hint="As publicações estão sendo criadas neste momento.">
          {running.map((plan) => <RunningCard key={plan.planId} plan={plan} />)}
        </Group>
      )}

      {attention.length > 0 && (
        <Group tone="attention" title={`Precisa de atenção · ${attention.length}`} hint="A geração parou antes de terminar. Verifique os perfis envolvidos.">
          {attention.map((plan) => <AttentionCard key={plan.planId} plan={plan} />)}
        </Group>
      )}

      {finished.length > 0 && (
        <Group tone="finished" title={`Concluídas · ${finished.length}`} hint="Já viraram publicações agendadas na fila de publicação.">
          {finished.slice(0, visibleFinishedPlans).map((plan) => <FinishedRow key={plan.planId} plan={plan} />)}
          {hiddenFinished > 0 && <p className={styles.overflowNote}>e mais {hiddenFinished} programação(ões) concluída(s) recentemente.</p>}
        </Group>
      )}
    </section>
  );
}
