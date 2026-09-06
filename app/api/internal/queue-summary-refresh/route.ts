import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Recalcula o resumo materializado da fila de publicação.
 *
 * POR QUE ESTA ROTA EXISTE. Até 06/09/2026 a tela `/queue` agregava ~105 mil
 * linhas de `publication_items` a cada leitura, para produzir quinze números e
 * algumas dezenas de linhas de agrupamento. Custava dez segundos e crescia
 * junto com a fila — a migration 418 moveu essa agregação para fora do caminho
 * da requisição, e é daqui que ela é disparada. Medido depois da mudança: a
 * leitura da tela caiu de 8.941 ms para 125 ms.
 *
 * ELE NÃO É GATEADO POR PRESSÃO DA FILA, e isso é deliberado — os outros
 * despachantes internos saem sem trabalhar sob atraso crítico, porque gastam
 * capacidade de publicação. Este não publica nada: é uma agregação de leitura.
 * E é exatamente durante um incidente que o operador mais precisa que a tela
 * mostre a fila. Gatear aqui seria apagar a luz quando o quarto escurece.
 */

/** Folga contra o `maxDuration` de 60 s para a resposta sempre sair. */
const TIME_BUDGET_MS = 45_000;

/**
 * Organização recalculada há menos que isto é pulada. O cron roda de minuto em
 * minuto e a tela consulta no máximo 1×/min, então recalcular de novo aos 10
 * segundos só gastaria banco para produzir o mesmo número.
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
    .from('publication_queue_summary_totals')
    .select('organization_id, computed_at, duration_ms')
    .order('organization_id', { ascending: true });
  if (snapshotsError) {
    return { error: snapshotsError.message, refreshed: [] as Array<Record<string, unknown>> };
  }

  const computedAt = new Map((snapshots ?? []).map((row) => [row.organization_id, row.computed_at]));
  const now = Date.now();

  // Mais velho primeiro: com o orçamento estourando no meio, a organização que
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
    const { data, error } = await admin.rpc('refresh_publication_queue_summary', {
      p_organization_id: organization.id,
      p_history_hours: 24,
    });
    if (error) {
      console.error('Falha ao recalcular o resumo da fila.', {
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
