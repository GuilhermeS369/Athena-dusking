#!/usr/bin/env node

// Gera uma tentativa OAuth auditável para restauração emergencial. Não imprime
// API key e fixa callback, organização, usuário e conexão canônica.
import { createDecipheriv, randomUUID } from 'node:crypto';
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

const argument = (name) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1)?.trim() ?? null;
const organizationId = argument('--organization-id');
const connectionId = argument('--connection-id');
const userEmail = argument('--user-email')?.toLocaleLowerCase('en-US');
const appBaseUrl = (argument('--app-base-url') ?? process.env.PUBLICATION_WORKER_APP_BASE_URL ?? '').replace(/\/$/, '');
if (!organizationId || !connectionId || !userEmail || !appBaseUrl) throw new Error('Informe organização, conexão, e-mail e app base URL.');

function decryptToken(payload) {
  const [version, ivValue, tagValue, encryptedValue] = payload.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) throw new Error('Chave Zernio criptografada inválida.');
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY inválida ou ausente.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const users = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (users.error) throw users.error;
const user = users.data.users.find((candidate) => candidate.email?.toLocaleLowerCase('en-US') === userEmail);
if (!user) throw new Error('Usuário não encontrado.');
const membership = await supabase.from('organization_members').select('role').eq('organization_id', organizationId).eq('user_id', user.id).maybeSingle();
if (membership.error || !membership.data || !['admin', 'operator'].includes(membership.data.role)) throw new Error('Usuário sem permissão operacional nesta organização.');
const connectionResult = await supabase
  .from('zernio_connections')
  .select('id, organization_id, label, encrypted_api_key, zernio_profile_id')
  .eq('id', connectionId)
  .eq('organization_id', organizationId)
  .is('deleted_at', null)
  .maybeSingle();
if (connectionResult.error || !connectionResult.data?.encrypted_api_key || !connectionResult.data.zernio_profile_id) throw new Error('Conexão canônica indisponível ou sem profile Zernio.');

const attemptId = randomUUID();
const callback = new URL('/api/integrations/zernio/callback', appBaseUrl);
callback.searchParams.set('returnTo', '/perfis');
callback.searchParams.set('connectionId', connectionId);
callback.searchParams.set('attemptId', attemptId);
const apiKey = decryptToken(connectionResult.data.encrypted_api_key);
const response = await fetch(`${(process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api').replace(/\/$/, '')}/v1/connect/instagram?${new URLSearchParams({ profileId: connectionResult.data.zernio_profile_id, redirect_url: callback.toString() })}`, {
  headers: { Authorization: `Bearer ${apiKey}` },
  cache: 'no-store',
  signal: AbortSignal.timeout(25_000),
});
const payload = await response.json().catch(() => ({}));
if (!response.ok || typeof payload.authUrl !== 'string') throw new Error(`Zernio não gerou OAuth: HTTP ${response.status} ${String(payload.message ?? payload.error ?? '')}`);

const authHost = new URL(payload.authUrl).host;
const insertResult = await supabase.from('zernio_connection_attempts').insert({
  id: attemptId,
  organization_id: organizationId,
  zernio_connection_id: connectionId,
  created_by: user.id,
  return_to: '/perfis',
  status: 'redirected',
  zernio_profile_id: connectionResult.data.zernio_profile_id,
  request_user_agent: 'athena-emergency-restoration',
  redirected_at: new Date().toISOString(),
  auth_url_host: authHost,
  zernio_state: typeof payload.state === 'string' ? payload.state : null,
  diagnostic: {
    knownZernioAccountIds: [],
    knownZernioAccountCount: 0,
    restoration: true,
    expectedUsername: 'thodglaura_bowdre',
    incidentId: '41c5d571-b539-45ac-950b-72e558772ac1',
  },
});
if (insertResult.error) throw insertResult.error;

console.log(JSON.stringify({
  authUrl: payload.authUrl,
  attemptId,
  connection: connectionResult.data.label,
  callback: callback.toString(),
  expiresRecommendation: 'Abra imediatamente; o link/state pode expirar.',
}, null, 2));
