#!/usr/bin/env node

// Revoga somente a credencial criptografada de uma conexão Zernio já removida.
// Não chama a API Zernio, não remove a conexão e não altera perfis Instagram.
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf('=');
    if (!line || line.startsWith('#') || separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key]) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

const apply = process.argv.includes('--apply');
const outputPath = process.argv.find((value) => value.startsWith('--output='))?.slice('--output='.length);
const organizationId = '695be08f-3084-4046-a91d-9052b2a1582b';
const inactiveConnectionId = 'e49336fd-9f01-4620-a52e-dd56d1e80462';
const activeConnectionId = 'b3cb30d4-8683-45ce-819b-9dca84f1ab92';

if (!outputPath) throw new Error('Informe --output=<arquivo-de-evidência>.');

function decryptToken(payload) {
  const [version, ivValue, tagValue, encryptedValue] = payload.split('.');
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (version !== 'v1' || key.length !== 32) throw new Error('Credencial Zernio criptografada inválida.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

function fingerprint(payload) {
  return createHash('sha256').update(decryptToken(payload)).digest('hex').slice(0, 16);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) throw new Error('Credenciais do Supabase não encontradas.');
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

async function fetchReferences(connectionId) {
  const checks = await Promise.all([
    supabase.from('instagram_profiles').select('id', { count: 'exact', head: true }).eq('zernio_connection_id', connectionId),
    supabase.from('zernio_connection_remote_profiles').select('id', { count: 'exact', head: true }).eq('zernio_connection_id', connectionId),
    supabase.from('zernio_connection_attempts').select('id', { count: 'exact', head: true }).eq('zernio_connection_id', connectionId),
    supabase.from('zernio_connection_slot_reservations').select('id', { count: 'exact', head: true }).eq('zernio_connection_id', connectionId).is('released_at', null),
    supabase.from('zernio_connection_operation_locks').select('zernio_connection_id', { count: 'exact', head: true }).eq('zernio_connection_id', connectionId),
    supabase.from('zernio_oauth_turns').select('id', { count: 'exact', head: true }).eq('zernio_connection_id', connectionId).in('status', ['waiting', 'active']),
  ]);
  const error = checks.map((result) => result.error).find(Boolean);
  if (error) throw error;
  return {
    instagramProfiles: checks[0].count ?? 0,
    remoteProfiles: checks[1].count ?? 0,
    attempts: checks[2].count ?? 0,
    activeReservations: checks[3].count ?? 0,
    operationLocks: checks[4].count ?? 0,
    activeOauthTurns: checks[5].count ?? 0,
  };
}

const { data: connections, error: connectionError } = await supabase
  .from('zernio_connections')
  .select('id, organization_id, label, encrypted_api_key, deleted_at, status, updated_at')
  .eq('organization_id', organizationId)
  .in('id', [inactiveConnectionId, activeConnectionId]);
if (connectionError) throw connectionError;
if ((connections ?? []).length !== 2) throw new Error('As duas conexões esperadas não foram encontradas na organização Vini farmando cash.');

const inactive = connections.find((connection) => connection.id === inactiveConnectionId);
const active = connections.find((connection) => connection.id === activeConnectionId);
if (!inactive.deleted_at) throw new Error('A conexão alvo ainda está ativa; a revogação foi bloqueada.');
if (!active || active.deleted_at) throw new Error('A conexão canônica não está ativa; a revogação foi bloqueada.');
if (!inactive.encrypted_api_key || !active.encrypted_api_key) throw new Error('Uma das credenciais esperadas já está ausente; a operação foi bloqueada.');

const inactiveFingerprint = fingerprint(inactive.encrypted_api_key);
const activeFingerprint = fingerprint(active.encrypted_api_key);
if (inactiveFingerprint !== activeFingerprint) throw new Error('A credencial inativa não corresponde à credencial canônica esperada; a operação foi bloqueada.');

const references = await fetchReferences(inactiveConnectionId);
if (references.activeReservations || references.operationLocks || references.activeOauthTurns) {
  throw new Error(`A conexão inativa ainda possui referências operacionais ativas: ${JSON.stringify(references)}.`);
}

const preflight = {
  checkedAt: new Date().toISOString(),
  operation: 'purge_inactive_duplicate_zernio_credential',
  mode: apply ? 'apply' : 'dry_run',
  remoteDeleteCalled: false,
  target: { connectionId: inactive.id, label: inactive.label, deletedAt: inactive.deleted_at, credentialFingerprint: inactiveFingerprint },
  retainedActiveConnection: { connectionId: active.id, label: active.label, credentialFingerprint: activeFingerprint },
  references,
};

if (!apply) {
  fs.writeFileSync(outputPath, `${JSON.stringify(preflight, null, 2)}\n`);
  console.log(JSON.stringify(preflight, null, 2));
  process.exit(0);
}

// encrypted_api_key ainda é NOT NULL no schema. Substituir o ciphertext por um
// tombstone aleatório e inválido torna o segredo original irrecuperável sem
// mudar vínculos ou apagar a conexão histórica.
const revokedCredentialTombstone = `revoked:${randomUUID()}`;
const { data: revoked, error: revokeError } = await supabase
  .from('zernio_connections')
  .update({ encrypted_api_key: revokedCredentialTombstone })
  .eq('id', inactiveConnectionId)
  .eq('organization_id', organizationId)
  .not('deleted_at', 'is', null)
  .eq('encrypted_api_key', inactive.encrypted_api_key)
  .select('id, label, deleted_at, encrypted_api_key')
  .single();
if (revokeError) throw revokeError;
if (revoked.encrypted_api_key !== revokedCredentialTombstone) throw new Error('A confirmação pós-revogação não encontrou o tombstone de revogação esperado.');

const { data: activeAfter, error: activeAfterError } = await supabase
  .from('zernio_connections')
  .select('id, label, encrypted_api_key, deleted_at')
  .eq('id', activeConnectionId)
  .eq('organization_id', organizationId)
  .single();
if (activeAfterError) throw activeAfterError;
if (activeAfter.deleted_at || !activeAfter.encrypted_api_key || fingerprint(activeAfter.encrypted_api_key) !== activeFingerprint) {
  throw new Error('A conexão canônica não permaneceu intacta; intervenção manual necessária.');
}

const report = {
  ...preflight,
  revokedAt: new Date().toISOString(),
  result: { inactiveCredentialPurged: true, inactiveCredentialTombstoned: true, activeCredentialPreserved: true },
};
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
