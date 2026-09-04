#!/usr/bin/env node
//
// Renova os tokens de longa duração da Meta antes de eles saírem da janela.
//
// POR QUE ISSO EXISTE, e por que não é opcional. O token vale 60 dias e
// `GET /refresh_access_token` estende por mais 60, servidor a servidor, sem o
// usuário ver nada. Mas a documentação da Meta é explícita: "tokens that have
// not been refreshed in 60 days will expire and can no longer be refreshed".
// Passou do prazo, o refresh também morre — e aí é OAuth manual, perfil por
// perfil. Com a frota migrada, isso seria ~3.300 reautorizações.
//
// NEM A POLÍTICA NEM A CHAMADA À META MORAM AQUI. Este worker é a varredura:
// decide QUEM entra no ciclo e relata o resultado.
//
//   * o que é "renovar" vem de `lib/integrations/meta-token-renewal.ts`;
//   * a renovação em si vem de `refreshMetaProfileTokens`, em
//     `lib/integrations/meta-token-refresh.ts` — a mesma função que os botões da
//     tela chamam.
//
// A primeira versão deste arquivo reimplementava a chamada. Funcionava, mas
// duplicava o tratamento de `reauthorization_required` e a gravação das quatro
// colunas. Duas implementações da mesma regra divergem na primeira mudança de
// política, e aqui isso seria pior que o normal: o worker roda sozinho de
// madrugada, então a divergência só apareceria como frota vencendo com o painel
// verde.
//
// SOBRE A ORDEM DA VARREDURA: `(organization_id, token_refreshed_at, id)`. O
// prefixo casa com o índice `instagram_profiles_meta_token_renewal_idx`, e o
// `id` no fim é o que torna a ordem TOTAL — sem ele, paginar por `.range()`
// repete linhas e perde outras, a armadilha que já invalidou medições neste
// projeto (ver CLAUDE.md).
//
//
// IMPORTS RELATIVOS, e nao pelo alias `@/`: este worker roda na VPS com `node`
// puro. O Node 22 faz type stripping nativo de `.ts`, mas NAO resolve o alias do
// tsconfig -- e a VPS nao tem tsx instalado (65 workers la sao `.mjs`). Caminho
// relativo e o que permite compartilhar a politica de
// lib/integrations/meta-token-renewal.ts em vez de duplicar os limiares num
// `.mjs` separado, que e exatamente o jeito de os dois lados divergirem sem
// ninguem perceber.
//
// USO:
//   node scripts/workers/meta-token-renewal-worker.ts           # só relatório
//   node scripts/workers/meta-token-renewal-worker.ts --apply   # renova

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

type ProfileRow = {
  id: string;
  username: string;
  organization_id: string;
  provider: string;
  encrypted_access_token: string | null;
  token_expires_at: string | null;
  token_refreshed_at: string | null;
  token_refresh_attempted_at: string | null;
  token_refresh_error: string | null;
  token_refresh_failure_count: number | null;
};

