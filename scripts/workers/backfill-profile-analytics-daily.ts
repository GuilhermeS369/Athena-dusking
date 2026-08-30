#!/usr/bin/env node
//
// Reparo pontual de lacunas em profile_analytics_daily_metrics.
//
// POR QUE ISSO EXISTE. O ciclo operacional coleta só os últimos quatro dias.
// Quando a coleta fica bloqueada por mais tempo que isso — foi o que acontecia
// enquanto o analytics cedia a qualquer atraso de publicação — o dia perdido
// nunca mais é buscado, porque nenhum ciclo volta lá. Este script compara o que
// a Zernio tem com o que está no banco e insere só as datas ausentes.
//
// QUAL ERA O TAMANHO DO PROBLEMA (30/08/2026, organização com 1.088 perfis
// coletáveis): 7 linhas. Uma primeira medição minha sugeriu ~166 dias faltando,
// mas era artefato de paginação não determinística no próprio script — ordenar
// profile_analytics_daily_metrics só por metric_date devolveu 7.151 linhas com
// 6.942 distintas, e cada linha perdida virava um "dia faltando" inexistente.
// Corrigida a ordenação (chave primária completa), a organização inteira fica em
// zero lacunas. Ou seja: com a coleta rodando, a janela de quatro dias basta.
//
// Use depois de um período em que a coleta ficou parada, ou ao importar contas
// com histórico anterior de mais de três dias. Não precisa de agendamento.
//
// Uso:
//   npx tsx scripts/workers/backfill-profile-analytics-daily.ts --organization=<uuid>
//   ... --apply          grava (sem isso é simulação, que é o padrão)
//   ... --days=30        janela consultada na Zernio (1 a 89)
//   ... --limit=200      máximo de perfis
//   ... --concurrency=4  chamadas simultâneas à Zernio
//
// Somente leitura na Zernio; escreve apenas em profile_analytics_daily_metrics,
// e só as datas ausentes. Nunca sobrescreve linha existente.

import fs from 'node:fs';
import process from 'node:process';

