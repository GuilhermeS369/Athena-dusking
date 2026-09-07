#!/usr/bin/env node

/**
 * Recalcula o resumo materializado da fila de publicacao (migration 418).
 *
 * POR QUE ISTO E UM PROCESSO PROPRIO, e nao mais uma etapa do publicador.
 *
 * Ate 07/09/2026 este recalculo rodava DENTRO de
 * `dispatchPublicationQueueDirect`, no mesmo laco que publica. Medido naquele
 * dia, sob carga real:
 *
 *   itens: 38, cicloMs: 56382
 *   fasesMs: { resumoDaFila: 17453, processarItens: 35165, ... }
 *
 * Um terco do ciclo de despacho gasto agregando linhas para a TELA, enquanto
 * ~800 publicacoes venciam no mesmo minuto e 3.023 morriam no corte de atraso
 * sem NUNCA terem sido reivindicadas (`attempt_count = 0` em 3.023 de 3.024).
 * Tres defeitos de arquitetura ali:
 *
 *   1. LEITURA DENTRO DE ESCRITA. Publicar tem prazo de 5 minutos; a tela
 *      tolera 1 minuto de defasagem. Prazos diferentes no mesmo laco fazem o
 *      rigoroso pagar a conta do relaxado.
 *
 *   2. REALIMENTACAO POSITIVA. O custo e O(tamanho da fila), e a fila cresce
 *      justamente quando a publicacao esta atrasada -- entao quanto pior a
 *      situacao, mais caro fica o resumo e mais tempo ele rouba de quem
 *      deveria resolve-la. Componente que encarece conforme o hospedeiro
 *      piora e a pior forma de acoplamento que existe.
 *
 *   3. MULTIPLICACAO NA ESCALA. Ao subir de 1 para 4 publicadores, o recalculo
 *      passou a rodar 4 vezes, agregando o mesmo milhao de linhas. Trabalho de
 *      manutencao nao pode escalar junto com o numero de publicadores.
 *
 * O padrao correto ja existia no repositorio: media-maintenance,
 * profile-analytics e zernio-sync sao processos proprios. Este entra no mesmo
 * lugar.
 *
 * SOBRE O CRON DA VERCEL. `/api/internal/queue-summary-refresh` continua
 * agendado a cada minuto no vercel.json, e nao ha conflito: este worker so
 * recalcula o que esta VELHO, entao quando o cron chega primeiro este aqui nao
 * faz nada, e vice-versa. A redundancia e de proposito -- o cron cobre a queda
 * da VPS, o worker cobre o painel nao implantado, que foi a preocupacao
 * original de quem pos isso no publicador.
 */

import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const args = new Set(process.argv.slice(2));
const runOnce = args.has('--once') || process.env.QUEUE_SUMMARY_WORKER_ONCE === 'true';
const workerId = process.env.QUEUE_SUMMARY_WORKER_ID || `queue-summary-${os.hostname()}-${process.pid}`;
// Com que frequencia ACORDA. A checagem de validade e uma leitura de uma linha
// por organizacao, entao acordar de 20 em 20 s custa quase nada e faz o resumo
// ficar pronto logo depois de vencer, em vez de esperar um ciclo inteiro.
const pollIntervalMs = integerEnv('QUEUE_SUMMARY_WORKER_POLL_INTERVAL_MS', 20_000, 5_000, 300_000);
// Idade a partir da qual o resumo e considerado velho. A tela consulta no
// maximo 1x/min, entao 60 s e o alvo natural: menor que isso e recalcular a
// toa, maior e mostrar numero atrasado.
const frescorSegundos = integerEnv('QUEUE_SUMMARY_MAX_AGE_SECONDS', 60, 20, 3600);
const historyHours = integerEnv('QUEUE_SUMMARY_HISTORY_HOURS', 24, 1, 168);
// Acima disto o recalculo de UMA organizacao vira aviso: a agregacao esta
// perdendo para o crescimento da fila e a saida deixa de ser esperar. Medido em
// 07/09: 28,9 s para 541 mil itens. 45 s da folga sem esconder a degradacao.
const alertaMs = integerEnv('QUEUE_SUMMARY_SLOW_ALERT_MS', 45_000, 5_000, 300_000);

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
 * Organizacoes cujo resumo ja passou da validade.
 *
 * Le `computed_at` da tabela de totais em vez de recalcular sempre: e o que faz
 * a coexistencia com o cron da Vercel ser gratuita. Organizacao sem linha
 * nenhuma entra na lista -- e o primeiro calculo dela.
 */
