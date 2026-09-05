#!/usr/bin/env node
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

/**
 * Confere, contra a API real da Meta, o que a coleta de métricas recebe.
 *
 * POR QUE ELE EXISTE. A disponibilidade de métrica na Graph API muda por versão
 * e por tipo de conta, e a documentação não acompanha na mesma velocidade. Em
 * vez de cravar no código a lista "certa" de métricas — que envelhece sem
 * avisar e devolve zero em silêncio —, a coleta negocia a lista com a própria
 * Meta (ver `unsupportedMetricsFromError`), e este script mostra o resultado
 * dessa negociação para uma conta de verdade.
 *
 * Rode-o UMA VEZ antes de ligar o cron, e de novo sempre que a Meta subir de
 * versão. Ele é a diferença entre "a coleta está ligada" e "a coleta está
 * trazendo número".
 *
 *   npm run probe:meta-analytics                    # primeiro perfil online
 *   npm run probe:meta-analytics -- --profile=@joao
 *   npm run probe:meta-analytics -- --days=3
 *   npm run probe:meta-analytics -- --apply         # grava o que coletou
 *
 * Sem `--apply` ele NÃO escreve nada: lê o token, chama a Meta e imprime.
 * O token nunca é impresso.
 */

import { collectMetaProfileAnalytics, lastMetaRateHeaders, probeDayInsightsRaw, probeInsightsWindow, probeBatchedMediaInsights,
  probeGraphBatch,
  probeMediaInsights, type MetaAnalyticsProfile } from '../../lib/integrations/meta-analytics';
import { runMetaAnalyticsRefresh } from '../../lib/integrations/meta-analytics-refresh';
import { createSupabaseAdminClient } from '../../lib/supabase/admin';

function saoPauloHoje() {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const valor = (tipo: Intl.DateTimeFormatPartTypes) => partes.find((parte) => parte.type === tipo)?.value ?? '';
  return `${valor('year')}-${valor('month')}-${valor('day')}`;
}

function argValue(name: string) {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}

