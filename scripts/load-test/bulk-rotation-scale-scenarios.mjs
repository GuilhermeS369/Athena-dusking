#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key]) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function json(value) {
  return JSON.stringify(value, (_key, current) => typeof current === 'bigint' ? current.toString() : current, 2);
}

function scenarioDefinition(name) {
  const scenarios = {
    '300x24': { profiles: 300, media: 40, intervalMinutes: 60, durationDays: '1', expected: 7200n },
    '500x24': { profiles: 500, media: 40, intervalMinutes: 60, durationDays: '1', expected: 12000n },
    '500x72': { profiles: 500, media: 40, intervalMinutes: 60, durationDays: '3', expected: 36000n },
  };
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`Cenário inválido: ${name}. Use 300x24, 500x24 ou 500x72.`);
  return { name, ...scenario };
}

const scenario = scenarioDefinition(process.env.BULK_LOAD_SCENARIO || '300x24');
const execute = process.argv.includes('--execute');
const keep = process.argv.includes('--keep');
const organizationId = process.env.LOAD_TEST_ORGANIZATION_ID || null;
const loadTestId = process.env.LOAD_TEST_ID || scenario.name;
if (!/^[A-Za-z0-9._-]{1,80}$/.test(loadTestId)) throw new Error('LOAD_TEST_ID inválido. Use apenas letras, números, ponto, hífen ou sublinhado.');
const planPrefix = `[BULK LOAD ${loadTestId}]`;

if (!execute) {
  console.info(json({
    mode: 'dry-run',
    scenario,
    requiredProfiles: scenario.profiles,
    requiredEligibleMedia: scenario.media,
    expectedPublications: scenario.expected.toString(),
    note: 'Passe --execute somente em staging isolado com perfis sintéticos online e 40 mídias elegíveis já preparadas.',
  }));
  process.exit(0);
}

if (process.env.BULK_LOAD_ALLOW_MUTATION !== 'true') {
  throw new Error('Defina BULK_LOAD_ALLOW_MUTATION=true explicitamente para executar o cenário mutável.');
}
if (!organizationId) throw new Error('LOAD_TEST_ORGANIZATION_ID é obrigatório em --execute.');
if (process.env.BULK_PUBLICATION_ROLLOUT === 'off') throw new Error('BULK_PUBLICATION_ROLLOUT=off bloqueia a criação de novos planos.');

const supabase = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const accessToken = required('BULK_LOAD_ADMIN_ACCESS_TOKEN');
const authenticated = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('NEXT_PUBLIC_SUPABASE_ANON_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { headers: { Authorization: `Bearer ${accessToken}` } },
});

const [{ data: profiles, error: profilesError }, { data: userData, error: userError }] = await Promise.all([
  supabase.from('instagram_profiles').select('id').eq('organization_id', organizationId).eq('status', 'online').is('deleted_at', null).order('created_at').limit(scenario.profiles),
  authenticated.auth.getUser(accessToken),
]);
if (profilesError) throw profilesError;
if (userError || !userData.user) throw new Error('BULK_LOAD_ADMIN_ACCESS_TOKEN inválido ou expirado.');
if ((profiles?.length || 0) < scenario.profiles) throw new Error(`Cenário exige ${scenario.profiles} perfis online; encontrados ${profiles?.length || 0}.`);

const { data: membership, error: membershipError } = await supabase
  .from('organization_members')
  .select('role')
  .eq('organization_id', organizationId)
  .eq('user_id', userData.user.id)
  .maybeSingle();
if (membershipError) throw membershipError;
if (!membership || !['admin', 'operator'].includes(membership.role)) {
  throw new Error('O token deve pertencer a um administrador ou operador da organização de carga.');
}
const rollout = (process.env.BULK_PUBLICATION_ROLLOUT ?? 'all').trim().toLowerCase();
if (rollout === 'admins' && membership.role !== 'admin') throw new Error('O rollout atual exige uma sessão administrativa.');
if (rollout === 'managers' && !['admin', 'operator'].includes(membership.role)) throw new Error('O rollout atual não permite esta sessão.');

const { data: mediaSummary, error: mediaSummaryError } = await authenticated.rpc('get_bulk_rotation_media_summary', {
  p_organization_id: organizationId,
  p_origin_type: 'ungrouped',
  p_origin_group_id: null,
  p_format: 'story',
});
if (mediaSummaryError) throw mediaSummaryError;
const eligibleMedia = BigInt(mediaSummary?.eligible ?? '-1');
if (eligibleMedia !== BigInt(scenario.media)) {
  throw new Error(`O cenário exige exatamente ${scenario.media} mídias elegíveis sem grupo; encontradas ${eligibleMedia}. Isole a organização/origem sintética antes do teste.`);
}

const request = {
  name: `${planPrefix} ${scenario.profiles} perfis`,
  profileIds: profiles.map((profile) => profile.id),
  format: 'story',
  intervalMinutes: scenario.intervalMinutes,
  durationDays: scenario.durationDays,
  orderMode: 'diversified',
  rotationSeed: `load-${scenario.name}`,
};
const requestKey = `bulk-load-${createHash('sha256').update(`${organizationId}:${loadTestId}:${scenario.name}`).digest('hex')}`;
const startedAt = Date.now();
const { data: plan, error: planError } = await authenticated.rpc('create_bulk_rotation_plan', {
  p_organization_id: organizationId,
  p_request_key: requestKey,
  p_name: request.name,
  p_profile_ids: request.profileIds,
  p_origin_type: 'ungrouped',
  p_origin_group_id: null,
  p_format: request.format,
  p_interval_minutes: request.intervalMinutes,
  p_duration_days: request.durationDays,
  p_caption: null,
  p_order_mode: request.orderMode,
  p_rotation_seed: request.rotationSeed,
  p_algorithm_version: 1,
  p_chunk_size: 500,
});
if (planError) throw planError;
if (BigInt(plan?.expectedPublications ?? '-1') !== scenario.expected) {
  throw new Error(`Plano criado com projeção inesperada: ${plan?.expectedPublications ?? 'ausente'}.`);
}

console.info(json({
  mode: 'created',
  organizationId,
  scenario,
  creationElapsedMs: Date.now() - startedAt,
  authenticatedUserId: userData.user.id,
  plan,
  payload: request,
  cleanupSelector: { organizationId, planNamePrefix: planPrefix },
  keep,
  next: 'Execute npm run load-test:bulk-report durante a geração e preserve os resultados antes do cleanup.',
}));