async function organizacoesVencidas(supabase) {
  const { data: organizations, error } = await supabase
    .from('organizations')
    .select('id,name')
    .order('id', { ascending: true });
  if (error) throw error;

  const { data: totals, error: totalsError } = await supabase
    .from('publication_queue_summary_totals')
    .select('organization_id,computed_at,duration_ms')
    .order('organization_id', { ascending: true });
  if (totalsError) throw totalsError;

  const calculadoEm = new Map((totals ?? []).map((row) => [row.organization_id, row]));
  const limite = Date.now() - frescorSegundos * 1000;
  return (organizations ?? [])
    .map((organization) => ({ organization, atual: calculadoEm.get(organization.id) ?? null }))
    .filter(({ atual }) => !atual?.computed_at || new Date(atual.computed_at).getTime() < limite);
}

async function ciclo(supabase) {
  const vencidas = await organizacoesVencidas(supabase);
  if (vencidas.length === 0) return { recalculadas: 0, falhas: 0 };

  let recalculadas = 0;
  let falhas = 0;
  // UMA de cada vez, de proposito. Duas agregacoes de ~30 s em paralelo sobre
  // `publication_items` disputam a mesma tabela quente que o publicador esta
  // reivindicando. Serializar aqui custa alguns segundos de defasagem na tela e
  // devolve previsibilidade ao caminho que publica.
  for (const { organization } of vencidas) {
    if (stopping) break;
    const iniciou = Date.now();
    const { error } = await supabase.rpc('refresh_publication_queue_summary', {
      p_organization_id: organization.id,
      p_history_hours: historyHours,
    });
    const duracaoMs = Date.now() - iniciou;
    if (error) {
      // Resumo e leitura: falhar aqui nunca pode derrubar o processo, so avisar.
      falhas += 1;
      console.error('[queue-summary-worker] falha ao recalcular', {
        organizationId: organization.id,
        nome: organization.name,
        message: error.message,
        code: error.code,
      });
      continue;
    }
    recalculadas += 1;
    if (duracaoMs >= alertaMs) {
      console.error('[queue-summary-worker] recalculo LENTO', {
        organizationId: organization.id,
        nome: organization.name,
        duracaoMs,
        alertaMs,
        significado: 'a agregacao esta perdendo para o crescimento da fila; ver docs/resumo-da-fila-worker-proprio.md',
      });
    } else {
      console.info('[queue-summary-worker] resumo atualizado', {
        organizationId: organization.id,
        nome: organization.name,
        duracaoMs,
      });
    }
  }
  return { recalculadas, falhas };
}

async function main() {
  const supabase = createSupabase();
  console.info('[queue-summary-worker] iniciando', {
    workerId, runOnce, pollIntervalMs, frescorSegundos, historyHours, alertaMs,
  });

  do {
    try {
      const resultado = await ciclo(supabase);
      if (resultado.recalculadas > 0 || resultado.falhas > 0) {
        console.info('[queue-summary-worker] ciclo concluído', { workerId, ...resultado });
      }
    } catch (error) {
      console.error('[queue-summary-worker] ciclo falhou', { workerId, message: error?.message });
    }
    if (runOnce || stopping) break;
    await sleep(pollIntervalMs);
  } while (!stopping);

  console.info('[queue-summary-worker] encerrado', { workerId });
}

main().catch((error) => {
  console.error('[queue-summary-worker] erro fatal', { message: error?.message });
  process.exitCode = 1;
});
