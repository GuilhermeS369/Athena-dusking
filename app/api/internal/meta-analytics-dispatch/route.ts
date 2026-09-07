import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { resolveAnalyticsPressure } from '@/lib/integrations/analytics-pressure';
import { runMetaAnalyticsRefresh } from '@/lib/integrations/meta-analytics-refresh';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Coleta automática de métricas da Meta.
 *
 * POR QUE ISTO PODE EXISTIR AGORA. Com a Zernio, atualizar a frota significava
 * uma credencial por conta, fila com lease e controle de pressão — caro demais
 * para rodar sozinho de tempos em tempos. Com a API oficial são ~37 apps para
 * ~960 perfis e 3 chamadas por perfil por ciclo, então a frota inteira cabe em
 * poucos minutos de trabalho espalhado.
 *
 * ORÇAMENTO POR INVOCAÇÃO. Uma passada custa ao Supabase 2 leituras e até 5
 * escritas EM LOTE — não por perfil. Com o cron de 5 em 5 minutos e
 * `staleMinutes` de 30, cada perfil é coletado no máximo duas vezes por hora, o
 * que dá ~2 mil linhas reescritas por hora (sempre as MESMAS linhas: a chave é
 * perfil + dia). É ordens de grandeza abaixo da fila de publicação, que é quem
 * de fato disputa banco aqui.
 *
 * ELE NUNCA DISPUTA COM A PUBLICAÇÃO. Mesmo portão dos outros despachantes
 * internos: sob atraso crítico da fila, sai sem trabalhar. Métrica atrasada é
 * incômodo; publicação atrasada é prejuízo.
 */

/** Folga contra o `maxDuration` de 60s para a resposta sempre sair. */
const TIME_BUDGET_MS = 45_000;
/** Perfis por lote. Mais que isto e o lote não fecha dentro do orçamento. */
const BATCH_LIMIT = 60;
/** Chamadas simultâneas à Meta por lote; a pressão da fila pode reduzir. */
const DEFAULT_CONCURRENCY = 6;
/**
 * Um perfil coletado há menos que isto não entra na fila do ciclo.
 *
 * Este cron não é mais o motor: quem coleta é o worker da VPS, nos três
 * horários fixos (`open_meta_analytics_run`, migration 387). Aqui sobrou a rede
 * de segurança — se a VPS ficar horas fora do ar, este caminho ainda traz a
 * métrica, com a granularidade grossa que o intervalo permite. Ele NÃO abre
 * rodada nem escreve progresso: a tela só reflete o que a VPS fez.
 */
const DEFAULT_STALE_MINUTES = 240;

