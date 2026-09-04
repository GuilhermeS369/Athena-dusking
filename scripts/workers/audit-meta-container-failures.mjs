#!/usr/bin/env node
//
// Pergunta à Meta se a falha foi mesmo falha — e reenfileira o que não era.
//
// POR QUE ISSO EXISTE. Em 04/09/2026, 76 publicações foram encerradas como falha
// terminal com "Instagram informou ERROR ao preparar a publicação". Consultados
// depois, os MESMOS contêineres respondiam `FINISHED`: mídia pronta, publicável.
// Um foi publicado à mão para confirmar — HTTP 200, post no ar. O contêiner nunca
// esteve quebrado; o veredito é que era falso.
//
// A Meta recomenda consultar o status "uma vez por minuto, por no máximo 5
// minutos", e devolve erros transitórios nesse polling que funcionam na
// retentativa. Nós consultávamos 17 a 27 minutos depois e tratávamos `ERROR`
// como definitivo. Enquanto a causa exata não aparecer, este script é o modo de
// não perder publicação por um veredito que o próprio provedor desmente.
//
// O QUE ELE FAZ: para cada falha recente com contêiner, pergunta à Meta o
// `status_code` E o `status` — este último é o campo que traz o motivo em texto
// e que o código não pedia até 04/09.
//
//   FINISHED  -> falso positivo. A mídia está pronta e o item pode voltar.
//   PUBLISHED -> já publicou. A falha é nossa contabilidade, não da Meta.
//   ERROR     -> falha real, e agora com o motivo escrito.
//   EXPIRED   -> passou das 24 h de validade do contêiner. Não recupera.
//
// SOBRE O REENFILEIRAMENTO: `--reenfileirar` devolve à fila apenas os
// FINISHED/PUBLISHED, e apenas no formato escolhido por `--formato` (padrão:
// story). O padrão é conservador de propósito — repetir um story custa pouco,
// porque expira em 24 h e não polui o feed; repetir um reel deixa o perfil com
// post duplicado para sempre.
//
// USO:
//   node scripts/workers/audit-meta-container-failures.mjs                 # so audita, 3h
//   node scripts/workers/audit-meta-container-failures.mjs --horas 12
//   node scripts/workers/audit-meta-container-failures.mjs --reenfileirar
//   node scripts/workers/audit-meta-container-failures.mjs --reenfileirar --formato todos

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

const graph = process.env.META_GRAPH_API_VERSION ?? 'v26.0';
const reenfileirar = process.argv.includes('--reenfileirar');
const horas = Number(process.argv[process.argv.indexOf('--horas') + 1]) || 3;
const formatoIndex = process.argv.indexOf('--formato');
const formatoAlvo = formatoIndex > 0 ? process.argv[formatoIndex + 1] : 'story';
/** Modesto de propósito: são chamadas externas e nenhuma pressa justifica rajada. */
const CONCURRENCY = 4;

async function main() {
  const { decryptToken } = await import('../../lib/security/token-crypto.ts');
  const desde = new Date(Date.now() - horas * 3600_000).toISOString();

  const falhas = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('publication_items')
      .select('id, format, creation_id, updated_at, last_error_code, last_error_message, profile_id, instagram_profiles(username, encrypted_access_token)')
      .eq('status', 'failed').not('creation_id', 'is', null).gte('updated_at', desde)
      .order('updated_at', { ascending: true }).order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`Falha ao ler os itens: ${error.message}`);
    falhas.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) break;
  }

  console.log(`=== FALHAS COM CONTÊINER nas últimas ${horas}h: ${falhas.length} ===\n`);
  if (!falhas.length) return;

  const veredito = new Map();
  const motivos = new Map();
  let index = 0;

  async function worker() {
    for (;;) {
      const i = index; index += 1;
      if (i >= falhas.length) return;
      const item = falhas[i];
      const perfil = item.instagram_profiles;
      if (!perfil?.encrypted_access_token) { veredito.set(item.id, 'SEM_TOKEN'); continue; }
      let token;
      try { token = decryptToken(perfil.encrypted_access_token); }
      catch { veredito.set(item.id, 'TOKEN_ILEGIVEL'); continue; }
      try {
        const url = `https://graph.instagram.com/${graph}/${encodeURIComponent(item.creation_id)}`
          + `?fields=status_code,status&access_token=${encodeURIComponent(token)}`;
        const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
        const body = await response.json().catch(() => ({}));
        const codigo = body.status_code ?? (response.ok ? 'SEM_STATUS' : `HTTP_${response.status}`);
        veredito.set(item.id, codigo);
        if (body.status && body.status !== body.status_code) {
          motivos.set(codigo, (motivos.get(codigo) ?? new Set()).add(String(body.status).slice(0, 200)));
        }
      } catch (error) {
        veredito.set(item.id, 'ERRO_DE_REDE');
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const porVeredito = {};
  for (const v of veredito.values()) porVeredito[v] = (porVeredito[v] ?? 0) + 1;
  console.log('O QUE A META DIZ AGORA:');
  for (const [k, v] of Object.entries(porVeredito).sort((a, b) => b[1] - a[1])) {
    const nota = k === 'FINISHED' ? '  <- FALSO POSITIVO: pronto para publicar'
      : k === 'PUBLISHED' ? '  <- já publicou; a falha é contabilidade nossa'
      : k === 'EXPIRED' ? '  <- passou das 24h; não recupera'
      : k === 'ERROR' ? '  <- falha real' : '';
    console.log(`  ${k.padEnd(14)} ${String(v).padStart(4)}${nota}`);
  }

  if (motivos.size) {
    console.log('\nMOTIVOS QUE A META INFORMOU (campo `status`):');
    for (const [codigo, conjunto] of motivos) {
      for (const motivo of conjunto) console.log(`  ${codigo}: ${motivo}`);
    }
  } else {
    console.log('\nA Meta não informou motivo em nenhum. Falhas anteriores a 04/09 não têm o campo,');
    console.log('porque o código só passou a pedir `status` naquela data.');
  }

  const recuperaveis = falhas.filter((item) => ['FINISHED', 'PUBLISHED'].includes(veredito.get(item.id)));
  const doFormato = formatoAlvo === 'todos' ? recuperaveis : recuperaveis.filter((i) => i.format === formatoAlvo);
  console.log(`\nRECUPERÁVEIS: ${recuperaveis.length} · do formato "${formatoAlvo}": ${doFormato.length}`);

  if (!reenfileirar) {
    console.log('\n(auditoria apenas; use --reenfileirar para devolver à fila)');
    return;
  }
  if (!doFormato.length) { console.log('\nNada a reenfileirar.'); return; }

  let devolvidos = 0;
  for (let i = 0; i < doFormato.length; i += 50) {
    const bloco = doFormato.slice(i, i + 50).map((item) => item.id);
    // `creation_id` preservado: o contêiner está pronto e vale 24 h, então o
    // worker consulta, vê FINISHED e publica sem reenviar a mídia.
    const { error } = await supabase.from('publication_items').update({
      status: 'waiting', attempt_count: 0, next_attempt_at: null,
      claimed_by: null, lease_until: null, last_error_code: null, last_error_message: null,
    }).in('id', bloco);
    if (error) { console.error(`  erro no bloco: ${error.message}`); continue; }
    devolvidos += bloco.length;
  }
  console.log(`\nreenfileirados: ${devolvidos}`);
  console.log('Se o lote estiver pausado pelo disjuntor, ele ainda precisa ser retomado para publicar.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