async function main() {
  const { createSupabaseAdminClient } = await import('../../lib/supabase/admin.ts');
  const { refreshMetaProfileTokens } = await import('../../lib/integrations/meta-token-refresh.ts');
  const {
    metaTokenRenewalState,
    metaTokenRenewalLabel,
    summarizeMetaTokenFleet,
  } = await import('../../lib/integrations/meta-token-renewal.ts');

  const apply = process.argv.includes('--apply');

  const admin = createSupabaseAdminClient();
  const now = Date.now();

  const profiles: ProfileRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from('instagram_profiles')
      .select('id, username, organization_id, provider, encrypted_access_token, token_expires_at, token_refreshed_at, token_refresh_attempted_at, token_refresh_error, token_refresh_failure_count')
      .eq('provider', 'meta_official')
      .is('deleted_at', null)
      .order('organization_id', { ascending: true })
      .order('token_refreshed_at', { ascending: true, nullsFirst: true })
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`Não foi possível ler os perfis: ${error.message}`);
    profiles.push(...(data ?? []) as ProfileRow[]);
    if ((data?.length ?? 0) < 1000) break;
  }

  const fleet = summarizeMetaTokenFleet(profiles, now);
  console.log('=== FROTA meta_official ===');
  console.log(`  total ${fleet.total} · saudáveis ${fleet.healthy} · a renovar ${fleet.due} · em risco ${fleet.atRisk} · vencidos ${fleet.expired} · sem idade ${fleet.unknown} · falhando ${fleet.failing}`);

  const pendentes = profiles.filter((profile) => metaTokenRenewalState(profile, now).due);
  const vencidos = profiles.filter((profile) => metaTokenRenewalState(profile, now).health === 'expired');
  const semIdade = profiles.filter((profile) => metaTokenRenewalState(profile, now).health === 'unknown');

  if (vencidos.length) {
    console.log(`\n  ATENCAO: ${vencidos.length} perfil(is) fora da janela de renovacao — exigem reconexao manual:`);
    for (const profile of vencidos.slice(0, 20)) console.log(`    ${profile.username}`);
  }
  if (semIdade.length) {
    console.log(`\n  ${semIdade.length} perfil(is) sem idade conhecida. Nao serao renovados as cegas:`);
    console.log('    a Meta recusa refresh abaixo de 24 h, e a falha contaria contra o perfil sem motivo.');
  }

  if (!pendentes.length) {
    console.log('\nNenhum token a renovar neste ciclo.');
    return;
  }

  console.log(`\n=== A RENOVAR: ${pendentes.length} ===`);
  for (const profile of pendentes.slice(0, 10)) {
    console.log(`  ${profile.username.padEnd(28)} ${metaTokenRenewalLabel(metaTokenRenewalState(profile, now))}`);
  }
  if (pendentes.length > 10) console.log(`  ... e mais ${pendentes.length - 10}`);

  if (!apply) {
    console.log('\nSimulacao. Nada foi renovado. Rode com --apply para executar.');
    return;
  }

  console.log('\n=== RENOVANDO ===');

  // Agrupado por organização porque é assim que `refreshMetaProfileTokens`
  // recebe — e a checagem do vínculo perfil/organização, que ela faz antes de
  // tocar em credencial, sumiria se o worker passasse ids soltos.
  const porOrganizacao = new Map<string, string[]>();
  for (const profile of pendentes) {
    const atual = porOrganizacao.get(profile.organization_id) ?? [];
    atual.push(profile.id);
    porOrganizacao.set(profile.organization_id, atual);
  }

  let renovados = 0;
  let pulados = 0;
  let falhas = 0;
  let reautorizar = 0;

  for (const [organizationId, profileIds] of porOrganizacao) {
    const resultado = await refreshMetaProfileTokens(admin, { organizationId, profileIds, concurrency: 4 });
    renovados += resultado.refreshed;
    pulados += resultado.skipped;
    falhas += resultado.failed;
    reautorizar += resultado.needsReauthorization;

    for (const outcome of resultado.outcomes) {
      if (outcome.status === 'failed') {
        console.error(`  ${outcome.username || outcome.profileId}: ${outcome.message}${outcome.needsReauthorization ? '  <<< EXIGE RECONEXAO' : ''}`);
      } else if (outcome.status === 'skipped') {
        console.log(`  ${outcome.username || outcome.profileId}: pulado (${outcome.reason}) — ${outcome.message}`);
      }
    }
    console.log(`  organizacao ${organizationId.slice(0, 8)}: ${resultado.refreshed} renovados, ${resultado.skipped} pulados, ${resultado.failed} falhas`);
  }

  console.log(`\n=== RESULTADO: ${renovados} renovados · ${pulados} pulados · ${falhas} falhas ===`);
  if (reautorizar) {
    console.log(`  ${reautorizar} perfil(is) marcado(s) como reauthorization_required: a Meta recusou a`);
    console.log('  autorizacao, entao renovar nao resolve. Eles aparecem na tela para reconexao.');
  }
  if (falhas && !reautorizar) {
    console.log('  Falhas sem exigir reconexao sao transitorias: a proxima varredura tenta de novo.');
  }
  // Falha isolada nao derruba o processo: sob cron do PM2, sair != 0 so polui o
  // status sem ninguem agir. Reservado para o caso de NADA ter sido renovado
  // apesar de haver trabalho.
  process.exitCode = falhas && !renovados ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
