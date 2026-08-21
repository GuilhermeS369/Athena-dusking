#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const [organizationId, groupName] = process.argv.slice(2);
if (!organizationId || !groupName) throw new Error('Uso: node scripts/workers/validate-queue-reference-summary.mjs <organization-id> <nome-do-grupo>');

for (const filePath of ['.env.local', '.env.worker.deploy']) {
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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) throw new Error('Credenciais do Supabase não encontradas.');

const supabase = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
const { data: summary, error } = await supabase.rpc('get_publication_queue_reference_summary', { p_organization_id: organizationId });
if (error) throw error;

const group = (summary?.groups ?? []).find((row) => row.title?.trim().toLocaleLowerCase('pt-BR') === groupName.trim().toLocaleLowerCase('pt-BR'));
if (!group) throw new Error(`Grupo "${groupName}" não encontrado no resumo operacional.`);

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  group,
  totals: summary.totals,
  verification: {
    operationalTotalExcludesClosed: group.total === group.completed + group.active,
    closedIsSeparate: group.closed >= 0,
  },
}, null, 2));
