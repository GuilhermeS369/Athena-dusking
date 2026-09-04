#!/usr/bin/env node
//
// Reparo das falhas `ERROR` de 04/09/2026, que não eram falhas.
//
// O QUE ACONTECEU. `containerStatus` pedia à Meta apenas `fields=status_code` e
// tratava `ERROR` como terminal (`retryable: false`). 73 publicações foram
// encerradas assim, o disjuntor viu 5 falhas terminais consecutivas e pausou os
// lotes. Consultados depois, os MESMOS contêineres respondiam `FINISHED` — mídia
// processada e pronta. Um foi publicado manualmente para confirmar: HTTP 200,
// post no ar. O contêiner nunca esteve quebrado.
//
// A documentação da Meta recomenda consultar o status "uma vez por minuto, por
// no máximo 5 minutos"; nós consultávamos 17 a 27 minutos depois. E é conhecido
// que a Meta devolve erros transitórios nesse polling que funcionam na
// retentativa. A leitura de `ERROR` provavelmente foi um desses.
//
// A DECISÃO É DO USUÁRIO, e foi esta:
//
//   * STORY  -> volta para a fila. Story expira em 24 h e não polui o feed,
//               então repetir custa pouco.
//   * demais -> marcado como `ignored`. Reel repetido ficaria duplicado no
//               perfil para sempre, e isso é pior do que perder um post.
//
// SOBRE OS LOTES A RETOMAR, e aqui está a parte que exige cuidado: só os que
// foram pausados por ESTA causa. Dos 41 lotes pausados, vários são da era Zernio
// e acumularam centenas de falhas reais durante a suspensão em massa das contas.
// Retomar aqueles repetiria o fracasso contra contas que seguem desconectadas.
//
// PRAZO: contêineres da Meta expiram em 24 h. Os de 21:33 de 04/09 morrem por
// volta de 21:33 de 05/09; depois disso a mídia teria de ser reenviada do zero.
//
// USO:
//   node scripts/workers/recover-meta-false-error-failures.mjs           # simula
//   node scripts/workers/recover-meta-false-error-failures.mjs --apply   # aplica

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker']) {
  if (!fs.existsSync(filePath)) continue;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0 || line.trim().startsWith('#')) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key]) continue;
    process.env[key] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const apply = process.argv.includes('--apply');

async function main() {
  // Ordem total por (updated_at, id): sem o id, itens que falharam no mesmo
  // instante — e foram dezenas — repetiriam e sumiriam na paginação.
  const falhas = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('publication_items')
      .select('id, batch_id, organization_id, format, creation_id, updated_at')
      .eq('status', 'failed').eq('last_error_code', 'ERROR')
      .order('updated_at', { ascending: true }).order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`Falha ao ler os itens: ${error.message}`);
    falhas.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) break;
  }

  const stories = falhas.filter((item) => item.format === 'story');
  const demais = falhas.filter((item) => item.format !== 'story');
  const semContainer = stories.filter((item) => !item.creation_id);

  console.log('=== FALHAS `ERROR` ENCONTRADAS ===');
  console.log(`  total ${falhas.length} · stories ${stories.length} (${semContainer.length} sem contêiner) · demais ${demais.length}`);
  const porFormato = {};
  for (const item of demais) porFormato[item.format] = (porFormato[item.format] ?? 0) + 1;
  console.log('  demais por formato:', porFormato);

  // Só os lotes tocados por ESTA causa entram na retomada.
  const lotesDaCausa = [...new Set(falhas.map((item) => item.batch_id).filter(Boolean))];
  const { data: pausados } = await supabase.from('publication_batch_circuit_breakers')
    .select('batch_id, organization_id, consecutive_failures, paused_at')
    .not('paused_at', 'is', null).range(0, 999);
  const aRetomar = (pausados ?? []).filter((b) => lotesDaCausa.includes(b.batch_id));
  const foraDoEscopo = (pausados ?? []).length - aRetomar.length;

  console.log('\n=== LOTES ===');
  console.log(`  pausados no total: ${(pausados ?? []).length}`);
  console.log(`  a retomar (tocados por esta causa): ${aRetomar.length}`);
  console.log(`  NÃO tocados, ficam pausados: ${foraDoEscopo}  <- era Zernio e outras causas`);
  for (const b of aRetomar) console.log(`    ${b.batch_id.slice(0, 8)} pausado ${b.paused_at.slice(11, 19)} falhas=${b.consecutive_failures}`);

  if (!apply) {
    console.log('\nSimulação. Nada foi alterado. Rode com --apply para executar.');
    return;
  }

  console.log('\n=== APLICANDO ===');

  // Stories voltam para a fila. `creation_id` é PRESERVADO de propósito: o
  // contêiner está FINISHED e vale 24 h, então republicar não reenvia mídia —
  // o worker consulta o status, vê FINISHED e publica.
  let reenfileirados = 0;
  for (let i = 0; i < stories.length; i += 50) {
    const bloco = stories.slice(i, i + 50).map((item) => item.id);
    const { error } = await supabase.from('publication_items').update({
      status: 'waiting',
      attempt_count: 0,
      next_attempt_at: null,
      claimed_by: null,
      lease_until: null,
      last_error_code: null,
      last_error_message: null,
    }).in('id', bloco);
    if (error) { console.error(`  erro ao reenfileirar bloco: ${error.message}`); continue; }
    reenfileirados += bloco.length;
  }
  console.log(`  stories de volta na fila: ${reenfileirados}`);

  let ignorados = 0;
  for (let i = 0; i < demais.length; i += 50) {
    const bloco = demais.slice(i, i + 50).map((item) => item.id);
    const { error } = await supabase.from('publication_items').update({
      status: 'ignored',
      claimed_by: null,
      lease_until: null,
      next_attempt_at: null,
      last_error_code: 'meta_container_error_ignored',
      last_error_message: 'Falha ERROR de 04/09 sem motivo informado pela Meta. Decisão operacional: não republicar formato de feed para não duplicar no perfil.',
    }).in('id', bloco);
    if (error) { console.error(`  erro ao ignorar bloco: ${error.message}`); continue; }
    ignorados += bloco.length;
  }
  console.log(`  demais formatos ignorados: ${ignorados}`);

  let retomados = 0;
  for (const b of aRetomar) {
    const { error } = await supabase.rpc('resume_publication_batch_preserving_items', {
      p_organization_id: b.organization_id,
      p_batch_id: b.batch_id,
      p_actor_label: 'Reparo das falhas ERROR de 04/09: contêineres estavam FINISHED.',
    });
    if (error) { console.error(`  ${b.batch_id.slice(0, 8)}: ${error.message}`); continue; }
    retomados += 1;
  }
  console.log(`  lotes retomados: ${retomados} de ${aRetomar.length}`);
  console.log(`\n  ${foraDoEscopo} lote(s) seguem pausados de propósito — outra causa, outra decisão.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