for (const filePath of ['.env.local', '.env.worker']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const separator = rawLine.indexOf('=');
    if (separator <= 0 || rawLine.trim().startsWith('#')) continue;
    const key = rawLine.slice(0, separator).trim();
    if (process.env[key]) continue;
    process.env[key] = rawLine.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

async function main() {
  const { createSupabaseAdminClient } = await import('../../lib/supabase/admin.ts');
  const { createZernioClientForConnection } = await import('../../lib/integrations/zernio-client.ts');
  const { normalizedDailyMetrics } = await import('../../lib/integrations/zernio-analytics-normalizers.ts');

  function argument(name: string) {
    const found = process.argv.find((value) => value.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : null;
  }

  function integerArgument(name: string, fallback: number, minimum: number, maximum: number) {
    const parsed = Number.parseInt(argument(name) ?? '', 10);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(Math.max(parsed, minimum), maximum);
  }

  const organizationId = argument('organization');
  const apply = process.argv.includes('--apply');
  const days = integerArgument('days', 30, 1, 89);
  const limit = integerArgument('limit', 2000, 1, 5000);
  const concurrency = integerArgument('concurrency', 4, 1, 8);

  if (!organizationId) throw new Error('--organization=<uuid> é obrigatório.');

  const admin = createSupabaseAdminClient();

  function saoPauloDate(daysAgo = 0) {
    const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
    return `${value('year')}-${value('month')}-${value('day')}`;
  }

  // Paginação explícita: as duas tabelas crescem com o tamanho da organização e
  // o PostgREST corta silenciosamente no teto de linhas (ver CLAUDE.md).
  //
  // A ordenação precisa ser TOTAL. Ordenar profile_analytics_daily_metrics só
  // por metric_date parece funcionar e não é: medido em 30/08/2026 na janela de
  // 30 dias, as páginas devolveram 7.151 linhas com apenas 6.942 distintas —
  // 209 repetidas e outras 209 nunca vistas. O efeito aqui seria pior que uma
  // simples contagem errada: linha existente que a paginação perde vira "dia
  // faltando" e o script sai reparando o que já estava reparado.
  async function allRows<T>(table: string, columns: string, orders: string[], build: (query: any) => any): Promise<T[]> {
    const rows: T[] = [];
    for (let from = 0; ; from += 1000) {
      let query = build(admin.from(table).select(columns));
      for (const column of orders) query = query.order(column, { ascending: true });
      const { data, error } = await query.range(from, from + 999);
      if (error) throw error;
      rows.push(...(data as T[]));
      if ((data as T[]).length < 1000) break;
    }
    return rows;
  }

  type ProfileRow = {
    id: string;
    username: string;
    organization_id: string;
    provider: string;
    zernio_account_id: string | null;
    zernio_connection_id: string | null;
  };

  const periodEnd = saoPauloDate(0);
  const periodStart = saoPauloDate(days - 1);

  const profiles = (await allRows<ProfileRow>(
    'instagram_profiles',
    'id,username,organization_id,provider,zernio_account_id,zernio_connection_id',
    ['id'],
    (query) => query.eq('organization_id', organizationId).is('deleted_at', null),
  )).filter((profile) => profile.zernio_account_id && profile.zernio_connection_id).slice(0, limit);

  const existing = await allRows<{ profile_id: string; metric_date: string }>(
    'profile_analytics_daily_metrics',
    'profile_id,metric_date',
    // Chave primária da tabela, menos a organização já filtrada acima.
    ['metric_date', 'profile_id', 'provider'],
    (query) => query.eq('organization_id', organizationId).gte('metric_date', periodStart).lte('metric_date', periodEnd),
  );
  const knownDates = new Map<string, Set<string>>();
  for (const row of existing) {
    if (!knownDates.has(row.profile_id)) knownDates.set(row.profile_id, new Set());
    knownDates.get(row.profile_id)!.add(row.metric_date);
  }

  console.info('[backfill-daily] iniciando', { organizationId, periodStart, periodEnd, profiles: profiles.length, apply, concurrency });

  const clients = new Map<string, Awaited<ReturnType<typeof createZernioClientForConnection>>>();
  async function clientFor(connectionId: string) {
    if (!clients.has(connectionId)) clients.set(connectionId, await createZernioClientForConnection(organizationId!, connectionId));
    return clients.get(connectionId)!;
  }

  let comLacuna = 0;
  let diasGravados = 0;
  let erros = 0;
  const amostra: string[] = [];
  const queue = [...profiles];

  async function worker() {
    while (queue.length > 0) {
      const profile = queue.shift();
      if (!profile) return;
      try {
        const client = await clientFor(profile.zernio_connection_id!);
        const payload = await client.getDailyMetrics({
          platform: 'instagram',
          accountId: profile.zernio_account_id!,
          fromDate: periodStart,
          toDate: periodEnd,
          source: 'all',
        });
        const rows = normalizedDailyMetrics(payload, profile, 'complete');
        const known = knownDates.get(profile.id) ?? new Set<string>();
        const missing = rows.filter((row) => !known.has(String(row.metric_date)));
        if (missing.length === 0) continue;

        comLacuna += 1;
        diasGravados += missing.length;
        if (amostra.length < 10) amostra.push(`@${profile.username}: ${missing.map((row) => row.metric_date).join(', ')}`);

        if (apply) {
          const { error } = await admin
            .from('profile_analytics_daily_metrics')
            .upsert(missing, { onConflict: 'organization_id,profile_id,provider,metric_date', ignoreDuplicates: true });
          if (error) throw error;
        }
      } catch (error) {
        erros += 1;
        console.warn('[backfill-daily] falha isolada', { profile: profile.username, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  console.info('[backfill-daily] fim', {
    apply,
    perfisConsultados: profiles.length,
    perfisComLacuna: comLacuna,
    diasFaltando: diasGravados,
    erros,
  });
  if (amostra.length > 0) console.info('[backfill-daily] amostra:\n' + amostra.join('\n'));
  if (!apply) console.info('[backfill-daily] simulação — nada foi gravado. Repita com --apply para aplicar.');
}

main().catch((error) => {
  console.error('[backfill-daily] erro fatal', error);
  process.exitCode = 1;
});
