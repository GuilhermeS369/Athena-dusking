#!/usr/bin/env node

/**
 * Worker de variantes de video por post (migration 436). Roda SO na VPS de
 * variantes (`ssh athena-variantes`), nunca na VPS dos publicadores.
 *
 * POR QUE EXISTE. O mesmo arquivo de Reel sobe dezenas de vezes por dia em
 * perfis diferentes. Plano em massa com a opcao ligada gera, para cada post, uma
 * linha em publication_item_video_variants; este processo transforma cada linha
 * num arquivo unico no R2 ANTES de a preparacao do item rodar (antecedencia de
 * 30 h contra a janela de 24 h da preparacao). As receitas e a prova de
 * unicidade estao em video-variant-recipes.mjs.
 *
 * O QUE ESTE PROCESSO NUNCA FAZ:
 *   - Nao publica, nao fala com a Meta, nao le token de perfil.
 *   - Nao chama o claim dos publicadores nem varre a tabela de itens: so as RPCs
 *     da tabela lateral. No maximo 2 chamadas de banco ao mesmo tempo (semaforo).
 *   - Nao sobe arquivo fatiado: UM PutObject por variante. Multipart custaria
 *     ~5 operacoes classe A por arquivo no R2 (~US$ 29/mes em vez de ~US$ 2).
 *   - Nao para sozinho por causa da franquia de banda: parar viraria post
 *     perdido (decisao do dono: variante ausente NAO posta o arquivo cru). Avisa
 *     no heartbeat em 60% e 80%.
 *
 * DISCO. Os originais ficam em cache (todos os ~2.200 de hoje somam 26 GB), com
 * descarte do menos usado quando passa do teto. Cada variante e montada num
 * diretorio temporario proprio, apagado no `finally`.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  buildKeyframeProbeArgs,
  buildVariantSteps,
  buildFfprobeArgs,
  drawVideoVariantParams,
  isVideoVariantRecipe,
  parseKeyframes,
  recipeNeedsKeyframes,
  resolveVariantParams,
  summarizeSourceProbe,
  validateVariantProbe,
  withoutMidFreeze,
} from './video-variant-recipes.mjs';

const run = promisify(execFile);
const LOG = '[video-variant-worker]';

// ---------------------------------------------------------------------------
// Pecas puras (exportadas para o teste; nao tocam em rede, banco nem disco)
// ---------------------------------------------------------------------------

/** Limita quantas tarefas assincronas rodam ao mesmo tempo. */
export function createSemaphore(limit) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };
  return async function withPermit(task) {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

export async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Caminho do objeto no bucket de variantes. O id do item torna o caminho unico
 * por post; o pedaco da marca evita que uma nova tentativa sobrescreva um objeto
 * que um publicador ja esteja entregando a Meta. O dia (UTC do post) so existe
 * para quem olha o bucket.
 */
export function variantStoragePath({ organizationId, itemId, executeAt, tagUuid }) {
  const day = new Date(executeAt).toISOString().slice(0, 10);
  return `${organizationId}/variants/${day}/${itemId}-${String(tagUuid).slice(0, 12)}.mp4`;
}

/** Quais arquivos do cache descartar (menos usados primeiro) para voltar ao teto. */
export function planCacheEviction(entries, maxBytes, protectedKeys = new Set()) {
  let total = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const evict = [];
  for (const entry of [...entries].sort((a, b) => a.lastUsedAt - b.lastUsedAt)) {
    if (total <= maxBytes) break;
    if (protectedKeys.has(entry.key)) continue;
    evict.push(entry.key);
    total -= entry.sizeBytes;
  }
  return evict;
}

/** 'ok' | 'warning' (>= 60%) | 'critical' (>= 80%) da franquia mensal de banda. */
export function bandwidthAlertLevel(monthBytes, quotaBytes) {
  if (!(quotaBytes > 0)) return 'ok';
  const ratio = monthBytes / quotaBytes;
  if (ratio >= 0.8) return 'critical';
  if (ratio >= 0.6) return 'warning';
  return 'ok';
}

/** Soma bytes no contador do dia e do mes (UTC), zerando na virada. */
export function addBandwidth(state, bytes, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const next = { ...state };
  if (next.day !== day) { next.day = day; next.dayBytes = 0; }
  if (next.month !== month) { next.month = month; next.monthBytes = 0; }
  next.dayBytes = (next.dayBytes || 0) + bytes;
  next.monthBytes = (next.monthBytes || 0) + bytes;
  return next;
}

/**
 * Traduz um erro em { code, terminal, retrySeconds }. Terminal = o defeito e do
 * arquivo de origem, insistir so gasta nucleo; o resto recua e tenta de novo.
 */
export function classifyVariantError(error, attemptCount = 1) {
  const code = String(error?.variantCode || error?.code || error?.name || 'video_variant_unexpected_error');
  const terminalCodes = new Set([
    'video_variant_source_missing',
    'video_variant_source_without_video',
    'video_variant_source_unsupported',
    'video_variant_recipe_unknown',
  ]);
  const terminal = terminalCodes.has(code);
  // 30 s, 60 s, 2 min, 4 min ... ate 15 min. A variante tem ate 30 h de folga.
  const retrySeconds = Math.min(900, 30 * 2 ** Math.max(0, attemptCount - 1));
  return { code: code.slice(0, 120), terminal, retrySeconds };
}

function variantError(code, message) {
  const error = new Error(message || code);
  error.variantCode = code;
  return error;
}

// ---------------------------------------------------------------------------
// Configuracao e clientes (so quando roda como processo)
// ---------------------------------------------------------------------------

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

function readConfig() {
  const cpuCount = Math.max(1, os.cpus().length);
  return {
    runOnce: process.argv.includes('--once') || process.env.VIDEO_VARIANT_WORKER_ONCE === 'true',
    workerId: process.env.VIDEO_VARIANT_WORKER_ID || `video-variant-${os.hostname()}-${process.pid}`,
    pollIntervalMs: integerEnv('VIDEO_VARIANT_WORKER_POLL_INTERVAL_MS', 5_000, 1_000, 300_000),
    idleIntervalMs: integerEnv('VIDEO_VARIANT_WORKER_IDLE_INTERVAL_MS', 20_000, 1_000, 300_000),
    claimLimit: integerEnv('VIDEO_VARIANT_WORKER_CLAIM_LIMIT', 30, 1, 200),
    leaseSeconds: integerEnv('VIDEO_VARIANT_WORKER_LEASE_SECONDS', 300, 30, 1_800),
    // Maior que a janela de 24 h da preparacao: no caso normal a variante ja
    // existe quando o item e preparado, e nenhuma escrita extra cai na tabela quente.
    leadHours: integerEnv('VIDEO_VARIANT_WORKER_LEAD_HOURS', 30, 1, 168),
    // `micro` quase nao usa nucleo (video copiado); o limite existe para a `light`.
    ffmpegConcurrency: integerEnv('VIDEO_VARIANT_WORKER_FFMPEG_CONCURRENCY', cpuCount, 1, 8),
    ffmpegTimeoutMs: integerEnv('VIDEO_VARIANT_WORKER_FFMPEG_TIMEOUT_MS', 180_000, 10_000, 900_000),
    // Teto de conexoes do pool do Supabase que este processo pode ocupar.
    databaseConcurrency: integerEnv('VIDEO_VARIANT_WORKER_DB_CONCURRENCY', 2, 1, 4),
    cacheDirectory: process.env.VIDEO_VARIANT_WORKER_CACHE_DIR || '/var/cache/athena-variants',
    cacheMaxBytes: integerEnv('VIDEO_VARIANT_WORKER_CACHE_MAX_GB', 60, 1, 1_000) * 1024 ** 3,
    gcIntervalMs: integerEnv('VIDEO_VARIANT_WORKER_GC_INTERVAL_MS', 60_000, 10_000, 3_600_000),
    gcLimit: integerEnv('VIDEO_VARIANT_WORKER_GC_LIMIT', 200, 1, 1_000),
    gcGraceMinutes: integerEnv('VIDEO_VARIANT_WORKER_GC_GRACE_MINUTES', 60, 5, 10_080),
    heartbeatIntervalMs: integerEnv('VIDEO_VARIANT_WORKER_HEARTBEAT_INTERVAL_MS', 60_000, 5_000, 300_000),
    bandwidthQuotaBytes: integerEnv('VIDEO_VARIANT_WORKER_BANDWIDTH_QUOTA_TB', 16, 0, 1_000) * 1000 ** 4,
    sourceBucket: process.env.R2_BUCKET_INSTAGRAM_MEDIA || 'instagram-media',
    variantBucket: process.env.R2_BUCKET_INSTAGRAM_VARIANTS || '',
  };
}

async function createR2Client() {
  const { S3Client } = await import('@aws-sdk/client-s3');
  return new S3Client({
    region: 'auto',
    endpoint: requiredEnv('R2_ENDPOINT'),
    credentials: {
      accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
    },
  });
}

async function createSupabase() {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Cache dos originais em disco
// ---------------------------------------------------------------------------

function createSourceCache({ config, r2, bandwidth }) {
  const entries = new Map(); // assetId -> { key, filePath, sizeBytes, lastUsedAt }
  const inFlight = new Map(); // assetId -> Promise
  const inUse = new Map(); // assetId -> contagem de variantes lendo o arquivo agora

  fs.mkdirSync(config.cacheDirectory, { recursive: true });
  for (const name of fs.readdirSync(config.cacheDirectory)) {
    const filePath = path.join(config.cacheDirectory, name);
    if (name.endsWith('.partial')) { fs.rmSync(filePath, { force: true }); continue; }
    if (!name.endsWith('.src')) continue;
    const stat = fs.statSync(filePath);
    entries.set(name.slice(0, -4), { key: name.slice(0, -4), filePath, sizeBytes: stat.size, lastUsedAt: stat.mtimeMs });
  }

  async function download(assetId, storagePath) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const filePath = path.join(config.cacheDirectory, `${assetId}.src`);
    const partialPath = `${filePath}.${process.pid}.partial`;
    let response;
    try {
      response = await r2.send(new GetObjectCommand({ Bucket: config.sourceBucket, Key: storagePath }));
    } catch (error) {
      if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
        throw variantError('video_variant_source_missing', `Original ausente no R2: ${storagePath}`);
      }
      throw error;
    }
    try {
      await pipeline(response.Body, fs.createWriteStream(partialPath));
      fs.renameSync(partialPath, filePath);
    } finally {
      fs.rmSync(partialPath, { force: true });
    }
    const sizeBytes = fs.statSync(filePath).size;
    bandwidth.add(sizeBytes);
    entries.set(assetId, { key: assetId, filePath, sizeBytes, lastUsedAt: Date.now() });
    for (const key of planCacheEviction([...entries.values()], config.cacheMaxBytes, new Set([...inUse.keys(), assetId]))) {
      fs.rmSync(entries.get(key).filePath, { force: true });
      entries.delete(key);
    }
    return filePath;
  }

  return {
    /** Devolve o caminho local do original e o segura contra descarte ate `release`. */
    async acquire(assetId, storagePath) {
      inUse.set(assetId, (inUse.get(assetId) || 0) + 1);
      try {
        const cached = entries.get(assetId);
        if (cached && fs.existsSync(cached.filePath)) {
          cached.lastUsedAt = Date.now();
          return cached.filePath;
        }
        if (!inFlight.has(assetId)) {
          inFlight.set(assetId, download(assetId, storagePath).finally(() => inFlight.delete(assetId)));
        }
        return await inFlight.get(assetId);
      } catch (error) {
        this.release(assetId);
        throw error;
      }
    },
    release(assetId) {
      const count = (inUse.get(assetId) || 1) - 1;
      if (count <= 0) inUse.delete(assetId); else inUse.set(assetId, count);
    },
    stats() {
      let bytes = 0;
      for (const entry of entries.values()) bytes += entry.sizeBytes;
      return { files: entries.size, bytes };
    },
  };
}

