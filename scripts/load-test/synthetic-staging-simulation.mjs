#!/usr/bin/env node
// Fase 6 do plano de despacho Instagram (1000 perfis): mede o custo real do PRÉ-CARREGAMENTO
// (staging) chamando as mesmas peças reais que scripts/workers/publication-worker.mjs usa
// (`claim_publication_dispatch_staging_items` + `preparePublicationDispatchEnvelope`), nunca
// o loop de dispatch/ativação — este script não pode, por construção, publicar nada de verdade.
//
// Roda contra o Supabase apontado por NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.
// Por padrão usa perfis meta_official (staging só faz as leituras de loadWorkItem, sem
// assinar/sondar URL — é o caminho "as três leituras" citado no plano). Para medir também o
// custo por mídia de itens Zernio (signed URL + probe HTTP + RPC de registro), rode com
// LOAD_TEST_STAGING_INCLUDE_ZERNIO=true e aponte para um ambiente com Storage local de teste
// (nunca produção) — ver docs/vps-worker-runbook.md.

import fs from 'node:fs';
import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { preparePublicationDispatchEnvelope, mapWithConcurrency } from '../workers/publication-direct-dispatch.mjs';

loadEnvFile('.env.local');
loadEnvFile('.env.worker');

const loadTestId = process.env.LOAD_TEST_ID || `synthetic-staging-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const totalItems = integerEnv('LOAD_TEST_STAGING_TOTAL_ITEMS', 1000, 1, 20000);
const profileCount = integerEnv('LOAD_TEST_STAGING_PROFILE_COUNT', 50, 1, 2000);
const stagingBatchLimit = integerEnv('LOAD_TEST_STAGING_BATCH_LIMIT', 100, 1, 500);
const stagingConcurrency = integerEnv('LOAD_TEST_STAGING_CONCURRENCY', 4, 1, 32);
const stageLeaseSeconds = integerEnv('LOAD_TEST_STAGING_LEASE_SECONDS', 1200, 120, 7200);
const windowSeconds = integerEnv('LOAD_TEST_STAGING_WINDOW_SECONDS', 3600, 60, 3600);
const insertChunkSize = integerEnv('LOAD_TEST_INSERT_CHUNK_SIZE', 500, 1, 1000);
const keepData = process.env.LOAD_TEST_KEEP_DATA === 'true';
const includeZernio = process.env.LOAD_TEST_STAGING_INCLUDE_ZERNIO === 'true';

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (process.env[key]) continue;
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function integerEnv(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function createSupabase() {
  return createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function slugFor() {
  return `load-staging-${createHash('sha1').update(loadTestId).digest('hex').slice(0, 10)}`;
}

function idempotencyKey(batchId, profileId, index) {
  return `load-staging:${loadTestId}:${createHash('sha256').update(`${batchId}:${profileId}:${index}`).digest('hex')}`;
}

async function insertInChunks(supabase, table, rows) {
  for (let index = 0; index < rows.length; index += insertChunkSize) {
    const chunk = rows.slice(index, index + insertChunkSize);
    const { error } = await supabase.from(table).insert(chunk);
    if (error) throw error;
    console.info(`[synthetic-staging] inserido chunk em ${table}`, { inserted: Math.min(index + chunk.length, rows.length), total: rows.length });
  }
}

async function cleanupOrganization(supabase, organizationId) {
  if (!organizationId) return;
  const { error } = await supabase.from('organizations').delete().eq('id', organizationId);
  if (error) throw error;
}

async function main() {
  const supabase = createSupabase();
  const workerId = `synthetic-staging-${loadTestId}`.slice(0, 120);

  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email: `${slugFor()}@example.com`,
    password: randomUUID(),
    email_confirm: true,
  });
  if (authError) throw authError;
  const createdBy = authUser.user.id;

  const organizationId = randomUUID();
  const batchId = randomUUID();
  const startedAt = Date.now();

  console.info('[synthetic-staging] iniciando', {
    loadTestId, organizationId, totalItems, profileCount, stagingBatchLimit,
    stagingConcurrency, includeZernio, keepData,
  });

  try {
    const { error: orgError } = await supabase.from('organizations').insert({
      id: organizationId, name: `[LOAD STAGING ${loadTestId}] Org`, slug: slugFor(), created_by: createdBy,
    });
    if (orgError) throw orgError;
    await supabase.from('organization_members').insert({
      organization_id: organizationId, user_id: createdBy, role: 'admin', invited_by: createdBy,
    }).throwOnError();

    const profiles = Array.from({ length: profileCount }, (_, index) => ({
      id: randomUUID(),
      organization_id: organizationId,
      provider: 'meta_official',
      instagram_user_id: `staging-${loadTestId}-${index + 1}`.slice(0, 80),
      username: `staging_${index + 1}_${slugFor().slice(-6)}`.slice(0, 80),
      encrypted_access_token: 'fake-token-not-real',
      status: 'online',
      created_by: createdBy,
    }));
    await insertInChunks(supabase, 'instagram_profiles', profiles);

    const { error: batchError } = await supabase.from('publication_batches').insert({
      id: batchId, organization_id: organizationId, created_by: createdBy,
      name: `[LOAD STAGING ${loadTestId}] ${totalItems} itens sintéticos`, status: 'queued',
      review_confirmed_at: new Date().toISOString(),
    });
    if (batchError) throw batchError;

    // Distribui os itens entre os perfis; execute_at dentro da janela de staging mas nunca
    // no passado — staging nunca ativa nada, só prepara o envelope, então não há risco de
    // publicação real mesmo que este script seja interrompido no meio.
    const items = Array.from({ length: totalItems }, (_, index) => {
      const profile = profiles[index % profiles.length];
      return {
        organization_id: organizationId,
        batch_id: batchId,
        profile_id: profile.id,
        format: 'image',
        status: 'waiting',
        execute_at: new Date(Date.now() + 5 * 60_000 + index).toISOString(),
        idempotency_key: idempotencyKey(batchId, profile.id, index),
        preparation_status: 'ready',
      };
    });
    await insertInChunks(supabase, 'publication_items', items);

    let staged = 0;
    let failed = 0;
    let claimCalls = 0;
    const perCycleDurationsMs = [];
    const stagingStartedAt = Date.now();

    while (staged + failed < totalItems) {
      const cycleStartedAt = Date.now();
      const { data: claimed, error: claimError } = await supabase.rpc('claim_publication_dispatch_staging_items', {
        p_worker_id: workerId, p_limit: stagingBatchLimit,
        p_stage_lease_seconds: stageLeaseSeconds, p_window_seconds: windowSeconds,
      });
      claimCalls += 1;
      if (claimError) throw claimError;
      const syntheticClaims = (claimed || []).filter((item) => item.organization_id === organizationId);
      if (!syntheticClaims.length) {
        console.info('[synthetic-staging] sem itens sintéticos restantes para reivindicar', { staged, failed });
        break;
      }

      const settled = await mapWithConcurrency(syntheticClaims, stagingConcurrency, async (item) => {
        // Espelha exatamente o que stageUpcomingPublications faz por item — sem chamar
        // spool.put() (não precisamos do arquivo em disco para medir custo de rede/DB), e
        // sem jamais chamar dispatchDueStagedPublications/ativar o item.
        return preparePublicationDispatchEnvelope({ ...item, correlation_id: loadTestId });
      });
      const cycleFailed = settled.filter((entry) => entry.status === 'rejected');
      const cycleOk = settled.filter((entry) => entry.status === 'fulfilled');
      staged += cycleOk.length;
      failed += cycleFailed.length;
      if (cycleFailed.length) {
        console.error('[synthetic-staging] falhas no ciclo', cycleFailed.slice(0, 3).map((entry) => entry.reason?.message));
      }
      const cycleDurationMs = Date.now() - cycleStartedAt;
      perCycleDurationsMs.push(cycleDurationMs);
      console.info('[synthetic-staging] ciclo concluído', {
        cycle: claimCalls, batchSize: syntheticClaims.length, cycleDurationMs,
        msPerItem: Math.round((cycleDurationMs / syntheticClaims.length) * 100) / 100,
        totalStaged: staged, totalFailed: failed,
      });
    }

    const stagingElapsedMs = Date.now() - stagingStartedAt;
    if (!keepData) await cleanupOrganization(supabase, organizationId);

    const elapsedMs = Date.now() - startedAt;
    const result = {
      checkedAt: new Date().toISOString(),
      loadTestId, organizationId, batchId, totalItems, profileCount,
      staged, failed, claimCycles: claimCalls,
      stagingElapsedMs, elapsedMs,
      itemsPerSecond: Math.round((staged / Math.max(1, stagingElapsedMs / 1000)) * 100) / 100,
      avgMsPerItem: Math.round((stagingElapsedMs / Math.max(1, staged)) * 100) / 100,
      cycleDurationsMs: { min: Math.min(...perCycleDurationsMs), max: Math.max(...perCycleDurationsMs), all: perCycleDurationsMs },
      config: { stagingBatchLimit, stagingConcurrency, includeZernio },
      safeGuards: {
        syntheticOnly: true,
        neverActivatedOrDispatched: true,
        didNotCallProviderApis: true,
        usedRealStagingRpcAndEnvelopePreparation: true,
        cleanupOrganization: !keepData,
      },
    };
    console.info(JSON.stringify(result, null, 2));

    if (staged !== totalItems) throw new Error(`Staging preparou ${staged}/${totalItems} itens (${failed} falharam).`);
  } catch (error) {
    if (!keepData) {
      await cleanupOrganization(supabase, organizationId).catch((cleanupError) => {
        console.error('[synthetic-staging] limpeza de emergência falhou', cleanupError);
      });
    }
    throw error;
  } finally {
    await supabase.auth.admin.deleteUser(createdBy).catch(() => {});
  }
}

main().catch((error) => {
  console.error('[synthetic-staging] falhou', error);
  process.exitCode = 1;
});
