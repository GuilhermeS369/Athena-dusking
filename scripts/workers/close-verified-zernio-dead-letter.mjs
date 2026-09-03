#!/usr/bin/env node

// Fecha UM incidente de reciclagem Zernio em `dead_letter`, e somente depois de
// provar contra a propria Zernio que a conta nao existe mais.
//
// POR QUE ISTO EXISTE. `dead_letter` e uma parada deliberada: o pipeline
// interrompe para preservar evidencia quando o DELETE remoto devolve algo que
// ele nao sabe interpretar. Isso e correto, mas nao ha caminho de volta — o job
// nunca mais e reivindicado (claim_zernio_profile_recycling_jobs so pega
// 'pending', 'deferred', 'remote_removal_pending', 'retry_pending' e
// 'processing'), entao o incidente fica aberto para sempre mesmo depois de a
// situacao se resolver por fora.
//
// Caso que motivou o script (03/09/2026), incidente
// 41c5d571-b539-45ac-950b-72e558772ac1 de 16/08:
//
//   A MESMA chave de API da Zernio estava cadastrada duas vezes, com rotulos
//   diferentes (AnastacioTawes66395 e AnonaSynowiec695965, ambas criadas em
//   15/08). O sync viu @thodglaura_bowdre "nas duas chaves" — era uma conta so,
//   enxergada duas vezes — e enfileirou a remocao da duplicata. O DELETE apagou
//   a conta e ela sumiu "das duas", claro. O pipeline registrou
//   `zernio_account_id_global_delete` (409) e parou para preservar evidencia.
//
//   A conexao duplicada foi apagada em 17/08 e a migration 159 passou a barrar
//   chave repetida. Nao sobrou nada a fazer: o incidente ficou aberto
//   descrevendo um problema que nao existe mais.
//
// A REGRA DE SEGURANCA. Fechar um incidente destes as cegas esconderia uma
// conta que ainda ocupa vaga. Por isso o script recusa a escrita a menos que as
// tres verificacoes passem:
//
//   1. o incidente esta mesmo em `dead_letter`;
//   2. nenhum perfil local VIVO carrega aquele zernio_account_id;
//   3. a Zernio, perguntada com a chave da propria conexao, NAO lista a conta.
//
// A verificacao 3 e a que importa: e a unica que fala da vaga. Sem ela isto
// seria maquiagem de registro.
//
// ALVO OBRIGATORIO, como em unstick de lote: nao existe modo "todos". Um script
// que varre dead_letters e um script que um dia apaga a evidencia de um
// incidente real.
//
//   node scripts/workers/close-verified-zernio-dead-letter.mjs --incident=<uuid>
//   node scripts/workers/close-verified-zernio-dead-letter.mjs --incident=<uuid> --confirm

import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const incidentId = process.argv.find((v) => v.startsWith('--incident='))?.slice('--incident='.length)?.trim();
const confirm = process.argv.includes('--confirm');

