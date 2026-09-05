import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

import { resolveAnalyticsPressure } from '@/lib/integrations/analytics-pressure';
import { runMetaAnalyticsRefresh } from '@/lib/integrations/meta-analytics-refresh';
import { dispatchProfileAnalyticsRefreshJobs } from '@/lib/integrations/profile-analytics-refresh-worker';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * A coleta da Meta pega carona no worker que já está de pé.
 *
 * Este endpoint é chamado de 10 em 10 segundos por `athena-vps-profile-analytics-1`
 * desde antes desta mudança — e vinha respondendo "nada a fazer", porque a fila
 * legada que ele processa só tem trabalho para perfis da Zernio, e todos estão
 * offline desde 04/09/2026.
 *
 * Pendurar a passada da Meta aqui vale mais do que criar um worker novo, por
 * dois motivos concretos:
 *
 *   1. **Não exige deploy na VPS.** O laço, o heartbeat e o segredo já existem
 *      e já funcionam. Worker novo significaria empacotar, subir e cadastrar no
 *      PM2 — três passos manuais para chegar ao mesmo lugar.
 *
 *   2. **Muda o ciclo de trabalho, que é o gargalo real.** O cron da Vercel dá
 *      45s de trabalho a cada 5 minutos: 15% do tempo. Um worker que chama de
 *      10 em 10 segundos mantém a coleta ocupada quase o tempo todo. Com ~1.700
 *      perfis a passada completa cai de ~50 minutos para ~10.
 *
 * O cron da Vercel continua existindo como rede de segurança: com
 * `staleMinutes` alto, ele só encontra trabalho se a VPS parar.
 */

/** Perfis da Meta por chamada. Curto de propósito: o worker chama de novo já. */
const META_BATCH_LIMIT = 30;
/** Orçamento da parte da Meta, deixando o resto para a fila legada. */
const META_TIME_BUDGET_MS = 25_000;

/**
 * A coleta acontece em três horários, não continuamente.
 *
 * O worker da VPS tem folga de sobra; quem não tem é o Supabase. Projetado para
 * 5.000 perfis com metade publicando 25 posts/dia, a linha por post responde por
 * 74% de toda a escrita — e a cadência é o único parâmetro que muda isso de
 * ordem de grandeza: 255 mil escritas/dia em três rodadas contra 2,4 milhões de
 * meia em meia hora.
 *
 * Fora dos horários o despachante não coleta nada. Quem decide se há trabalho é
 * `open_meta_analytics_run` (migration 387), que também é o objeto que a tela lê
 * para mostrar o progresso no lugar do antigo botão "atualizar".
 */
const META_SLOTS = ['09:00', '15:00', '21:00'];

function integerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

async function activeDirectVpsOrganizations() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('active_profile_analytics_direct_worker_organization_ids', {
    p_stale_seconds: integerEnv('PROFILE_ANALYTICS_VPS_FALLBACK_STALE_SECONDS', 120, 30, 3600),
    p_worker_prefix: process.env.PROFILE_ANALYTICS_VPS_WORKER_PREFIX?.trim() || 'athena-vps-',
  });
  if (error) throw error;
  return Array.isArray(data) ? data.filter((value): value is string => typeof value === 'string') : [];
}