async function main() {
  const admin = createSupabaseAdminClient();
  const requested = argValue('profile');
  const days = Number(argValue('days') ?? 2);
  const apply = process.argv.includes('--apply');

  let query = admin
    .from('instagram_profiles')
    .select('id, organization_id, username, instagram_user_id, encrypted_access_token, status')
    .eq('provider', 'meta_official')
    .is('deleted_at', null)
    .limit(1);

  if (requested?.match(/^[0-9a-f-]{36}$/i)) query = query.eq('id', requested);
  else if (requested) query = query.eq('username', requested.replace(/^@/, ''));
  else query = query.eq('status', 'online');

  const { data, error } = await query;
  if (error) throw error;
  const profile = (data ?? [])[0] as (MetaAnalyticsProfile & { status: string }) | undefined;
  if (!profile) {
    console.error('Nenhum perfil meta_official encontrado com esse critério.');
    process.exit(1);
  }

  console.log(`Perfil: @${profile.username} (${profile.id}) · situação ${profile.status}`);
  console.log(`Token salvo: ${profile.encrypted_access_token ? 'sim' : 'NÃO — a coleta pula este perfil'}`);
  console.log(`Janela: ${days} dia(s), uma chamada por dia.\n`);

  const collection = await collectMetaProfileAnalytics(profile, { days, collectPosts: true, collectToday: process.argv.includes('--hoje') });

  console.log(`Situação da coleta: ${collection.status}`);
  if (collection.failure) console.log(`Falha: [${collection.failure.code}] ${collection.failure.message}`);
  console.log(`Seguidores: ${collection.followersCount ?? '—'} · mídias na conta: ${collection.mediaCount ?? '—'}`);
  console.log(`Uso do app (X-App-Usage): ${collection.appUsagePercent ?? '—'}%`);
  console.log(`Duração: ${collection.durationMs} ms`);
  if (collection.partialSources.length) console.log(`Fontes parciais: ${collection.partialSources.join(', ')}`);

  console.log('\nTotais da janela, métrica a métrica:');
  const totals = Object.entries(collection.windowTotals);
  if (totals.length === 0) console.log('  (nenhuma — é isto que este script existe para descobrir)');
  for (const [name, value] of totals) console.log(`  ${name.padEnd(20)} ${value}`);

  console.log('\nLinhas diárias que seriam gravadas:');
  if (collection.dailyRows.length === 0) console.log('  (nenhuma)');
  for (const row of collection.dailyRows) {
    console.log(`  ${row.metric_date}  views=${row.views} reach=${row.reach} likes=${row.likes} coment=${row.comments} interações=${row.interactions}`);
  }

  if (collection.todayRow) {
    const t = collection.todayRow;
    console.log(`\nLinha do DIA CORRENTE (somada dos posts): views=${t.views} reach=${t.reach} likes=${t.likes} interacoes=${t.interactions} posts=${t.posts}`);
  } else if (process.argv.includes('--hoje')) {
    console.log('\nLinha do DIA CORRENTE: nenhuma (sem metrica ainda -- e nao vira linha de zeros)');
  }

  console.log(`\nMídias lidas: ${collection.posts.length}`);
  for (const post of collection.posts.slice(0, 3)) {
    console.log(`  ${post.timestamp ?? '—'}  ${post.mediaType ?? '—'}  curtidas=${post.likes} coment=${post.comments}`);
  }

  if (process.argv.includes('--raw')) {
    console.log('\nResposta crua da Meta, dia a dia:');
    for (let offset = 0; offset < days; offset += 1) {
      const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(Date.now() - offset * 86_400_000));
      console.log(JSON.stringify(await probeDayInsightsRaw(profile, dia), null, 2));
    }
  }

  if (process.argv.includes('--janelas')) {
    // Bateria de janelas contra a MESMA conta, para descobrir a regra real da
    // API em vez de deduzi-la de uma medição só. A pergunta que ela responde:
    // o dia corrente não vem porque o dia está aberto, ou porque a janela que
    // pedimos é curta/estranha demais?
    const agora = Math.floor(Date.now() / 1000);
    const hoje0 = Math.floor(Date.parse(`${saoPauloHoje()}T00:00:00-03:00`) / 1000);
    const ontem0 = hoje0 - 86_400;
    const casos: Array<[string, Parameters<typeof probeInsightsWindow>[1]]> = [
      ['A. hoje 00:00 -> agora', { since: hoje0, until: agora }],
      ['B. ontem 00:00 -> agora (atravessa a virada)', { since: ontem0, until: agora }],
      ['C. sem since/until (o padrão da API)', {}],
      ['D. hoje 00:00 -> hoje+24h (janela no futuro)', { since: hoje0, until: hoje0 + 86_400 }],
      ['E. últimas 24h corridas', { since: agora - 86_400, until: agora }],
      ['F. ontem 00:00 -> agora, em série temporal', { since: ontem0, until: agora, metricType: 'time_series' }],
      ['G. ontem fechado (controle)', { since: ontem0, until: hoje0 }],
      ['H. 4 dias em série temporal (fronteira dos baldes)', { since: hoje0 - 3 * 86_400, until: agora, metricType: 'time_series' }],
      ['I. série temporal com o conjunto completo', { since: hoje0 - 2 * 86_400, until: agora, metricType: 'time_series', metrics: ['reach', 'views', 'likes', 'comments', 'shares', 'saves', 'total_interactions'] }],
      ['J. série temporal só do que costuma aceitar', { since: hoje0 - 2 * 86_400, until: agora, metricType: 'time_series', metrics: ['reach'] }],
    ];
    console.log('\nBateria de janelas:');
    for (const [nome, opcoes] of casos) {
      const resultado = await probeInsightsWindow(profile, opcoes);
      const corpo = (resultado as { body?: { data?: unknown[]; error?: { message?: string } } }).body;
      const linhas = Array.isArray(corpo?.data) ? corpo.data : [];
      const resumo = corpo?.error
        ? `ERRO: ${corpo.error.message}`
        : linhas.length === 0
          ? 'vazio'
          : linhas.map((entrada) => {
            const item = entrada as { name?: string; total_value?: { value?: number }; values?: Array<{ value?: number; end_time?: string }> };
            if (item.total_value) return `${item.name}=${item.total_value.value}`;
            return `${item.name}=[${(item.values ?? []).map((v) => `${v.end_time}:${v.value}`).join(' ')}]`;
          }).join('  ');
      console.log(`  ${nome.padEnd(46)} ${resumo}`);
    }
  }

  if (process.argv.includes('--midias')) {
    // A pergunta: a métrica de um post publicado HOJE existe agora?
    console.log('\nInsights por mídia (posts mais recentes):');
    for (const post of collection.posts.slice(0, 4)) {
      for (const conjunto of [['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions'], ['reach', 'likes'], ['plays', 'reach']]) {
        const resultado = await probeMediaInsights(profile, post.mediaId, conjunto);
        const corpo = (resultado as { body?: { data?: unknown[]; error?: { message?: string } } }).body;
        if (corpo?.error) {
          console.log(`  ${post.timestamp} [${conjunto.join(',')}] ERRO: ${corpo.error.message?.slice(0, 120)}`);
          continue;
        }
        const linhas = (corpo?.data ?? []) as Array<{ name?: string; values?: Array<{ value?: number }> }>;
        console.log(`  ${post.timestamp} ${linhas.map((l) => `${l.name}=${l.values?.[0]?.value}`).join(' ')}`);
        break;
      }
    }
  }

  if (process.argv.includes('--limites')) {
    console.log('\nCabeçalhos de limite da última chamada:');
    for (const [nome, valor] of Object.entries(lastMetaRateHeaders())) {
      console.log(`  ${nome.padEnd(28)} ${valor ?? '(ausente)'}`);
    }
  }

  if (process.argv.includes('--lote')) {
    const ids = collection.posts.slice(0, 3).map((post) => post.mediaId);
    console.log('\nChamada em lote (?ids=) para', ids.length, 'midias:');
    console.log(JSON.stringify(await probeBatchedMediaInsights(profile, ids), null, 2).slice(0, 1800));
  }

  if (process.argv.includes('--batch')) {
    const ids = collection.posts.slice(0, 3).map((post) => post.mediaId);
    console.log('\nEndpoint de lote oficial (batch=[...]) para', ids.length, 'midias:');
    console.log(JSON.stringify(await probeGraphBatch(profile, ids), null, 2).slice(0, 1500));
  }

  if (apply) {
    const summary = await runMetaAnalyticsRefresh({
      organizationId: profile.organization_id,
      profileIds: [profile.id],
      staleMinutes: 0,
      days,
      collectPosts: true,
      limit: 1,
    });
    console.log('\nGravado:', JSON.stringify(summary, null, 2));
  } else {
    console.log('\nNada foi gravado. Use --apply para persistir.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