function authorized(request: Request) {
  const received = request.headers.get('x-worker-secret')
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!received) return false;
  const candidates = [
    process.env.META_ANALYTICS_WORKER_SECRET,
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

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }

  const startedAt = performance.now();
  const body = await request.json().catch(() => ({})) as {
    organizationId?: unknown;
    limit?: unknown;
    staleMinutes?: unknown;
    days?: unknown;
    collectPosts?: unknown;
    collectToday?: unknown;
    maxBatches?: unknown;
    force?: unknown;
    prune?: unknown;
  };

  const admin = createSupabaseAdminClient();

  // Reaproveita o controle de pressão do analytics em vez de inventar outro.
  //
  // Eu tinha escrito aqui um portão próprio com limiar de 60s, e ele mantinha a
  // coleta parada quase sempre: um item dois minutos atrasado — rotina numa
  // fila que despacha milhares por hora — bastava. Ao subir para 600s descobri
  // que `lib/integrations/analytics-pressure.ts` já tinha chegado ao MESMO
  // número, por medição (p99 de 572s com a fila saudável), e ainda por cima com
  // uma decisão melhor: em vez de parar, reduz a concorrência pela metade e
  // segue. Duas implementações do mesmo julgamento é uma a mais.
  const pressureDecision = await resolveAnalyticsPressure(admin, {
    concurrency: DEFAULT_CONCURRENCY,
    limit: BATCH_LIMIT,
  });
  if (pressureDecision.mode === 'paused' && body.force !== true) {
    return NextResponse.json({
      ok: true,
      paused: true,
      reason: pressureDecision.reason,
      checkedAt: new Date().toISOString(),
    }, { status: 202 });
  }

  const organizationId = typeof body.organizationId === 'string' ? body.organizationId : null;
  const limit = typeof body.limit === 'number' ? body.limit : BATCH_LIMIT;
  const staleMinutes = typeof body.staleMinutes === 'number' ? body.staleMinutes : DEFAULT_STALE_MINUTES;
  // Uma passada mais funda por hora, e curta no resto do tempo.
  //
  // O Instagram continua consolidando as métricas de um dia por cerca de 48h,
  // então revisitar só "hoje e ontem" deixaria o antepenúltimo dia congelado no
  // valor parcial que ele tinha quando passamos por ele. Coletar quatro dias
  // SEMPRE dobraria o custo por perfil e cortaria a vazão pela metade — daí a
  // divisão: de hora em hora o ciclo olha para trás, no resto do tempo ele
  // corre. Vale o mesmo para as mídias, que custam mais uma chamada.
  const deepPass = new Date().getMinutes() < 5;
  const days = typeof body.days === 'number' ? body.days : deepPass ? 4 : 2;
  const collectPosts = body.collectPosts === true || deepPass;
  // O dia corrente, e por que ele anda junto com a passada profunda.
  //
  // O balde da CONTA só fecha depois que o dia acaba no fuso dela, então "hoje"
  // nunca vem por ali — a única fonte é a soma dos insights dos posts
  // publicados hoje, que é o que `collectToday` liga. Até 07/09/2026 este
  // despacho não passava a opção, e como ele é quem roda de 5 em 5 minutos,
  // 288 das 290 passadas diárias não escreviam a linha de hoje: ela só existia
  // quando uma rodada fatiada passava.
  //
  // Amarrado ao `deepPass` e não a toda passada porque o custo é real e é por
  // post: `fetchMediaInsights` faz UMA chamada por mídia publicada hoje, por
  // perfil (o lote não existe em graph.instagram.com v26 — ver o comentário
  // dela). De hora em hora a lista de mídias já está sendo buscada de qualquer
  // forma, então o acréscimo fica restrito aos insights, e o dia corrente da
  // dashboard passa a ter no máximo uma hora de atraso em vez de depender da
  // próxima rodada fatiada.
  const collectToday = body.collectToday === true || deepPass;

  // Teto de lotes por invocação. Existe para diagnóstico — uma passada
  // controlada, do tamanho que se quer observar — e não para o cron, que roda
  // com o orçamento de tempo como único limite.
  const maxBatches = typeof body.maxBatches === 'number' ? Math.max(1, Math.trunc(body.maxBatches)) : Number.POSITIVE_INFINITY;
  const batches: Array<Record<string, unknown>> = [];
  let totals = { processed: 0, synced: 0, partial: 0, failed: 0, noData: 0, dailyRows: 0, remaining: 0 };
  let appUsagePercent: number | null = null;

  // Vários lotes por invocação enquanto couber no orçamento: é o que faz o
  // cron de cinco minutos cobrir a frota inteira em menos de uma hora.
  while (performance.now() - startedAt < TIME_BUDGET_MS && batches.length < maxBatches) {
    const elapsed = performance.now() - startedAt;
    const summary = await runMetaAnalyticsRefresh({
      organizationId,
      limit: Math.min(limit, pressureDecision.limit || limit),
      staleMinutes,
      days,
      collectPosts,
      collectToday,
      concurrency: pressureDecision.concurrency || DEFAULT_CONCURRENCY,
      timeBudgetMs: TIME_BUDGET_MS - elapsed,
    });

    batches.push({
      requested: summary.requested,
      processed: summary.processed,
      synced: summary.synced,
      partial: summary.partial,
      failed: summary.failed,
      durationMs: summary.durationMs,
    });
    totals = {
      processed: totals.processed + summary.processed,
      synced: totals.synced + summary.synced,
      partial: totals.partial + summary.partial,
      failed: totals.failed + summary.failed,
      noData: totals.noData + summary.noData,
      dailyRows: totals.dailyRows + summary.dailyRowsWritten,
      remaining: summary.remaining,
    };
    appUsagePercent = summary.appUsagePercent ?? appUsagePercent;

    if (summary.requested === 0 || summary.processed === 0) break;
  }

  // Faxina, uma vez por hora, em lotes limitados.
  //
  // Vive aqui e não num cron próprio porque já existe uma passada horária
  // (`deepPass`) e porque poda é trabalho de fundo: se um lote não couber no
  // orçamento, o próximo ciclo continua de onde parou. `has_more` é o que
  // permite drenar um passivo grande sem travar a tabela — em 05/09/2026 eram
  // 64.113 linhas de perfil removido esperando.
  let faxina: Record<string, unknown> | null = null;
  if (deepPass || body.prune === true) {
    try {
      const [removidos, antigos, payloadsMortos] = await Promise.all([
        admin.rpc('purge_removed_profile_post_analytics', { p_limit: 5000 }),
        admin.rpc('prune_profile_post_analytics', { p_retention_days: 90, p_limit: 5000 }),
        // Arquivo de payload das classes que ninguem le. A coleta Meta nao
        // escreve payload (decisao no topo de lib/integrations/meta-analytics.ts),
        // entao isto e rastro da coleta Zernio, encerrada em 03/09: 96.797 linhas
        // de 42 KB de media. `current` fica — e a unica classe com leitor, a tela
        // de detalhe do perfil. Lote menor que os vizinhos porque cada linha aqui
        // pesa 40x mais que uma linha de metrica.
        admin.rpc('purge_profile_analytics_payload_archives', {
          p_source_classes: ['posts', 'daily'],
          p_retention_days: 0,
          p_limit: 1000,
        }),
      ]);
      faxina = {
        perfisRemovidos: (removidos.data as Array<{ deleted_count: number; has_more: boolean }> | null)?.[0] ?? removidos.error?.message,
        retencao90d: (antigos.data as Array<{ deleted_count: number; has_more: boolean }> | null)?.[0] ?? antigos.error?.message,
        payloadsMortos: (payloadsMortos.data as Array<{ deleted_count: number; has_more: boolean }> | null)?.[0] ?? payloadsMortos.error?.message,
      };
    } catch (pruneError) {
      faxina = { error: pruneError instanceof Error ? pruneError.message : 'falha na faxina' };
    }
  }

  const response = {
    ok: true,
    done: totals.remaining === 0,
    faxina,
    ...totals,
    batches: batches.length,
    appUsagePercent,
    durationMs: Math.round(performance.now() - startedAt),
    checkedAt: new Date().toISOString(),
  };
  console.info('meta_analytics_dispatch', response);
  return NextResponse.json(response, { status: response.done ? 200 : 202 });
}

// O cron da Vercel manda GET; o cron da VPS manda POST. Mesma rota.
export async function GET(request: Request) {
  return POST(request);
}