function authorized(request: Request) {
  const configuredSecrets = [
    process.env.PROFILE_ANALYTICS_REFRESH_WORKER_SECRET,
    process.env.PUBLICATION_WORKER_SECRET,
    process.env.MEDIA_DELETION_WORKER_SECRET,
    process.env.CRON_SECRET,
  ]
    .filter((value): value is string => Boolean(value));
  const suppliedValues = [
    request.headers.get('x-profile-analytics-worker-secret'),
    request.headers.get('x-publication-worker-secret'),
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, ''),
  ].filter((value): value is string => Boolean(value));

  return configuredSecrets.some((expectedSecret) => suppliedValues.some((suppliedSecret) => {
    const expected = Buffer.from(expectedSecret);
    const supplied = Buffer.from(suppliedSecret);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }));
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  const body = await request.json().catch(() => ({})) as {
    workerId?: string;
    limit?: number;
    concurrency?: number;
    leaseSeconds?: number;
    shadowEnabled?: boolean;
    shadowLimit?: number;
    shadowConcurrency?: number;
    shadowMaxConnectionLeases?: number;
    /**
     * Horários alternativos para ESTA chamada — a alavanca de "puxar agora,
     * fora de horário".
     *
     * Não é o botão que saiu da tela: aquele era público e um clique varria a
     * frota. Este exige o segredo do worker e é deliberado — serve para quando
     * a operação precisa de um número fora do ciclo (uma leva nova de perfis,
     * uma rodada perdida). Quem chama assume o custo, que é uma rodada inteira.
     */
    slots?: string[];
  };

  try {
    const admin = createSupabaseAdminClient();
    // O analytics não cede mais a fila inteira por atraso de publicação: com o
    // limiar antigo de 60s ele passava ~99,5% do tempo pausado. Ver
    // lib/integrations/analytics-pressure.ts.
    const pressureDecision = await resolveAnalyticsPressure(admin, {
      concurrency: Number.isInteger(body.concurrency) ? body.concurrency! : 10,
      limit: Number.isInteger(body.limit) ? body.limit! : 20,
    });
    if (pressureDecision.mode === 'paused') {
      return NextResponse.json({
        paused: true,
        reason: pressureDecision.reason,
        pressure: pressureDecision.pressure,
      }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
    }
    const excludedOrganizationIds = await activeDirectVpsOrganizations();
    const result = await dispatchProfileAnalyticsRefreshJobs({
      workerId: body.workerId,
      limit: pressureDecision.limit,
      concurrency: pressureDecision.concurrency,
      leaseSeconds: body.leaseSeconds,
      shadowEnabled: body.shadowEnabled,
      shadowLimit: body.shadowLimit,
      shadowConcurrency: body.shadowConcurrency,
      shadowMaxConnectionLeases: body.shadowMaxConnectionLeases,
      excludedOrganizationIds,
    });
    // A passada da Meta roda depois da fila legada, com o que sobrou do
    // orçamento. Ela é independente: falha aqui não derruba o despacho acima,
    // que é o caminho da Zernio.
    let meta: Record<string, unknown> | null = null;
    try {
      const slots = Array.isArray(body.slots) && body.slots.every((slot) => typeof slot === 'string' && /^[0-2]\d:[0-5]\d$/.test(slot))
        ? body.slots
        : META_SLOTS;
      const abertura = await admin.rpc('open_meta_analytics_run', { p_slots: slots });
      const run = abertura.data as { id?: string; started_at?: string; finished_at?: string | null; slot_label?: string } | null;

      if (!run?.id) {
        // Antes do primeiro horário do dia não existe rodada — e não coletar é
        // o comportamento certo, não uma falha.
        meta = { idle: true, reason: 'antes do primeiro horário' };
      } else if (run.finished_at) {
        meta = { idle: true, reason: `rodada das ${run.slot_label} concluída`, slot: run.slot_label };
      } else {
        // "Ainda não visitado NESTA rodada" = coletado antes de ela começar.
        //
        // O instante, e não minutos. Traduzir para "parado há N minutos" com N
        // crescendo junto com a rodada faz o perfil do minuto zero voltar à
        // fila no minuto vinte: medido em 05/09/2026, uma rodada chegou a 127%
        // e não terminava (migration 390).
        const summary = await runMetaAnalyticsRefresh({
          limit: META_BATCH_LIMIT,
          collectedBefore: run.started_at,
          days: 2,
          // Os dois juntos: a lista de mídias alimenta o card de melhores posts
          // e é de onde saem os ids para somar o dia corrente.
          collectPosts: true,
          collectToday: true,
          concurrency: pressureDecision.concurrency,
          timeBudgetMs: META_TIME_BUDGET_MS,
        });

        await admin.rpc('advance_meta_analytics_run', {
          p_run_id: run.id,
          p_processed: summary.processed,
          p_synced: summary.synced,
          p_failed: summary.failed,
          p_daily_rows: summary.dailyRowsWritten,
          p_post_rows: summary.postRowsWritten,
          p_remaining: summary.remaining,
        });

        meta = {
          slot: run.slot_label,
          processed: summary.processed,
          synced: summary.synced,
          failed: summary.failed,
          dailyRows: summary.dailyRowsWritten,
          postRows: summary.postRowsWritten,
          remaining: summary.remaining,
          appUsagePercent: summary.appUsagePercent,
          durationMs: summary.durationMs,
        };
      }
    } catch (metaError) {
      meta = { error: metaError instanceof Error ? metaError.message : 'falha na coleta da Meta' };
    }

    return NextResponse.json({
      ...result,
      meta,
      publicationPressure: {
        mode: pressureDecision.mode,
        reason: pressureDecision.reason,
        concurrency: pressureDecision.concurrency,
        limit: pressureDecision.limit,
        criticalDelaySeconds: pressureDecision.criticalDelaySeconds,
        oldestDueAt: pressureDecision.pressure?.oldestDueAt ?? null,
      },
      vpsFirst: {
        excludedOrganizationIds,
        fallbackActive: excludedOrganizationIds.length === 0,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Falha no dispatcher de analytics.' }, { status: 500 });
  }
}
