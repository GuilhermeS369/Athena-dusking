#!/usr/bin/env node

// Atualiza a ocupação de todas as chaves de uma organização a partir do
// inventário remoto integral. Não cria perfis nem chama DELETE.
import fs from 'node:fs';
import process from 'node:process';
import { createDecipheriv } from 'node:crypto';
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
const argument = (name) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1)?.trim() ?? null;
const organizationName = argument('--organization');
if (!organizationName || !process.argv.includes('--apply')) throw new Error('Informe --organization e --apply.');

function decryptToken(payload) {
  const [version, ivValue, tagValue, encryptedValue] = payload.split('.');
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (version !== 'v1' || key.length !== 32) throw new Error('Chave criptografada ou TOKEN_ENCRYPTION_KEY inválida.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}
const baseUrl = (process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api').replace(/\/$/, '');
function profileId(account) {
  return typeof account.profileId === 'string' ? account.profileId : account.profileId?._id ?? null;
}
async function countInstagram(apiKey, canonicalProfileId) {
  const response = await fetch(`${baseUrl}/v1/accounts`, { headers: { Authorization: `Bearer ${apiKey}` }, cache: 'no-store', signal: AbortSignal.timeout(25_000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload.message === 'string'
      ? payload.message
      : typeof payload.error === 'string'
        ? payload.error
        : null;
    throw new Error(`GET /v1/accounts retornou HTTP ${response.status}${detail ? `: ${detail}` : ''}.`);
  }
  if (!canonicalProfileId) throw new Error('Conexão sem profile canônico; inventário não pode ser inferido.');
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  return accounts.filter((account) => account?.platform === 'instagram' && profileId(account) === canonicalProfileId).length;
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: organization, error: organizationError } = await supabase.from('organizations').select('id, name').ilike('name', organizationName).single();
if (organizationError) throw organizationError;
const { data: connections, error: connectionError } = await supabase.from('zernio_connections')
  .select('id, label, encrypted_api_key, zernio_profile_id').eq('organization_id', organization.id).is('deleted_at', null);
if (connectionError) throw connectionError;
const results = [];
for (const connection of connections) {
  const checkedAt = new Date().toISOString();
  try {
    const count = await countInstagram(decryptToken(connection.encrypted_api_key), connection.zernio_profile_id);
    const { error } = await supabase.from('zernio_connections').update({
      remote_instagram_account_count: count,
      remote_inventory_checked_at: checkedAt,
      remote_inventory_error_code: null,
      remote_inventory_error_message: null,
      last_checked_at: checkedAt,
      last_success_at: checkedAt,
    }).eq('id', connection.id).eq('organization_id', organization.id);
    if (error) throw error;
    results.push({ id: connection.id, label: connection.label, status: 'refreshed', remoteInstagramAccountCount: count, checkedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha desconhecida ao consultar inventário remoto.';
    const { error: updateError } = await supabase.from('zernio_connections').update({
      remote_inventory_checked_at: checkedAt,
      remote_inventory_error_code: 'remote_inventory_request_failed',
      remote_inventory_error_message: message.slice(0, 500),
      last_checked_at: checkedAt,
    }).eq('id', connection.id).eq('organization_id', organization.id);
    if (updateError) throw updateError;
    results.push({ id: connection.id, label: connection.label, status: 'failed', error: message, checkedAt });
  }
}
console.log(JSON.stringify({
  organization: { id: organization.id, name: organization.name },
  refreshed: results.filter((result) => result.status === 'refreshed').length,
  failed: results.filter((result) => result.status === 'failed').length,
  results,
}, null, 2));
