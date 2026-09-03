#!/usr/bin/env node
//
// Retoma lotes de importação Zernio que ficaram presos em `queued`/`processing`.
//
// POR QUE ISSO EXISTE. `processZernioConnectionImportBatch` é disparado pelo
// `after()` da rota — trabalho de fundo da Vercel, sem retentativa. Se o
// processo morre antes de terminar (foi o que aconteceu na queda de 02/09/2026,
// quando o pool do PostgREST esgotou e o banco parou de aceitar conexão), o lote
// fica em `queued` para sempre.
//
// E o estado é um beco sem saída pela interface: `app/zernio/zernio-client.tsx`
// só mostra "Retomar falhas" quando o lote está em `completed_with_errors`. Um
// lote preso em `queued` exibe "Aguardando a fila da organização"
// indefinidamente, sem nenhuma ação disponível.
//
// Pior, as chaves do lote seguem reservadas em `zernio_api_key_claims` com lease
// de 24 h, então recadastrar também falha — com "uma API key deste lote já está
// cadastrada ou sendo importada", enquanto a busca por essa conta não devolve
// nada, porque conexão nenhuma chegou a ser criada. Foi assim que o problema
// apareceu para o usuário.
//
// O QUE ESTE SCRIPT FAZ: encontra os lotes parados há mais tempo que o limiar e
// chama o mesmo processador que a rota chamaria. Nada é recriado — as chaves
// cifradas continuam no lote, e a reserva existente é do próprio lote, então o
// reprocessamento a converte em conexão em vez de esbarrar nela.
//
// USO:
//   npx tsx scripts/workers/recover-stuck-zernio-import-batches.ts            # lista
//   npx tsx scripts/workers/recover-stuck-zernio-import-batches.ts --apply    # retoma todos
//   npx tsx scripts/workers/recover-stuck-zernio-import-batches.ts --apply --batch <id>   # só um

import fs from 'node:fs';
import process from 'node:process';

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

// Os imports precisam vir DEPOIS do carregamento do .env acima -- o cliente admin
// lê as variáveis na importação --, e `await` de topo não sobrevive à
// transformação do tsx aqui. Daí o main() async com import dinâmico dentro.
async function main() {
  const { createSupabaseAdminClient } = await import('@/lib/supabase/admin');
  const { processZernioConnectionImportBatch } = await import('@/lib/integrations/zernio-connection-import-runner');

  const apply = process.argv.includes('--apply');
  // Alvo explícito. Sem ele, `--apply` retomaria TODO lote parado — inclusive
  // algum abandonado semanas atrás, cujas contas ninguém quer mais criar.
  const onlyIndex = process.argv.indexOf('--batch');
  const onlyBatchId = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;
  /** Um lote saudável termina em segundos. Dez minutos parado é anomalia, não fila. */
  const STALE_MINUTES = Number(process.env.ZERNIO_IMPORT_STALE_MINUTES ?? 10);

  const admin = createSupabaseAdminClient();
  const staleBefore = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();

  const { data: batches, error } = await admin
    .from('zernio_connection_import_batches')
    .select('id, organization_id, status, total_count, created_at, organizations(name)')
    .in('status', ['queued', 'processing'])
    .lt('created_at', staleBefore)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Não foi possível listar os lotes: ${error.message}`);

  const targets = onlyBatchId ? (batches ?? []).filter((batch) => batch.id === onlyBatchId) : (batches ?? []);
  if (onlyBatchId && !targets.length) {
    console.log(`Lote ${onlyBatchId} não está entre os presos.`);
    return;
  }

  if (!batches?.length) {
    console.log(`Nenhum lote preso há mais de ${STALE_MINUTES} min.`);
    return;
  }

  console.log(`${batches.length} lote(s) preso(s) há mais de ${STALE_MINUTES} min:\n`);
  for (const batch of batches) {
    const organizationName = (batch.organizations as { name?: string } | null)?.name ?? batch.organization_id;
    console.log(`  ${batch.id}  ${batch.status.padEnd(10)} ${String(batch.total_count).padStart(4)} item(ns)  ${batch.created_at.slice(0, 16).replace('T', ' ')}  ${organizationName}`);
  }

  if (!apply) {
    console.log('\nNada foi alterado. Rode de novo com --apply para retomar.');
    return;
  }

  // Exigir --batch quando há mais de um lote parado é proposital. Em 03/09 esta
  // guarda não existia, e uma execução que pretendia destravar UM lote retomou
  // também um abandonado seis dias antes, criando 4 contas Zernio que ninguém
  // tinha pedido. Provisionar conta é efeito externo: o alvo tem que ser dito,
  // não deduzido.
  if (!onlyBatchId && batches.length > 1) {
    console.error(`\n${batches.length} lotes parados. Informe --batch <id> para escolher qual retomar.`);
    console.error('Retomar um lote provisiona contas Zernio de verdade, então o alvo precisa ser explícito.');
    process.exitCode = 1;
    return;
  }

  console.log(`\nRetomando ${targets.length} de ${batches.length}...\n`);
  let recovered = 0;
  for (const batch of targets) {
    const organizationName = (batch.organizations as { name?: string } | null)?.name ?? '';
    try {
      // Em série, e não em paralelo: o processador pega uma trava de importação
      // por organização, então lotes concorrentes da mesma org só se atrapalhariam.
      await processZernioConnectionImportBatch(batch.id, organizationName);
      const { data: after } = await admin
        .from('zernio_connection_import_batches')
        .select('status, zernio_connection_import_items(status)')
        .eq('id', batch.id)
        .maybeSingle();
      const items = (after?.zernio_connection_import_items ?? []) as { status: string }[];
      const succeeded = items.filter((item) => item.status === 'succeeded').length;
      const failed = items.filter((item) => item.status === 'failed').length;
      console.log(`  ${batch.id}: ${after?.status} — ${succeeded} concluída(s), ${failed} falha(s)`);
      recovered += 1;
    } catch (processError) {
      console.error(`  ${batch.id}: FALHOU — ${processError instanceof Error ? processError.message : processError}`);
    }
  }
  console.log(`\n${recovered}/${targets.length} lote(s) reprocessado(s).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
