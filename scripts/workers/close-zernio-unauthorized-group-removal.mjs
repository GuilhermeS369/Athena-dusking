#!/usr/bin/env node

// Encerra localmente os perfis de UM job de exclusao de grupo que ficaram em
// dead_letter com HTTP 401 da Zernio.
//
// POR QUE EXISTE. Em 04/09/2026 a Zernio suspendeu 2.004 das 2.166 conexoes
// ativas (migration 374). Desde entao o DELETE remoto devolve 401, que o
// cliente nao trata como retryavel — corretamente, repetir nao muda nada — e o
// job vai direto para dead_letter na tentativa 1. Dead_letter e uma parada sem
// volta: claim_zernio_profile_recycling_jobs nao o reivindica. O perfil fica
// preso, sem grupo, com a fila ja cancelada, e a tela oferece "tentar de novo"
// para algo que nunca vai passar.
//
// A migration 427 fez o worker resolver isso sozinho daqui em diante. Este
// script e para os jobs que JA ficaram presos antes dela.
//
// ALVO OBRIGATORIO, como nos outros scripts desta pasta: nao existe modo
// "todos". Um script que varre dead_letters e um script que um dia apaga a
// evidencia de um incidente real. Ele so toca incidentes cujo
// remote_http_status e exatamente 401 e que pertencem ao job informado.
//
//   node scripts/workers/close-zernio-unauthorized-group-removal.mjs --job=<uuid>
//   node scripts/workers/close-zernio-unauthorized-group-removal.mjs --job=<uuid> --confirm
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const file of ['.env.local', '.env.worker.deploy']) {
  if (!fs.existsSync(file)) continue;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (process.env[k]) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
}

const JOB_ID = process.argv.find((a) => a.startsWith('--job='))?.slice('--job='.length);
const CONFIRM = process.argv.includes('--confirm');
if (!JOB_ID) { console.error('uso: --job=<uuid> [--confirm]'); process.exit(1); }

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: snapshot, error: snapErr } = await supabase
  .from('profile_group_deletion_job_profiles')
  .select('profile_id, organization_id, username_snapshot')
  .eq('job_id', JOB_ID)
  .order('profile_id', { ascending: true });
if (snapErr) { console.error('falha lendo snapshot:', snapErr.message); process.exit(1); }
if (!snapshot?.length) { console.error('job sem perfis'); process.exit(1); }

const orgId = snapshot[0].organization_id;
const { data: incidents, error: incErr } = await supabase
  .from('zernio_profile_disconnection_incidents')
  .select('id, profile_id, username_snapshot, state, remote_http_status')
  .eq('organization_id', orgId)
  .eq('state', 'dead_letter')
  .eq('remote_http_status', 401)
  .in('profile_id', snapshot.map((r) => r.profile_id))
  .order('profile_id', { ascending: true });
if (incErr) { console.error('falha lendo incidentes:', incErr.message); process.exit(1); }

console.log(`job ${JOB_ID}: ${snapshot.length} perfis no snapshot, ${incidents.length} em dead_letter com 401`);
if (!CONFIRM) {
  incidents.forEach((i) => console.log(`  seria encerrado: @${i.username_snapshot}`));
  console.log('\nensaio. repita com --confirm para gravar.');
  process.exit(0);
}

let ok = 0; let skip = 0;
for (const incident of incidents) {
  const { data, error } = await supabase.rpc('finalize_zernio_removal_without_remote', {
    p_organization_id: orgId,
    p_incident_id: incident.id,
    p_reason: 'Chave Zernio sem autorizacao (401) desde a suspensao de 04/09/2026; a conta remota nao pode ser removida e o perfil foi encerrado apenas no Athena.',
  });
  if (error) { console.error(`  ERRO @${incident.username_snapshot}: ${error.message}`); continue; }
  if (data?.closed) { ok += 1; console.log(`  encerrado @${incident.username_snapshot} (fila cancelada: ${data.ignoredItemCount}, planos: ${data.interruptedPlanCount})`); }
  else { skip += 1; console.log(`  pulado @${incident.username_snapshot}: ${data?.reason}`); }
}
console.log(`\nencerrados: ${ok} · pulados: ${skip}`);
