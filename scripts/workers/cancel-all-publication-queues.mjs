#!/usr/bin/env node
//
// Cancela a fila de publicação inteira, perfil a perfil, pelo fluxo sancionado.
//
// POR QUE ISSO EXISTE. Em 04/09/2026 a Zernio suspendeu 2.004 das 2.166 contas
// (100% da Pomodoro, 88% da Vini) e o sistema vai migrar para a API da Meta. A
// fila de 152.918 itens agendados não faz mais sentido e será regerada depois
// da migração.
//
// POR QUE NÃO UM `UPDATE` CRU. `cancel_publication_queue_scope` faz muito mais
// do que trocar o status: libera reservas diárias e de taxa, cancela jobs de
// geração, atualiza os lotes afetados e registra os eventos de auditoria. Um
// UPDATE direto deixaria todo esse rastro sujo — reservas fantasma segurando
// capacidade e lotes marcados como ativos sem item nenhum.
//
// SOBRE A AUTORIZAÇÃO. `begin_publication_queue_cancellation` exige `auth.uid()`
// porque nasceu para ser chamada pelo navegador. Aqui a linha de operação é
// inserida direto com service_role, com `requested_by` apontando para o admin
// real da organização — que é exatamente o que a RPC gravaria. A execução usa
// `execute_server_publication_queue_cancellation`, que repõe os claims desse
// usuário, então ator, eventos e auditoria continuam corretos.
//
// A execução é fatiada pelo próprio banco: um escopo grande devolve
// `status: 'running'` com progresso parcial, porque não cabe no statement
// timeout. O laço abaixo chama de novo até sair de 'running'.
//
// USO:
//   node scripts/workers/cancel-all-publication-queues.mjs           # simula
//   node scripts/workers/cancel-all-publication-queues.mjs --apply   # executa

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
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
const ACTIVE = ['waiting', 'ready', 'preparing', 'publishing'];
/** Baixa de propósito: o pool do PostgREST tem 41 conexões e cada execução é
 *  uma transação longa. Ver seção 3-B de docs/fila-de-publicacao-mapa-de-controles.md. */
const CONCURRENCY = 4;
/** Teto de chamadas por perfil. O banco fatia sozinho; isto só evita laço infinito. */
const MAX_ROUNDS = 40;

async function activeCount(organizationId) {
  const { count, error } = await supabase.from('publication_items')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', organizationId).in('status', ACTIVE);
  if (error) throw error;
  return count ?? 0;
}

// Ordem total por (profile_id, id): sem ela, paginar por range repete linhas e
// perde outras — a armadilha que já invalidou medições neste projeto.
async function profilesWithWork(organizationId) {
  const seen = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('publication_items').select('profile_id')
      .eq('organization_id', organizationId).in('status', ACTIVE)
      .order('profile_id', { ascending: true }).order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    for (const row of data ?? []) seen.add(row.profile_id);
    if ((data?.length ?? 0) < 1000) break;
  }
  return [...seen];
}

async function cancelProfile(organizationId, requestedBy, profileId) {
  // Retoma a operação que já existe em 'running' para este perfil, em vez de
  // abrir outra. Uma execução interrompida no meio (foi o que aconteceu em
  // 04/09, quando o gatilho de organização barrou 1.155 perfis) deixa a linha
  // durável para trás, e `begin_publication_queue_cancellation` devolveria
  // justamente essa quando chamada pela tela. Criar uma segunda faria a
  // interface mostrar progresso de uma operação que ninguém está executando.
  const { data: existing } = await supabase
    .from('publication_queue_cancellation_operations')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('scope', 'account')
    .eq('target_id', profileId)
    .eq('status', 'running')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let operation = existing;
  if (!operation) {
    const { data: created, error: insertError } = await supabase
      .from('publication_queue_cancellation_operations')
      .insert({
        organization_id: organizationId,
        requested_by: requestedBy,
        idempotency_key: randomUUID(),
        scope: 'account',
        target_id: profileId,
      })
      .select('id')
      .single();
    if (insertError) return { profileId, state: 'erro', reason: insertError.message };
    operation = created;
  }

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const { error } = await supabase.rpc('execute_server_publication_queue_cancellation', {
      p_operation_id: operation.id,
    });
    if (error) return { profileId, state: 'erro', reason: error.message };
    const { data: row } = await supabase
      .from('publication_queue_cancellation_operations')
      .select('status, progress, result').eq('id', operation.id).maybeSingle();
    if (row?.status !== 'running') {
      return { profileId, state: row?.status ?? 'desconhecido', cancelled: row?.result?.cancelledItems ?? null };
    }
  }
  return { profileId, state: 'incompleto', reason: `nao terminou em ${MAX_ROUNDS} rodadas` };
}

async function main() {
  const { data: orgs, error: orgError } = await supabase.from('organizations').select('id, name');
  if (orgError) throw orgError;
  const { data: members, error: memberError } = await supabase
    .from('organization_members').select('user_id, organization_id, role').range(0, 999);
  if (memberError) throw memberError;

  const plano = [];
  for (const org of orgs ?? []) {
    const total = await activeCount(org.id);
    if (!total) continue;
    const admin = (members ?? []).find((m) => m.organization_id === org.id && ['admin', 'operator'].includes(m.role));
    if (!admin) { console.error(`  ${org.name}: SEM admin/operator — pulando`); continue; }
    const profiles = await profilesWithWork(org.id);
    plano.push({ org, admin, profiles, total });
  }

  console.log('=== PLANO ===');
  let totalItens = 0, totalPerfis = 0;
  for (const p of plano) {
    console.log(`  ${p.org.name}: ${p.total} itens em ${p.profiles.length} perfis (solicitante ${p.admin.user_id.slice(0, 8)})`);
    totalItens += p.total; totalPerfis += p.profiles.length;
  }
  console.log(`  TOTAL: ${totalItens} itens, ${totalPerfis} perfis`);

  if (!apply) {
    console.log('\nSimulacao. Nada foi cancelado. Rode com --apply para executar.');
    return;
  }

  console.log('\n=== EXECUTANDO ===');
  const inicio = Date.now();
  for (const p of plano) {
    let feitos = 0, erros = 0;
    let index = 0;
    async function worker() {
      for (;;) {
        const i = index; index += 1;
        if (i >= p.profiles.length) return;
        const r = await cancelProfile(p.org.id, p.admin.user_id, p.profiles[i]);
        if (r.state === 'erro' || r.state === 'incompleto') {
          erros += 1;
          if (erros <= 5) console.error(`    ${r.profileId}: ${r.state} — ${r.reason}`);
        }
        feitos += 1;
        if (feitos % 100 === 0) {
          const restante = await activeCount(p.org.id);
          console.log(`    ${p.org.name}: ${feitos}/${p.profiles.length} perfis · ${restante} itens ainda ativos · ${erros} erros`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const restante = await activeCount(p.org.id);
    console.log(`  ${p.org.name}: CONCLUIDO — ${feitos} perfis, ${erros} erros, ${restante} itens ainda ativos`);
  }
  console.log(`\nTempo total: ${((Date.now() - inicio) / 60000).toFixed(1)} min`);
  for (const p of plano) console.log(`  ${p.org.name}: ${await activeCount(p.org.id)} itens ativos restantes`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
