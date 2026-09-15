#!/usr/bin/env node
/**
 * Atualizador de identidade dos perfis Meta: relê username, nome e foto em
 * `GET /me` de TODO perfil online e regrava o que mudou.
 *
 * POR QUE EXISTE. O Athena gravava a identidade só na conexão. Em 15/09/2026,
 * 453 de 2.243 perfis online estavam renomeados no Instagram (username e nome),
 * e mais 145 só com o nome trocado; `instagram.com/<username-antigo>` dava
 * "página não disponível" e o perfil parecia caído sem ter caído. A partir de
 * 15/09 a coleta de métricas regrava a identidade a cada rodada (zero chamada
 * extra); este script é a passada completa, para rodar quando o dono quiser.
 *
 *   npm run worker:meta-identity-refresh            # relatório, não escreve
 *   npm run worker:meta-identity-refresh:apply      # grava
 *   node scripts/workers/meta-identity-refresh-worker.ts --org=<uuid> --apply
 *
 * O QUE ESCREVE (só com --apply): `refresh_instagram_profile_identity`
 * (migration 429) por perfil cujo username/nome/foto difere — ela atualiza
 * `instagram_profiles` e grava a trilha `instagram_profile_identity_changes`;
 * ao fim, `invalidate_publication_queue_summary` por organização tocada. Não
 * toca em status, token nem `last_*`: 190 aqui só conta e loga — o limpador da
 * fila (seção 5 do mestre) é quem derruba perfil.
 *
 * Imports relativos com `.ts` porque roda em `node` puro na VPS (type stripping
 * do Node 22, sem `tsx`). O token nunca é impresso.
 */
import { createClient } from '@supabase/supabase-js';

import {
  hasMetaProfileIdentityChange,
  metaProfileIdentityChanged,
  metaProfileIdentityFromAccount,
} from '../../lib/integrations/meta-profile-identity.ts';
import { decryptToken } from '../../lib/security/token-crypto.ts';

for (const file of ['.env.local', '.env.worker']) {
  try { process.loadEnvFile(file); } catch { /* opcional */ }
}

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION ?? 'v26.0';
const APPLY = process.argv.includes('--apply');
const ORG_FILTER = process.argv.find((arg) => arg.startsWith('--org='))?.slice(6) ?? null;
const CONCURRENCY = 4;
const PAUSE_BETWEEN_CALLS_MS = 150;
// Mesmos limiares de `lib/integrations/meta-analytics.ts`.
const APP_USAGE_STOP_PERCENT = 75;

type ProfileRow = {
  id: string;
  organization_id: string;
  meta_app_id: string | null;
  username: string | null;
  display_name: string | null;
  profile_picture_url: string | null;
  encrypted_access_token: string | null;
};

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável ${name} ausente.`);
  return value;
}

const admin = createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});

async function listOnlineProfiles() {
  const rows: ProfileRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let query = admin
      .from('instagram_profiles')
      .select('id, organization_id, meta_app_id, username, display_name, profile_picture_url, encrypted_access_token')
      .eq('provider', 'meta_official')
      .eq('status', 'online')
      .is('deleted_at', null)
      // Ordem total: `id` é a chave primária.
      .order('organization_id', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (ORG_FILTER) query = query.eq('organization_id', ORG_FILTER);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...((data ?? []) as ProfileRow[]));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

async function appLabels() {
  const { data, error } = await admin.from('meta_apps').select('id, label').limit(1000);
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.id as string, row.label as string]));
}

type Outcome =
  | { kind: 'unchanged' }
  | { kind: 'changed'; previous: ProfileRow; username: string | null; displayName: string | null; picture: boolean; written: string | null }
  | { kind: 'error'; code: number | null; message: string };

let stopForAppUsage = false;

/**
 * Pior eixo do `X-App-Usage` (`graph.instagram.com` manda
 * `{"call_volume":n,"cpu_time":n}`; o do Facebook usa outros nomes). Cópia
 * mínima de `parseMetaAppUsage` para o script não depender de módulos que a
 * VPS pode não ter.
 */
function appUsagePercent(header: string | null) {
  if (!header) return null;
  try {
    const values = Object.values(JSON.parse(header) as Record<string, unknown>).filter((v): v is number => typeof v === 'number');
    return values.length ? Math.max(...values) : null;
  } catch {
    return null;
  }
}

async function probe(profile: ProfileRow): Promise<Outcome> {
  if (!profile.encrypted_access_token) return { kind: 'error', code: null, message: 'sem token' };
  let token: string;
  try {
    token = decryptToken(profile.encrypted_access_token);
  } catch (error) {
    return { kind: 'error', code: null, message: `token ilegível: ${(error as Error).message}` };
  }
  const url = new URL(`https://graph.instagram.com/${GRAPH_VERSION}/me`);
  url.searchParams.set('fields', 'id,username,name,profile_picture_url');
  url.searchParams.set('access_token', token);
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20_000), cache: 'no-store' });
  } catch (error) {
    return { kind: 'error', code: null, message: `rede: ${(error as Error).message.replaceAll(token, '<token>').slice(0, 160)}` };
  }
  const usage = appUsagePercent(response.headers.get('x-app-usage'));
  if (usage !== null && usage >= APP_USAGE_STOP_PERCENT) stopForAppUsage = true;
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = (body.error ?? {}) as Record<string, unknown>;
    return {
      kind: 'error',
      code: typeof error.code === 'number' ? error.code : response.status,
      message: String(error.message ?? `HTTP ${response.status}`).replaceAll(token, '<token>').slice(0, 160),
    };
  }
  const identity = metaProfileIdentityFromAccount(body);
  if (!identity) return { kind: 'error', code: null, message: 'resposta sem username' };
  const diff = metaProfileIdentityChanged(profile, identity);
  if (!hasMetaProfileIdentityChange(diff)) return { kind: 'unchanged' };

  let written: string | null = null;
  if (APPLY) {
    const { data, error } = await admin.rpc('refresh_instagram_profile_identity', {
      p_profile_id: profile.id,
      p_username: identity.username,
      p_display_name: identity.displayName,
      p_profile_picture_url: identity.profilePictureUrl,
      p_source: 'worker',
    });
    written = error ? `erro: ${error.message}` : String(data);
  }
  return {
    kind: 'changed',
    previous: profile,
    username: diff.username ? identity.username : null,
    displayName: diff.displayName ? identity.displayName : null,
    picture: diff.picture,
    written,
  };
}

