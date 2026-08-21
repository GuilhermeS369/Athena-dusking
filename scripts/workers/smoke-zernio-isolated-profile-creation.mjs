#!/usr/bin/env node

import fs from 'node:fs';
import { createDecipheriv, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const separator = rawLine.indexOf('=');
    if (separator <= 0 || rawLine.trim().startsWith('#')) continue;
    const key = rawLine.slice(0, separator).trim();
    if (!process.env[key]) process.env[key] = rawLine.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

function required(name) {
  if (!process.env[name]) throw new Error(`Variável ausente: ${name}`);
  return process.env[name];
}

function decrypt(payload) {
  const [version, ivValue, tagValue, encryptedValue] = payload.split('.');
  if (version !== 'v1') throw new Error('Credencial criptografada inválida.');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(required('TOKEN_ENCRYPTION_KEY'), 'base64'), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

const organizationId = process.argv[2];
const connectionId = process.argv[3];
if (!organizationId || !connectionId) throw new Error('Uso: node smoke-zernio-isolated-profile-creation.mjs ORGANIZATION_ID CONNECTION_ID');

const supabase = createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const { data: connection, error } = await supabase.from('zernio_connections').select('encrypted_api_key').eq('id', connectionId).eq('organization_id', organizationId).single();
if (error) throw error;
const apiKey = decrypt(connection.encrypted_api_key);
const base = (process.env.ZERNIO_API_BASE_URL || 'https://zernio.com/api').replace(/\/$/, '');

async function createOne(index) {
  const key = randomUUID();
  const name = `Pandora smoke ${Date.now()} ${index} ${key.slice(0, 8)}`;
  const response = await fetch(`${base}/v1/profiles`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(25_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`create ${index}: HTTP ${response.status} ${String(payload.message ?? payload.error ?? '')}`);
  return { id: payload.profile?._id ?? payload.profile?.id, name };
}

const profiles = await Promise.all([createOne(1), createOne(2)]);
if (!profiles[0].id || !profiles[1].id || profiles[0].id === profiles[1].id) throw new Error('A Zernio não criou dois profiles remotos distintos.');

const accountsResponse = await fetch(`${base}/v1/accounts`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(25_000) });
const accountsPayload = await accountsResponse.json().catch(() => ({}));
if (!accountsResponse.ok) throw new Error(`accounts: HTTP ${accountsResponse.status}`);
const occupied = (accountsPayload.accounts ?? []).filter((account) => profiles.some((profile) => profile.id === (typeof account.profileId === 'string' ? account.profileId : account.profileId?._id)));
if (occupied.length) throw new Error('Um profile de smoke foi criado já contendo conta; limpeza automática foi bloqueada.');

for (const profile of profiles) {
  const response = await fetch(`${base}/v1/profiles/${encodeURIComponent(profile.id)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`delete ${profile.id}: HTTP ${response.status}`);
}

console.log(JSON.stringify({ ok: true, distinctProfilesCreatedConcurrently: 2, cleaned: 2 }));
