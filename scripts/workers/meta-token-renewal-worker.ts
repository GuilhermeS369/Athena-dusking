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
// A POLÍTICA NÃO MORA AQUI. Os limiares estão em
// `lib/integrations/meta-token-renewal.ts`, com testes, e são compartilhados com
// a interface. Este worker só executa o que `metaTokenRenewalState` decide, para
// a tela e o worker nunca discordarem sobre o que é "renovado" — que é
// exatamente o tipo de divergência que faz um painel verde conviver com uma
// frota vencendo.
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
  const { decryptToken, encryptToken } = await import('../../lib/security/token-crypto.ts');
  const { META_GRAPH_API_VERSION } = await import('../../lib/integrations/meta-oauth.ts');
  const {
    metaTokenRenewalState,
    metaTokenRenewalLabel,
    summarizeMetaTokenFleet,
  } = await import('../../lib/integrations/meta-token-renewal.ts');

  const apply = process.argv.includes('--apply');
  /** Baixa por educação com a Meta, não por limitação nossa: são ~100 refreshes por app. */
  const CONCURRENCY = 4;

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
  let renovados = 0;
  let falhas = 0;
  let index = 0;

  async function worker() {
    for (;;) {
      const i = index; index += 1;
      if (i >= pendentes.length) return;
      const profile = pendentes[i];
      const attemptedAt = new Date().toISOString();

      let motivo: string | null = null;
      try {
        if (!profile.encrypted_access_token) throw new Error('Perfil sem token armazenado.');
        const token = decryptToken(profile.encrypted_access_token);
        const url = `https://graph.instagram.com/${META_GRAPH_API_VERSION}/refresh_access_token?${new URLSearchParams({
          grant_type: 'ig_refresh_token',
          access_token: token,
        })}`;
        const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
        const body = await response.json().catch(() => ({})) as {
          access_token?: string;
          expires_in?: number;
          error?: { message?: string; code?: number };
        };

        if (!response.ok || !body.access_token) {
          // A mensagem da Meta entra no registro; o token, nunca.
          motivo = `HTTP ${response.status}${body.error?.code ? ` (código ${body.error.code})` : ''}: ${body.error?.message ?? 'resposta sem access_token'}`;
        } else {
          // A JANELA PERIGOSA DESTE WORKER está aqui, e é curta mas real: a Meta
          // já emitiu o token novo e ele só existe nesta variável. Se a gravação
          // falhar, o perfil fica com o token antigo no banco enquanto o novo se
          // perde — e não dá para registrar o token no log para recuperar depois,
          // porque credencial não vai para log.
          //
          // Por isso a gravação insiste antes de desistir. Uma indisponibilidade
          // momentânea do PostgREST (aconteceu nesta operação em 02/09, com o
          // pool esgotado) não pode custar a credencial de um perfil.
          const refreshedAt = new Date().toISOString();
          const patch = {
            encrypted_access_token: encryptToken(body.access_token),
            token_expires_at: body.expires_in
              ? new Date(Date.now() + body.expires_in * 1000).toISOString()
              : null,
            token_refreshed_at: refreshedAt,
            token_refresh_attempted_at: refreshedAt,
            token_refresh_error: null,
            token_refresh_failure_count: 0,
          };
          let gravou = false;
          let ultimoErro = '';
          for (let tentativa = 1; tentativa <= 4 && !gravou; tentativa += 1) {
            const { error } = await admin.from('instagram_profiles').update(patch).eq('id', profile.id);
            if (!error) { gravou = true; break; }
            ultimoErro = error.message;
            if (tentativa < 4) await new Promise((resolve) => setTimeout(resolve, tentativa * 2000));
          }
          if (!gravou) {
            motivo = `TOKEN NOVO PERDIDO — a Meta renovou mas a gravação falhou 4 vezes: ${ultimoErro}. `
              + 'O perfil segue com o token anterior; a próxima varredura tenta de novo.';
          }
        }
      } catch (error) {
        motivo = error instanceof Error ? error.message : String(error);
      }

      if (motivo) {
        falhas += 1;
        // A contagem sobe mesmo quando a gravação do sucesso falha: do ponto de
        // vista do perfil, o ciclo não terminou, e o número serve para achar
        // quem está travado, não para atribuir culpa.
        await admin.from('instagram_profiles').update({
          token_refresh_attempted_at: attemptedAt,
          token_refresh_error: motivo.slice(0, 500),
          token_refresh_failure_count: (profile.token_refresh_failure_count ?? 0) + 1,
        }).eq('id', profile.id);
        if (falhas <= 10) console.error(`  ${profile.username}: ${motivo}`);
      } else {
        renovados += 1;
      }

      const feitos = renovados + falhas;
      if (feitos % 100 === 0) console.log(`  ${feitos}/${pendentes.length} · ${renovados} renovados · ${falhas} falhas`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\n=== RESULTADO: ${renovados} renovados, ${falhas} falhas ===`);
  if (falhas) {
    console.log('  As falhas ficam em token_refresh_error e token_refresh_failure_count.');
    console.log('  Um perfil que falha varios ciclos seguidos caminha para fora da janela: vale olhar antes dos 35 dias.');
  }
  process.exitCode = falhas && !renovados ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
