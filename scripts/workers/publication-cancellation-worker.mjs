#!/usr/bin/env node

/**
 * Drena a fila de cancelamento da fila de publicação (migration 428).
 *
 * POR QUE EXISTE. Cancelar um grupo grande e feito em blocos de 1.500 itens
 * (um por chamada, para caber no statement_timeout do banco). Ate 14/09/2026 so
 * a aba do navegador avancava esses blocos, com um poll de 3 s que conhecia UMA
 * operacao: clicar em outro grupo, ou fechar a aba, abandonava a anterior no
 * meio (Pomodoro, 14/09: 2.146 itens ativos sobrando com 9.000 cancelados).
 *
 * Este processo e o motor principal: a cada tick le as operacoes `running`, a
 * parada ha mais tempo primeiro, e avanca UMA etapa de cada uma, em serie. O
 * navegador continua como reserva e so avanca operacao sem progresso ha mais
 * de 15 s; a RPC devolve `busy` a quem chegar enquanto a outra ponta esta no
 * meio de um bloco, entao os dois nunca duplicam trabalho.
 *
 * SERIAL DE PROPOSITO. Um bloco e um UPDATE de 1.500 linhas em publication_items
 * (com ~20 indices para manter) mais os deletes de reserva e o log de eventos.
 * Dois desses em paralelo disputam a mesma tabela quente que os publicadores
 * estao reivindicando. Uma etapa por vez, com orcamento por tick, e o teto de
 * carga que este processo pode impor ao banco.
 *
 * Quando uma operacao conclui, invalida o resumo materializado da organizacao
 * para o queue-summary-worker recalcular no proximo tick; a tela para de
 * mostrar a linha como "Na fila" e passa a "Cancelada".
 */

import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const args = new Set(process.argv.slice(2));
const runOnce = args.has('--once') || process.env.PUBLICATION_CANCELLATION_WORKER_ONCE === 'true';
const workerId = process.env.PUBLICATION_CANCELLATION_WORKER_ID || `publication-cancellation-${os.hostname()}-${process.pid}`;
// Com que frequencia acorda. Uma leitura de poucas linhas por tick; 10 s deixa
// um grupo de 11 mil itens terminar em ~1,5 min sem martelar o banco.
const pollIntervalMs = integerEnv('PUBLICATION_CANCELLATION_WORKER_POLL_INTERVAL_MS', 10_000, 3_000, 300_000);
// Orcamento de um tick. Cada etapa custa ate ~8 s (statement_timeout); 45 s da
// cinco ou seis etapas por tick e nunca deixa o processo preso num tick longo.
const tickBudgetMs = integerEnv('PUBLICATION_CANCELLATION_WORKER_TICK_BUDGET_MS', 45_000, 5_000, 300_000);
// Quantas operacoes `running` ler por tick. Cresce com cliques, nao com a fila.
const maxOperations = integerEnv('PUBLICATION_CANCELLATION_WORKER_MAX_OPERATIONS', 20, 1, 100);

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

function integerEnv(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (process.env[key]) continue;
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSupabase() {
  return createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Operacoes em execucao, a parada ha mais tempo primeiro (indice parcial
 * `..._running_drain_idx`). Ordenacao total por (updated_at, id); o limite fica
 * muito abaixo do teto do PostgREST.
 */
async function operacoesEmExecucao(supabase) {
  const { data, error } = await supabase
    .from('publication_queue_cancellation_operations')
    .select('id, organization_id, scope, target_id, target_label, progress, result, created_at, updated_at')
    .eq('status', 'running')
    .order('updated_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(maxOperations);
  if (error) throw error;
  return data ?? [];
}

async function invalidarResumo(supabase, organizationId) {
  const { error } = await supabase.rpc('invalidate_publication_queue_summary', { p_organization_id: organizationId });
  if (error) {
    console.error('[publication-cancellation-worker] falha ao invalidar o resumo', { organizationId, message: error.message, code: error.code });
  }
}

async function ciclo(supabase) {
  const operacoes = await operacoesEmExecucao(supabase);
  if (operacoes.length === 0) return { etapas: 0, concluidas: 0, ocupadas: 0, falhas: 0, adiadas: 0 };

  const iniciouTick = Date.now();
  let etapas = 0;
  let concluidas = 0;
  let ocupadas = 0;
  let falhas = 0;
  let adiadas = 0;

  // UMA etapa de UMA operacao por vez. Ver o cabecalho.
  for (const op of operacoes) {
    if (stopping) break;
    if (Date.now() - iniciouTick > tickBudgetMs) {
      adiadas += 1;
      continue;
    }
    const iniciou = Date.now();
    const { data, error } = await supabase.rpc('execute_server_publication_queue_cancellation', { p_operation_id: op.id });
    const duracaoMs = Date.now() - iniciou;
    if (error) {
      // Um bloco que estourou o tempo ou perdeu a rede volta no proximo tick;
      // nunca derruba o processo.
      falhas += 1;
      console.error('[publication-cancellation-worker] etapa falhou', {
        operationId: op.id, organizationId: op.organization_id, scope: op.scope, target: op.target_label ?? op.target_id,
        code: error.code, message: error.message, duracaoMs,
      });
      continue;
    }
    const resultado = data ?? {};
    if (resultado.state === 'busy') {
      ocupadas += 1;
      continue;
    }
    etapas += 1;
    const concluiu = resultado.state === 'cancelled' || resultado.operationStatus === 'completed' || resultado.state === 'failed';
    console.info('[publication-cancellation-worker] etapa', {
      operationId: op.id, organizationId: op.organization_id, scope: op.scope, target: op.target_label ?? op.target_id,
      state: resultado.state ?? resultado.operationStatus ?? null,
      progress: resultado.progress ?? null,
      cancelledSoFar: resultado.cancelledSoFar ?? resultado.cancelledItems ?? null,
      remainingCancelableItems: resultado.remainingCancelableItems ?? null,
      inFlightItems: resultado.inFlightItems ?? null,
      duracaoMs,
    });
    if (concluiu) {
      concluidas += 1;
      await invalidarResumo(supabase, op.organization_id);
    }
  }
  return { etapas, concluidas, ocupadas, falhas, adiadas };
}

async function main() {
  const supabase = createSupabase();
  console.info('[publication-cancellation-worker] iniciando', { workerId, runOnce, pollIntervalMs, tickBudgetMs, maxOperations });

  do {
    try {
      const resultado = await ciclo(supabase);
      if (resultado.etapas > 0 || resultado.falhas > 0 || resultado.adiadas > 0) {
        console.info('[publication-cancellation-worker] ciclo concluído', { workerId, ...resultado });
      }
    } catch (error) {
      console.error('[publication-cancellation-worker] ciclo falhou', { workerId, message: error?.message });
    }
    if (runOnce || stopping) break;
    await sleep(pollIntervalMs);
  } while (!stopping);

  console.info('[publication-cancellation-worker] encerrado', { workerId });
}

main().catch((error) => {
  console.error('[publication-cancellation-worker] erro fatal', { message: error?.message });
  process.exitCode = 1;
});