async function main() {
  const startedAt = Date.now();
  const profiles = await listOnlineProfiles();
  const labels = await appLabels();
  console.log(`${APPLY ? 'GRAVANDO' : 'RELATÓRIO (sem --apply, nada é escrito)'} · ${profiles.length} perfis online${ORG_FILTER ? ` da organização ${ORG_FILTER}` : ''}`);

  const counts = { unchanged: 0, changed: 0, usernameChanged: 0, nameOnly: 0, pictureOnly: 0, written: 0, writeErrors: 0, errors: 0, skippedForUsage: 0 };
  const errorsByMessage = new Map<string, number>();
  const changedByOrg = new Map<string, number>();
  const changedByApp = new Map<string, { changed: number; total: number }>();
  const touchedOrganizations = new Set<string>();
  const queue = [...profiles];

  async function worker() {
    while (queue.length > 0) {
      const profile = queue.shift()!;
      const appKey = labels.get(profile.meta_app_id ?? '') ?? '(sem app)';
      const appEntry = changedByApp.get(appKey) ?? { changed: 0, total: 0 };
      appEntry.total += 1;
      changedByApp.set(appKey, appEntry);

      if (stopForAppUsage) { counts.skippedForUsage += 1; continue; }
      const outcome = await probe(profile);
      if (outcome.kind === 'unchanged') counts.unchanged += 1;
      else if (outcome.kind === 'error') {
        counts.errors += 1;
        const key = `${outcome.code ?? '-'} ${outcome.message.slice(0, 70)}`;
        errorsByMessage.set(key, (errorsByMessage.get(key) ?? 0) + 1);
      } else {
        counts.changed += 1;
        if (outcome.username) counts.usernameChanged += 1;
        else if (outcome.displayName) counts.nameOnly += 1;
        else counts.pictureOnly += 1;
        changedByOrg.set(profile.organization_id, (changedByOrg.get(profile.organization_id) ?? 0) + 1);
        appEntry.changed += 1;
        if (outcome.written === 'updated') { counts.written += 1; touchedOrganizations.add(profile.organization_id); }
        else if (outcome.written?.startsWith('erro')) counts.writeErrors += 1;
        const partes = [
          outcome.username ? `@${profile.username} → @${outcome.username}` : `@${profile.username}`,
          outcome.displayName ? `"${profile.display_name ?? ''}" → "${outcome.displayName}"` : null,
          outcome.picture ? 'foto' : null,
          outcome.written ? `[${outcome.written}]` : null,
        ].filter(Boolean);
        console.log(`  ${partes.join(' | ')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_CALLS_MS));
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  if (APPLY) {
    for (const organizationId of touchedOrganizations) {
      const { error } = await admin.rpc('invalidate_publication_queue_summary', { p_organization_id: organizationId });
      if (error) console.error(`invalidar resumo da fila da organização ${organizationId}: ${error.message}`);
    }
  }

  console.log('');
  console.log(`Sondados ${profiles.length - counts.skippedForUsage} em ${Math.round((Date.now() - startedAt) / 1000)} s`);
  console.log(`  iguais: ${counts.unchanged} · mudaram: ${counts.changed} (username ${counts.usernameChanged}, só nome ${counts.nameOnly}, só foto ${counts.pictureOnly}) · erros da Meta: ${counts.errors}`);
  if (APPLY) console.log(`  gravados: ${counts.written} · falhas de gravação: ${counts.writeErrors} · resumo da fila invalidado em ${touchedOrganizations.size} organização(ões)`);
  if (counts.skippedForUsage > 0) console.log(`  PULADOS por uso do app ≥ ${APP_USAGE_STOP_PERCENT}%: ${counts.skippedForUsage} (rode de novo mais tarde)`);
  if (changedByOrg.size > 0) console.log(`  por organização: ${[...changedByOrg].map(([org, n]) => `${org}=${n}`).join(', ')}`);
  const apps = [...changedByApp].filter(([, entry]) => entry.changed > 0).sort((a, b) => b[1].changed - a[1].changed);
  if (apps.length > 0) {
    console.log('  por app (mudaram/total):');
    for (const [label, entry] of apps) console.log(`    ${label}: ${entry.changed}/${entry.total}`);
  }
  if (errorsByMessage.size > 0) {
    console.log('  erros da Meta (código mensagem: perfis):');
    for (const [key, n] of [...errorsByMessage].sort((a, b) => b[1] - a[1])) console.log(`    ${key}: ${n}`);
  }
  process.exitCode = counts.writeErrors > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error('atualizador de identidade falhou:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
