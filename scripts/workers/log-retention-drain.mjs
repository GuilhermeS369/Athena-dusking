#!/usr/bin/env node

/**
 * Dreno de retencao dos logs — o passivo, nao o regime.
 *
 * POR QUE EXISTE. A retencao roda em lotes de 500 linhas por chamada, o que
 * segura o regime (~200 mil linhas/dia) mas nao drena um passivo. Em 05/09/2026
 * o passivo era de ~2 milhoes de linhas espalhadas por oito tabelas, acumuladas
 * desde 22/08 porque:
 *
 *   - a janela de retencao era 14 dias travada no corpo da funcao (a 401 abriu);
 *   - quatro tabelas nao tinham fonte de retencao nenhuma (a 401 criou);
 *   - `posts` e `daily` do arquivo de payload nao tinham poda (a 402 criou).
 *
 * Este script chama as mesmas funcoes que o cron chama, em laco, ate `hasMore`
 * virar falso. Depois dele, o cron de 5 minutos da conta sozinho.
 *
 * O FREIO E O MESMO DA ROTA: antes de cada rodada ele le
 * `get_publication_generation_pressure_signal`. Se a fila estiver com atraso
 * critico, ele para — poda nunca disputa I/O com publicacao. Rodar de novo
 * depois continua de onde parou; nao existe estado a recuperar.
 *
 *   npm run worker:log-retention:once            # drena tudo
 *   npm run worker:log-retention:once -- --dry-run
 *   node scripts/workers/log-retention-drain.mjs --budget-ms=300000
 */

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const budgetMs = numericArg('--budget-ms', 900_000, 10_000, 3_600_000);
const retentionDays = numericArg('--retention-days', 7, 5, 30);
const batchSize = numericArg('--batch-size', 500, 100, 5000);

const supabaseUrl = requiredEnv('NEXT_PUBLIC_SUPABASE_URL');
const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// A ordem e deliberada: primeiro o que devolve disco de verdade.
//
// `partitions` faz `drop table` da particao diaria inteira — o unico caminho
// aqui que devolve arquivo ao sistema operacional na hora. Todo o resto e
// `delete`, que libera espaco para reuso do Postgres mas nao encolhe o arquivo
// (para encolher, so `vacuum full`/`pg_repack`, fora deste script).
const HOT_SOURCES = [
  'partitions',
  'boundary_events',
  'default_events',
  'incident_entities',
  'incident_actions',
  'event_rollups',
  'worker_rollups',
  'resolved_incidents',
];

const LEGACY_SOURCES = [
  'publication_events',
  'media_delivery_attempts',
  'analytics_step_events',
  'analytics_item_events',
  'batch_terminal_outcomes',
  'request_rollups',
  'worker_cycles',
  'sync_logs',
  'request_anomalies',
];

// Classes mortas do arquivo de payload: escritas pela coleta Zernio ate 03/09,
// lidas por ninguem (so `current` tem leitor — a tela de detalhe do perfil).
const DEAD_PAYLOAD_CLASSES = ['posts', 'daily'];

const startedAt = Date.now();
const totals = new Map();

async function main() {
  if (dryRun) {
    console.log('[dry-run] nada sera apagado. Fontes que seriam drenadas:');
    console.log('  quentes:', HOT_SOURCES.join(', '));
    console.log('  legadas:', LEGACY_SOURCES.join(', '));
    console.log('  payload:', DEAD_PAYLOAD_CLASSES.join(', '));
    console.log(`  janela: ${retentionDays} dias | lote: ${batchSize} | orcamento: ${budgetMs}ms`);
    return;
  }

  for (const source of HOT_SOURCES) {
    await drain(source, () => supabase.rpc('maintain_instagram_observability_hot_source', {
      p_source: source,
      p_retention_days: retentionDays,
      p_batch_size: batchSize,
    }), (data) => ({ affected: data?.affected ?? 0, hasMore: data?.hasMore === true }));
  }

  for (const source of LEGACY_SOURCES) {
    await drain(source, () => supabase.rpc('maintain_instagram_legacy_log_retention_source', {
      p_source: source,
      p_retention_days: retentionDays,
      p_batch_size: batchSize,
    }), (data) => ({ affected: data?.deleted ?? 0, hasMore: data?.hasMore === true }));
  }

  await drain('payload_archives', () => supabase.rpc('purge_profile_analytics_payload_archives', {
    p_source_classes: DEAD_PAYLOAD_CLASSES,
    p_retention_days: 0,
    p_limit: Math.min(batchSize, 1000),
  }), (data) => {
    const row = Array.isArray(data) ? data[0] : data;
    return { affected: row?.deleted_count ?? 0, hasMore: row?.has_more === true };
  });

  const removed = [...totals.entries()].filter(([, count]) => count > 0);
  console.log('\n--- resumo ---');
  if (!removed.length) console.log('nada a remover: as fontes ja estavam dentro da janela.');
  for (const [source, count] of removed.sort((a, b) => b[1] - a[1])) {
    console.log(String(count).padStart(10), source);
  }
  console.log(`total ${[...totals.values()].reduce((a, b) => a + b, 0)} linhas em ${Math.round((Date.now() - startedAt) / 1000)}s`);
  console.log('\nEspaco de tabela particionada volta na hora (drop de particao).');
  console.log('O resto vira espaco reutilizavel; o arquivo so encolhe com vacuum full.');
}

/** Chama a fonte em laco ate `hasMore` virar falso, o orcamento acabar, ou a fila pedir passagem. */
async function drain(source, call, read) {
  let removed = 0;
  let rounds = 0;
  for (;;) {
    if (Date.now() - startedAt > budgetMs) {
      console.log(`[${source}] orcamento esgotado com ${removed} removidas; rode de novo para continuar.`);
      break;
    }
    if (!(await queueIsCalm())) {
      console.log(`[${source}] fila com atraso critico: parando com ${removed} removidas.`);
      break;
    }

    const { data, error } = await call();
    if (error) {
      console.error(`[${source}] erro: ${error.message}`);
      break;
    }
    const { affected, hasMore } = read(data);
    removed += Number(affected) || 0;
    rounds += 1;
    if (rounds % 20 === 0) console.log(`[${source}] ${removed} removidas...`);
    if (!hasMore) break;
  }
  totals.set(source, removed);
  if (removed > 0) console.log(`[${source}] ${removed} removidas em ${rounds} lotes.`);
}

/**
 * O mesmo sinal que a rota de manutencao consulta. Falha de leitura devolve
 * `true` de proposito: um sinal indisponivel nao pode parar a faxina para
 * sempre, e o lote seguinte e pequeno o bastante para nao machucar.
 */
async function queueIsCalm() {
  const { data, error } = await supabase.rpc('get_publication_generation_pressure_signal', {
    p_critical_delay_seconds: 60,
  });
  if (error) return true;
  return data?.criticalDelay !== true;
}

function numericArg(flag, fallback, min, max) {
  const raw = args.find((item) => item.startsWith(`${flag}=`));
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw.slice(flag.length + 1), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variavel de ambiente ausente: ${name}`);
  return value;
}

function loadEnvFile(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key]) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
