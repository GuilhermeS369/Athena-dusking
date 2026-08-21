#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';

for (const filePath of ['.env.local', '.env.worker', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key]) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

const organizationId = process.argv.find((value) => value.startsWith('--organization-id='))?.slice('--organization-id='.length);
const baseUrl = process.argv.find((value) => value.startsWith('--base-url='))?.slice('--base-url='.length) ?? 'https://pomodoro-theta-one-82.vercel.app';
if (!organizationId || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Informe --organization-id e configure as credenciais Supabase.');
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data: members, error: membersError } = await supabase
  .from('organization_members')
  .select('user_id, role')
  .eq('organization_id', organizationId)
  .in('role', ['admin', 'operator'])
  .limit(10);
if (membersError) throw membersError;

const { data: usersData, error: usersError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1_000 });
if (usersError) throw usersError;
const memberIds = new Set((members ?? []).map((member) => member.user_id));
const testUser = usersData.users.find((user) => memberIds.has(user.id) && user.email);
if (!testUser?.email) throw new Error('Nenhum administrador/operador com e-mail foi encontrado.');

const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
  type: 'magiclink',
  email: testUser.email,
  options: { redirectTo: `${baseUrl}/postagem` },
});
if (linkError) throw linkError;

const authClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data: verified, error: verifyError } = await authClient.auth.verifyOtp({
  token_hash: linkData.properties.hashed_token,
  type: 'magiclink',
});
if (verifyError || !verified.session) throw verifyError ?? new Error('A sessão de teste não foi criada.');

const sessionCookies = [];
const cookieClient = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  cookies: {
    getAll: () => [],
    setAll: (cookies) => sessionCookies.push(...cookies),
  },
});
const { error: sessionError } = await cookieClient.auth.setSession(verified.session);
if (sessionError) throw sessionError;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
await page.context().addCookies(sessionCookies.map((cookie) => ({
  name: cookie.name,
  value: cookie.value,
  domain: new URL(baseUrl).hostname,
  path: '/',
  httpOnly: cookie.options?.httpOnly ?? false,
  secure: true,
  sameSite: 'Lax',
})));
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

const startedAt = Date.now();
await page.goto(`${baseUrl}/postagem`, { waitUntil: 'networkidle', timeout: 60_000 });
await page.getByText('Programar em massa', { exact: true }).first().click();
try {
  await page.getByRole('heading', { name: 'Programar em massa', exact: true }).waitFor({ timeout: 30_000 });
} catch (error) {
  console.error(JSON.stringify({ finalUrl: page.url(), title: await page.title(), body: (await page.locator('body').innerText()).slice(0, 1_000), cookies: (await page.context().cookies()).map((cookie) => cookie.name) }, null, 2));
  throw error;
}

const groupSelect = page.getByLabel('Filtrar perfis por grupo');
await groupSelect.selectOption({ label: 'Miguel' });
const bulkSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Programar em massa', exact: true }) }).first();
const formatSelect = bulkSection.getByLabel('Formato');
await formatSelect.selectOption('reel');

async function inspectProfile(username) {
  const search = page.getByLabel('Buscar perfil online');
  await search.fill(username);
  const row = page.getByRole('checkbox').filter({ hasText: `@${username}` });
  const count = await row.count();
  return count ? {
    username,
    rendered: true,
    text: (await row.first().innerText()).replace(/\s+/g, ' ').trim(),
    title: await row.first().locator('[title]').getAttribute('title'),
  } : { username, rendered: false };
}

const profiles = [];
for (const username of ['zoe9383042', 'zhen70463', 'zoe375950']) profiles.push(await inspectProfile(username));
await page.getByLabel('Buscar perfil online').fill('');
await page.screenshot({ path: 'postagem-production-validation-2026-08-19.png', fullPage: true });

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  elapsedMs: Date.now() - startedAt,
  finalUrl: page.url(),
  group: await groupSelect.inputValue(),
  format: await formatSelect.inputValue(),
  availableText: await page.locator('text=/disponíveis no filtro/').first().innerText(),
  profiles,
  consoleErrors,
}, null, 2));

await browser.close();