function createBandwidthMeter(config) {
  const statePath = path.join(config.cacheDirectory, 'bandwidth.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { state = {}; }
  let dirty = false;
  let lastLevel = 'ok';
  return {
    add(bytes) {
      state = addBandwidth(state, bytes);
      dirty = true;
      const level = bandwidthAlertLevel(state.monthBytes, config.bandwidthQuotaBytes);
      if (level !== lastLevel) {
        lastLevel = level;
        if (level !== 'ok') {
          console.warn(`${LOG} franquia de banda em nivel ${level}`, {
            monthBytes: state.monthBytes, quotaBytes: config.bandwidthQuotaBytes,
          });
        }
      }
    },
    flush() {
      if (!dirty) return;
      try {
        fs.mkdirSync(config.cacheDirectory, { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(state));
        dirty = false;
      } catch (error) {
        console.error(`${LOG} falha ao gravar o contador de banda`, { message: error.message });
      }
    },
    snapshot() {
      const current = addBandwidth(state, 0);
      return {
        dayBytes: current.dayBytes || 0,
        monthBytes: current.monthBytes || 0,
        level: bandwidthAlertLevel(current.monthBytes || 0, config.bandwidthQuotaBytes),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Uma variante
// ---------------------------------------------------------------------------

async function probeFile(filePath) {
  const { stdout } = await run('ffprobe', buildFfprobeArgs(filePath), { maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function countVideoPackets(filePath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-count_packets', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', filePath,
  ]);
  return Number(stdout.trim());
}

// A primeira metade do corte (bookend_mid) nao tem o tamanho esperado: o divisor
// cortou em outro quadro-chave. Nao e erro do arquivo; a variante sai sem o meio.
class MidCutMismatch extends Error {}

async function runVariantSteps(steps, config) {
  for (const step of steps) {
    if (step.kind === 'file') {
      fs.writeFileSync(step.path, step.content);
      continue;
    }
    if (step.kind === 'expect_frames') {
      const frames = fs.existsSync(step.path) ? await countVideoPackets(step.path) : -1;
      if (frames !== step.frames) throw new MidCutMismatch(`primeira metade com ${frames} quadros, esperado ${step.frames}`);
      continue;
    }
    try {
      await run('ffmpeg', step.args, { timeout: config.ffmpegTimeoutMs, maxBuffer: 8 * 1024 * 1024 });
    } catch (error) {
      throw variantError('video_variant_ffmpeg_failed', String(error.stderr || error.message).slice(-600));
    }
  }
}

async function processVariant(context, variant) {
  const { config, database, r2, cache, bandwidth, probeCache, counters } = context;
  const itemId = variant.publication_item_id;
  const assetId = variant.source_media_asset_id;
  const started = Date.now();
  let acquired = false;
  let workDirectory = null;
  try {
    if (!isVideoVariantRecipe(variant.recipe)) throw variantError('video_variant_recipe_unknown', variant.recipe);
    if (!variant.source_storage_path) {
      throw variantError('video_variant_source_missing', 'Mídia de origem sem caminho de armazenamento.');
    }
    const sourcePath = await cache.acquire(assetId, variant.source_storage_path);
    acquired = true;

    let source = probeCache.get(assetId);
    if (!source) {
      try {
        source = summarizeSourceProbe(await probeFile(sourcePath));
      } catch (error) {
        throw variantError('video_variant_source_without_video', error.message);
      }
      probeCache.set(assetId, source);
    }
    if (recipeNeedsKeyframes(variant.recipe) && !source.keyframes) {
      // Lista de pacotes, sem decodificar: ~0,2 s para 45 s de video. Fica no cache
      // junto do resumo, porque o mesmo original gera muitas variantes.
      try {
        const { stdout } = await run('ffprobe', buildKeyframeProbeArgs(sourcePath), { maxBuffer: 32 * 1024 * 1024 });
        source = { ...source, keyframes: parseKeyframes(stdout) };
      } catch {
        source = { ...source, keyframes: [] };
      }
      probeCache.set(assetId, source);
    }

    workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-variant-'));
    const { PutObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');

    // Ate tres sorteios: o indice unico de bytes (436) recusa saida repetida.
    // Com 122 bits de marca isso so acontece por defeito, e o log acusa.
    for (let draw = 1; draw <= 3; draw += 1) {
      let params = resolveVariantParams(drawVideoVariantParams(variant.recipe), source);
      const outputPath = path.join(workDirectory, `variant-${draw}.mp4`);
      const drawDirectory = path.join(workDirectory, `draw-${draw}`);
      const buildSteps = () => {
        fs.rmSync(drawDirectory, { recursive: true, force: true });
        fs.mkdirSync(drawDirectory, { recursive: true });
        try {
          return buildVariantSteps({ params, source, inputPath: sourcePath, outputPath, workDir: drawDirectory });
        } catch (error) {
          throw variantError(error.message === 'video_variant_source_unsupported' ? 'video_variant_source_unsupported' : 'video_variant_recipe_unknown', error.message);
        }
      };
      const encodeStarted = Date.now();
      try {
        await runVariantSteps(buildSteps(), config);
      } catch (error) {
        if (!(error instanceof MidCutMismatch)) throw error;
        // O divisor cortou em outro quadro-chave: refaz sem o congelado do meio (a
        // variante continua valida e unica; so perde o meio). O motivo fica gravado.
        console.error(`${LOG} corte do meio divergiu; variante sai sem o meio`, { itemId, assetId, message: error.message });
        params = withoutMidFreeze(params, 'corte_divergiu');
        await runVariantSteps(buildSteps(), config);
      }
      const encodeMs = Date.now() - encodeStarted;
      const problem = validateVariantProbe({ source, output: await probeFile(outputPath), params });
      if (problem) throw variantError(problem, `Saída inválida (${variant.recipe}).`);

      // Buffer, nao stream: o maior original tem 52 MB, e com Buffer o SDK manda
      // o corpo inteiro com Content-Length num PutObject so (sem fatiar).
      const body = fs.readFileSync(outputPath);
      const checksum = createHash('sha256').update(body).digest('hex');
      const storagePath = variantStoragePath({
        organizationId: variant.organization_id, itemId, executeAt: variant.execute_at, tagUuid: params.tag_uuid,
      });
      await r2.send(new PutObjectCommand({
        Bucket: config.variantBucket, Key: storagePath, Body: body,
        ContentLength: body.length, ContentType: 'video/mp4',
      }));
      bandwidth.add(body.length);

      const { data, error } = await database((supabase) => supabase.rpc('complete_publication_video_variant', {
        p_item_id: itemId,
        p_worker_id: config.workerId,
        p_storage_path: storagePath,
        p_size_bytes: body.length,
        p_checksum_sha256: checksum,
        p_recipe_params: params,
        p_encode_ms: encodeMs,
      }));
      const discard = () => r2.send(new DeleteObjectCommand({ Bucket: config.variantBucket, Key: storagePath }))
        .catch((deleteError) => console.error(`${LOG} falha ao apagar objeto descartado`, { storagePath, message: deleteError.message }));

      if (error?.code === '23505') {
        counters.collisions += 1;
        console.error(`${LOG} COLISAO DE BYTES: duas variantes iguais do mesmo arquivo`, { itemId, assetId, checksum, draw });
        await discard();
        continue;
      }
      if (error) {
        await discard();
        throw error;
      }
      if (data?.status === 'stale') {
        // Outro processo levou a linha enquanto o ffmpeg rodava.
        counters.stale += 1;
        await discard();
        return;
      }
      counters.ready += 1;
      counters.encodeMsTotal += encodeMs;
      counters.bytesUploaded += body.length;
      if (data?.releasedPreparation) counters.releasedPreparation += 1;
      return;
    }
    throw variantError('video_variant_checksum_collision', 'Três sorteios seguidos deram bytes repetidos.');
  } catch (error) {
    counters.failed += 1;
    const verdict = classifyVariantError(error, variant.attempt_count);
    console.error(`${LOG} variante falhou`, {
      itemId, assetId, recipe: variant.recipe, code: verdict.code, terminal: verdict.terminal,
      attempt: variant.attempt_count, message: String(error?.message || error).slice(0, 400),
    });
    const { error: failError } = await database((supabase) => supabase.rpc('fail_publication_video_variant', {
      p_item_id: itemId,
      p_worker_id: config.workerId,
      p_error_code: verdict.code,
      p_error_message: String(error?.message || error).slice(0, 1200),
      p_retry_seconds: verdict.retrySeconds,
      p_terminal: verdict.terminal,
    })).catch((rpcError) => ({ error: rpcError }));
    // Sem conseguir registrar, o lease expira e a linha volta sozinha.
    if (failError) console.error(`${LOG} falha ao registrar a falha`, { itemId, message: failError.message });
  } finally {
    if (acquired) cache.release(assetId);
    if (workDirectory) fs.rmSync(workDirectory, { recursive: true, force: true });
    counters.lastVariantMs = Date.now() - started;
  }
}

// ---------------------------------------------------------------------------
// Coleta de lixo: postou, apagou
// ---------------------------------------------------------------------------

async function collectGarbage(context) {
  const { config, database, r2, counters } = context;
  const { data, error } = await database((supabase) => supabase.rpc('claim_publication_video_variant_gc', {
    p_limit: config.gcLimit, p_grace_minutes: config.gcGraceMinutes,
  }));
  if (error) throw error;
  const rows = (data ?? []).filter((row) => row.storage_path);
  if (rows.length === 0) return 0;

  // Apagar e em lote (ate 1.000 chaves por chamada) e gratis no R2.
  const { DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
  const response = await r2.send(new DeleteObjectsCommand({
    Bucket: config.variantBucket,
    Delete: { Objects: rows.map((row) => ({ Key: row.storage_path })), Quiet: true },
  }));
  const failedKeys = new Set((response.Errors ?? []).map((entry) => entry.Key));
  if (failedKeys.size > 0) {
    console.error(`${LOG} R2 recusou apagar ${failedKeys.size} objeto(s)`, { first: response.Errors[0] });
  }
  const confirmedIds = rows.filter((row) => !failedKeys.has(row.storage_path)).map((row) => row.publication_item_id);
  if (confirmedIds.length === 0) return 0;
  const { error: confirmError } = await database((supabase) => supabase.rpc('confirm_publication_video_variant_gc', {
    p_item_ids: confirmedIds,
  }));
  if (confirmError) throw confirmError;
  counters.deleted += confirmedIds.length;
  return confirmedIds.length;
}

// ---------------------------------------------------------------------------
// Laco principal
// ---------------------------------------------------------------------------

async function heartbeat(context, status, lastErrorMessage = null) {
  const { config, database, cache, bandwidth, counters } = context;
  const band = bandwidth.snapshot();
  const { error } = await database((supabase) => supabase.rpc('upsert_publication_worker_heartbeat', {
    p_worker_id: config.workerId,
    p_worker_kind: 'media_processing',
    p_status: status,
    p_dry_run: false,
    p_version: process.env.npm_package_version || null,
    p_hostname: os.hostname(),
    p_process_id: process.pid,
    p_last_error_message: lastErrorMessage,
    p_metadata: {
      role: 'video_variants',
      leadHours: config.leadHours,
      ffmpegConcurrency: config.ffmpegConcurrency,
      databaseConcurrency: config.databaseConcurrency,
      ...counters,
      averageEncodeMs: counters.ready > 0 ? Math.round(counters.encodeMsTotal / counters.ready) : null,
      cache: cache.stats(),
      bandwidthDayBytes: band.dayBytes,
      bandwidthMonthBytes: band.monthBytes,
      bandwidthQuotaBytes: config.bandwidthQuotaBytes,
      bandwidthLevel: band.level,
    },
  }));
  if (error) console.error(`${LOG} falha ao registrar heartbeat`, { message: error.message });
}

async function main() {
  loadEnvFile('.env.local');
  loadEnvFile('.env.worker');
  const config = readConfig();
  if (!config.variantBucket) throw new Error('Variável obrigatória ausente: R2_BUCKET_INSTAGRAM_VARIANTS');
  if (config.variantBucket === config.sourceBucket) {
    // O bucket de variantes tem regra de ciclo de vida que APAGA objetos velhos.
    throw new Error('R2_BUCKET_INSTAGRAM_VARIANTS não pode ser o bucket das mídias originais.');
  }
  await run('ffmpeg', ['-version']);
  await run('ffprobe', ['-version']);

  const supabase = await createSupabase();
  const withDatabasePermit = createSemaphore(config.databaseConcurrency);
  const database = (task) => withDatabasePermit(() => task(supabase));
  const r2 = await createR2Client();
  const bandwidth = createBandwidthMeter(config);
  const context = {
    config, database, r2, bandwidth,
    cache: createSourceCache({ config, r2, bandwidth }),
    probeCache: new Map(),
    counters: {
      ready: 0, failed: 0, stale: 0, collisions: 0, deleted: 0, releasedPreparation: 0,
      encodeMsTotal: 0, bytesUploaded: 0, lastVariantMs: null,
      // Quantas horas antes do post a variante mais apertada do ultimo lote foi
      // reivindicada. Abaixo de 24 o worker esta atrasado em relacao a preparacao.
      tightestLeadHours: null,
    },
  };

  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });

  console.log(`${LOG} iniciado`, {
    workerId: config.workerId, leadHours: config.leadHours, ffmpegConcurrency: config.ffmpegConcurrency,
    databaseConcurrency: config.databaseConcurrency, cacheDirectory: config.cacheDirectory, runOnce: config.runOnce,
  });
  await heartbeat(context, 'starting');
  let lastGcAt = 0;
  // SINAL DE VIDA POR RELOGIO, nao entre lotes. Em 20/09/2026 um lote de 30 variantes
  // `light` em full HD (25 s cada, 4 em paralelo) levou mais de 3 min e o monitor
  // acusou "worker sem heartbeat" com o processo vivo e produzindo.
  let currentStatus = 'idle';
  const heartbeatTimer = setInterval(() => {
    bandwidth.flush();
    heartbeat(context, currentStatus).catch(() => {});
  }, config.heartbeatIntervalMs);
  heartbeatTimer.unref();

  while (!stopping) {
    let claimedCount = 0;
    try {
      const { data, error } = await database((client) => client.rpc('claim_publication_video_variants', {
        p_worker_id: config.workerId,
        p_limit: config.claimLimit,
        p_lease_seconds: config.leaseSeconds,
        p_lead_hours: config.leadHours,
      }));
      if (error) throw error;
      const variants = data ?? [];
      claimedCount = variants.length;
      currentStatus = claimedCount > 0 ? 'processing' : 'idle';
      if (claimedCount > 0) {
        const tightest = Math.min(...variants.map((variant) => new Date(variant.execute_at).getTime()));
        context.counters.tightestLeadHours = Number(((tightest - Date.now()) / 3_600_000).toFixed(2));
        await mapWithConcurrency(variants, config.ffmpegConcurrency, (variant) => processVariant(context, variant));
      }

      if (Date.now() - lastGcAt >= config.gcIntervalMs) {
        lastGcAt = Date.now();
        await collectGarbage(context);
      }
    } catch (error) {
      // Rede, banco ou R2 fora: nunca derruba o processo. As linhas reivindicadas
      // voltam sozinhas quando o lease vence.
      console.error(`${LOG} falha no ciclo`, { message: String(error?.message || error).slice(0, 400), code: error?.code });
      await heartbeat(context, 'error', String(error?.message || error).slice(0, 400)).catch(() => {});
    }
    if (config.runOnce) break;
    // Lote cheio = ha mais fila; volta logo. Lote vazio = espera mais.
    const waitMs = claimedCount >= config.claimLimit ? 250
      : claimedCount > 0 ? config.pollIntervalMs : config.idleIntervalMs;
    await sleep(waitMs);
  }

  clearInterval(heartbeatTimer);
  bandwidth.flush();
  await heartbeat(context, 'stopped').catch(() => {});
  console.log(`${LOG} encerrado`, context.counters);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`${LOG} erro fatal`, error);
    process.exit(1);
  });
}