if (!incidentId || !UUID.test(incidentId)) {
  throw new Error('Informe --incident=<uuid do incidente>. Nao ha modo "todos" de proposito.');
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const zernioBaseUrl = (process.env.ZERNIO_API_BASE_URL ?? 'https://zernio.com/api').replace(/\/$/, '');
if (!supabaseUrl || !serviceRoleKey) throw new Error('Credenciais do Supabase nao encontradas.');

const db = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

function decryptApiKey(payload) {
  const [version, iv, tag, encrypted] = String(payload ?? '').split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Chave Zernio criptografada invalida.');
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY invalida ou ausente.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}

function recusar(motivo) {
  console.error(`\nRECUSADO: ${motivo}`);
  console.error('Nada foi alterado.');
  process.exit(1);
}

const { data: incident, error: incidentError } = await db
  .from('zernio_profile_disconnection_incidents')
  .select('id, organization_id, profile_id, state, signal, error_code, error_message, zernio_connection_id, zernio_account_id, removed_zernio_account_id, removed_connection_label_snapshot, username_snapshot, detected_at, updated_at')
  .eq('id', incidentId)
  .maybeSingle();
if (incidentError) throw incidentError;
if (!incident) recusar('incidente nao encontrado.');

console.log('Incidente ................', incident.id);
console.log('  sinal ..................', incident.signal);
console.log('  estado .................', incident.state);
console.log('  conta ..................', `@${incident.username_snapshot ?? '?'}`);
console.log('  detectado em ...........', incident.detected_at);
console.log('  motivo registrado ......', incident.error_code);

// 1. estado
if (incident.state !== 'dead_letter') {
  recusar(`o incidente esta em '${incident.state}', nao em 'dead_letter'. Este script so fecha dead_letter.`);
}

const accountId = incident.removed_zernio_account_id ?? incident.zernio_account_id;
if (!accountId) recusar('o incidente nao guarda o zernio_account_id; sem ele nao da para verificar a vaga.');
console.log('  accountId ..............', accountId);

// 2. nenhum perfil local vivo depende dessa conta
const { data: locais, error: locaisError } = await db
  .from('instagram_profiles')
  .select('id, username, deleted_at')
  .eq('zernio_account_id', accountId);
if (locaisError) throw locaisError;
const vivos = (locais ?? []).filter((p) => !p.deleted_at);
console.log(`\n[1/3] perfis locais com essa conta: ${locais?.length ?? 0} (vivos: ${vivos.length})`);
if (vivos.length) {
  recusar(`ainda existe perfil local vivo usando essa conta (${vivos.map((p) => '@' + p.username).join(', ')}).`);
}

// 3. a Zernio nao lista mais a conta
const { data: connection, error: connectionError } = await db
  .from('zernio_connections')
  .select('id, label, encrypted_api_key, deleted_at')
  .eq('id', incident.zernio_connection_id)
  .maybeSingle();
if (connectionError) throw connectionError;
if (!connection) recusar('a conexao do incidente nao existe mais; sem a chave nao da para perguntar a Zernio.');

const response = await fetch(`${zernioBaseUrl}/v1/accounts`, {
  headers: { Authorization: `Bearer ${decryptApiKey(connection.encrypted_api_key)}`, accept: 'application/json' },
});
if (!response.ok) {
  recusar(`a Zernio respondeu HTTP ${response.status} ao listar as contas da chave ${connection.label}. Sem resposta boa nao da para afirmar que a vaga esta livre.`);
}
const body = await response.json();
const remotas = (body.accounts ?? body.data ?? []).map((a) => a.accountId ?? a._id ?? a.id);
console.log(`[2/3] conexao ............. ${connection.label}${connection.deleted_at ? ' (apagada localmente)' : ''}`);
console.log(`[3/3] contas na Zernio .... ${remotas.length}; a do incidente esta la? ${remotas.includes(accountId) ? 'SIM' : 'nao'}`);
if (remotas.includes(accountId)) {
  recusar('a conta AINDA existe na Zernio e ocupa vaga. Fechar o incidente aqui esconderia isso.');
}

console.log('\nAs tres verificacoes passaram: a conta nao existe mais e nada local depende dela.');

if (!confirm) {
  console.log('\nEnsaio (dry-run). Nada foi escrito. Repita com --confirm para fechar.');
  process.exit(0);
}

const agora = new Date().toISOString();
const { error: updateIncidentError } = await db
  .from('zernio_profile_disconnection_incidents')
  // `error_code` e `error_message` ficam intactos de proposito: sao a evidencia
  // do que aconteceu, e o valor deste registro e justamente contar a historia.
  .update({ state: 'completed', finalized_at: agora, remote_completed_at: agora, remote_result: 'verified_absent_on_provider', defer_reason: null })
  .eq('id', incident.id)
  .eq('state', 'dead_letter');
if (updateIncidentError) throw updateIncidentError;

const { data: jobs, error: jobsError } = await db
  .from('zernio_profile_recycling_jobs')
  .update({ status: 'completed', completed_at: agora, deferred_reason: null })
  .eq('incident_id', incident.id)
  .eq('status', 'dead_letter')
  .select('id');
if (jobsError) throw jobsError;

console.log(`\nFechado. Incidente -> 'completed'; jobs atualizados: ${jobs?.length ?? 0}.`);
console.log('A evidencia (error_code, error_message, remote_http_status) foi preservada.');
