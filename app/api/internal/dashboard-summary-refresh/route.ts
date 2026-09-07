import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
// Quatro minutos, contra os 60 s do primeiro dia. Medido em 07/09/2026 com o
// pipeline de publicacao em carga: o recalculo de UMA organizacao passou de 3 s
// para 25 s, e tres delas nao cabiam mais em 60 s -- a terceira era pulada e so
// voltava no ciclo seguinte. Isto aqui e trabalho de fundo, nao requisicao de
// tela: o teto certo e o do cron (5 min), com folga para nao encavalar.
export const maxDuration = 240;

/**
 * Recalcula o resumo materializado da dashboard.
 *
 * POR QUE ESTA ROTA EXISTE. Até 07/09/2026 a dashboard abria vazia, e não por
 * falta de dado: `get_dashboard_bootstrap_v2` e `get_dashboard_analytics_summary`
 * estouravam o statement timeout — as duas, porque são a mesma consulta (o
 * bootstrap chama o resumo na primeira linha). O custo estava em agregar as
 * 265.798 publicações vivas da organização CINCO vezes por abertura de tela. A
 * migration 421 moveu essa agregação para fora do caminho da requisição, e é
 * daqui que ela é disparada.
 *
 * ELE NÃO É GATEADO POR PRESSÃO DA FILA, e isso é deliberado — mesmo motivo do
 * `/api/internal/queue-summary-refresh`: esta rota não publica nada, é uma
 * agregação de leitura, e é durante um incidente que o operador mais precisa que
 * a tela mostre a operação. Gatear aqui seria apagar a luz quando o quarto
 * escurece.
 */

/**
 * Folga contra o `maxDuration` para a resposta sempre sair.
 *
 * Abaixo do intervalo do cron (5 min) de proposito: uma invocacao nunca deve
 * ainda estar rodando quando a proxima comeca. Se a agregacao crescer a ponto
 * de encostar aqui, o sinal esta em `duration_ms` na propria tabela -- e a
 * resposta certa passa a ser reduzir a varredura, nao subir este numero de novo.
 */
const TIME_BUDGET_MS = 180_000;

/**
 * Organização recalculada há menos que isto é pulada.
 *
 * O cron desta rota é de 5 em 5 minutos — e não de minuto em minuto como o da
 * fila —, então na prática este piso só age quando alguém dispara a rota à mão
 * em cima de um ciclo automático. É o que evita duas varreduras de 265 mil
 * linhas seguidas para produzir exatamente o mesmo número.
 */
const MIN_AGE_SECONDS = 45;

function authorized(request: Request) {
  const received = request.headers.get('x-worker-secret')
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!received) return false;
  const candidates = [
    process.env.PUBLICATION_WORKER_SECRET,
    process.env.CRON_SECRET,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const receivedBuffer = Buffer.from(received);
  return candidates.some((expected) => {
    const expectedBuffer = Buffer.from(expected);
    return expectedBuffer.length === receivedBuffer.length
      && timingSafeEqual(expectedBuffer, receivedBuffer);
  });
}

async function refreshAll() {
  const startedAt = Date.now();
  const admin = createSupabaseAdminClient();

  const { data: organizations, error: organizationsError } = await admin
    .from('organizations')
    .select('id')
    // Poucas dezenas de organizações; não escala com a fila, e por isso não
    // precisa de paginação por faixa.
    .order('id', { ascending: true });
  if (organizationsError) {
    return { error: organizationsError.message, refreshed: [] as Array<Record<string, unknown>> };
  }

  const { data: snapshots, error: snapshotsError } = await admin
    .from('dashboard_summary_totals')
    .select('organization_id, computed_at, duration_ms')
    .order('organization_id', { ascending: true });
  if (snapshotsError) {
    return { error: snapshotsError.message, refreshed: [] as Array<Record<string, unknown>> };
  }

  const computedAt = new Map((snapshots ?? []).map((row) => [row.organization_id, row.computed_at]));
  const now = Date.now();

  // Mais velha primeiro: com o orçamento estourando no meio, a organização que
  // ficou de fora é a primeira do ciclo seguinte, em vez de nunca ser a vez dela.
  const pending = (organizations ?? [])
    .map((organization) => {
      const at = computedAt.get(organization.id);
      return { id: organization.id, ageMs: at ? now - Date.parse(at) : Number.POSITIVE_INFINITY };
    })
    .filter((organization) => organization.ageMs >= MIN_AGE_SECONDS * 1000)
    .sort((left, right) => right.ageMs - left.ageMs);

  const refreshed: Array<Record<string, unknown>> = [];
  let skippedForBudget = 0;

  for (const organization of pending) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      skippedForBudget += 1;
      continue;
    }
    const { data, error } = await admin.rpc('refresh_dashboard_summary', {
      p_organization_id: organization.id,
    });
    if (error) {
      console.error('Falha ao recalcular o resumo da dashboard.', {
        organizationId: organization.id,
        code: error.code,
        message: error.message,
      });
      refreshed.push({ organizationId: organization.id, error: error.message });
      continue;
    }
    refreshed.push(data as Record<string, unknown>);
  }

  return { refreshed, skippedForBudget, elapsedMs: Date.now() - startedAt };
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }
  return NextResponse.json(await refreshAll());
}

// O cron da Vercel dispara GET.
export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }
  return NextResponse.json(await refreshAll());
}
