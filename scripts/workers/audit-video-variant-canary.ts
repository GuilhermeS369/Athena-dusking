#!/usr/bin/env tsx
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

/**
 * Compara o desempenho dos posts por receita de variante de video (migration 436):
 * `container`, `micro`, `light` e, opcionalmente, um grupo de CONTROLE que postou o
 * arquivo original. SO LEITURA: le a fila no banco e `/{media}/insights` na Meta.
 * Nao escreve em tabela nenhuma e nunca imprime token.
 *
 * POR QUE PELA META E NAO PELO BANCO. As views de `profile_post_analytics_snapshots`
 * congelam no dia do post e a coleta le so 25 posts por perfil -- nao servem para
 * "views em 24 h". A metrica por midia existe desde a publicacao.
 *
 * SO ENTRA POST MADURO. Comparar um post de 2 h com um de 20 h mede a idade, nao a
 * receita; por isso `--min-horas` (padrao 24) e o relatorio mostra a idade media
 * de cada grupo. Grupos com perfis de tamanho muito diferente tambem enganam: a
 * mediana por post e a media por perfil saem lado a lado.
 *
 * Uso:
 *   npm run audit:video-variants -- --min-horas=24
 *   npm run audit:video-variants -- --min-horas=24 --controle="NOME DO PLANO SEM VARIANTE"
 *   npm run audit:video-variants -- --max-posts=400      (teto de chamadas a Meta; padrao 600)
 */

import { probeMediaInsights, type MetaAnalyticsProfile } from '../../lib/integrations/meta-analytics';
import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { fetchAllRowsByIds } from '../../lib/supabase/chunk';
import { fetchAllRows } from '../../lib/supabase/paginate';

type PublishedRow = { id: string; profile_id: string; meta_media_id: string; published_at: string };
type Post = { itemId: string; profileId: string; mediaId: string; group: string; publishedAt: string };

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

const minHours = Math.max(0, Number(argument('min-horas') ?? 24));
const maxPosts = Math.min(Math.max(1, Number(argument('max-posts') ?? 600)), 5000);
const controlPlanName = argument('controle');

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function metricValue(body: unknown, name: string) {
  const data = (body as { data?: Array<{ name?: string; values?: Array<{ value?: number }>; total_value?: { value?: number } }> })?.data ?? [];
  const entry = data.find((item) => item.name === name);
  return Number(entry?.total_value?.value ?? entry?.values?.[0]?.value ?? 0);
}

async function main() {
  const supabase = createSupabaseAdminClient();
  const cutoff = new Date(Date.now() - minHours * 3_600_000).toISOString();

  // Posts publicados com variante. Ordem total pela PK da tabela lateral.
  const { data: variants, error: variantsError } = await fetchAllRows<{ publication_item_id: string; recipe: string }>((from, to) => supabase
    .from('publication_item_video_variants')
    .select('publication_item_id, recipe')
    .in('status', ['ready', 'deleted'])
    .order('publication_item_id', { ascending: true })
    .range(from, to));
  if (variantsError) throw variantsError;
  const recipeByItem = new Map(variants.map((row) => [row.publication_item_id, row.recipe]));

  const posts: Post[] = [];
  // Ordem total por id (PK) dentro de cada bloco de ids.
  const { data: published, error: publishedError } = await fetchAllRowsByIds<PublishedRow>([...recipeByItem.keys()], (chunk, from, to) => supabase
    .from('publication_items')
    .select('id, profile_id, meta_media_id, published_at')
    .in('id', chunk)
    .eq('status', 'published')
    .lte('published_at', cutoff)
    .not('meta_media_id', 'is', null)
    .order('id', { ascending: true })
    .range(from, to));
  if (publishedError) throw publishedError;
  for (const row of published) {
    posts.push({ itemId: row.id, profileId: row.profile_id, mediaId: row.meta_media_id, group: recipeByItem.get(row.id) ?? '?', publishedAt: row.published_at });
  }

  if (controlPlanName) {
    const { data: plan, error: planError } = await supabase
      .from('bulk_publication_plans')
      .select('id, batch_id, video_variant_recipe')
      .eq('name', controlPlanName)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (planError) throw planError;
    if (!plan) throw new Error(`Plano de controle não encontrado: ${controlPlanName}`);
    if (plan.video_variant_recipe) throw new Error('O plano de controle tem variante ligada; escolha um plano que postou o arquivo original.');
    const { data: control, error: controlError } = await fetchAllRows<PublishedRow>((from, to) => supabase
      .from('publication_items')
      .select('id, profile_id, meta_media_id, published_at')
      .eq('batch_id', plan.batch_id)
      .eq('status', 'published')
      .lte('published_at', cutoff)
      .not('meta_media_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to));
    if (controlError) throw controlError;
    for (const row of control) {
      posts.push({ itemId: row.id, profileId: row.profile_id, mediaId: row.meta_media_id, group: 'controle (original)', publishedAt: row.published_at });
    }
  }

  if (posts.length === 0) {
    console.log(`Nenhum post publicado há pelo menos ${minHours} h. Rode de novo mais tarde ou use --min-horas menor.`);
    return;
  }

  // Teto de chamadas a Meta, repartido por igual entre os grupos.
  const groups = [...new Set(posts.map((post) => post.group))];
  const perGroup = Math.max(1, Math.floor(maxPosts / groups.length));
  const sample = groups.flatMap((group) => posts.filter((post) => post.group === group).slice(0, perGroup));

  const profileIds = [...new Set(sample.map((post) => post.profileId))];
  const profiles = new Map<string, MetaAnalyticsProfile>();
  // Mesmo select do meta-analytics-probe.ts; o token so e decifrado dentro de probeMediaInsights.
  const { data: profileRows, error: profilesError } = await fetchAllRowsByIds<MetaAnalyticsProfile & { id: string }>(profileIds, (chunk, from, to) => supabase
    .from('instagram_profiles')
    .select('id, organization_id, username, instagram_user_id, encrypted_access_token, status')
    .in('id', chunk)
    .order('id', { ascending: true })
    .range(from, to));
  if (profilesError) throw profilesError;
  for (const row of profileRows) profiles.set(row.id, row);

  const results: Array<Post & { views: number; reach: number }> = [];
  let failures = 0;
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < sample.length) {
      const post = sample[cursor];
      cursor += 1;
      const profile = profiles.get(post.profileId);
      if (!profile) { failures += 1; continue; }
      try {
        const response = await probeMediaInsights(profile, post.mediaId, ['views', 'reach']);
        if ('erro' in response || response.httpStatus !== 200) { failures += 1; continue; }
        results.push({ ...post, views: metricValue(response.body, 'views'), reach: metricValue(response.body, 'reach') });
      } catch {
        failures += 1;
      }
    }
  }));

  console.log(`Posts com pelo menos ${minHours} h: ${posts.length} | lidos na Meta: ${results.length} | sem leitura: ${failures}`);
  console.table(groups.map((group) => {
    const rows = results.filter((row) => row.group === group);
    const byProfile = new Map<string, number[]>();
    for (const row of rows) byProfile.set(row.profileId, [...(byProfile.get(row.profileId) ?? []), row.views]);
    const profileAverages = [...byProfile.values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
    const ageHours = rows.map((row) => (Date.now() - new Date(row.publishedAt).getTime()) / 3_600_000);
    return {
      grupo: group,
      posts: rows.length,
      perfis: byProfile.size,
      views_mediana: Math.round(median(rows.map((row) => row.views))),
      views_media: Math.round(rows.reduce((sum, row) => sum + row.views, 0) / Math.max(1, rows.length)),
      media_por_perfil_mediana: Math.round(median(profileAverages)),
      alcance_mediana: Math.round(median(rows.map((row) => row.reach))),
      posts_com_zero_views: rows.filter((row) => row.views === 0).length,
      idade_media_h: Number((ageHours.reduce((sum, value) => sum + value, 0) / Math.max(1, ageHours.length)).toFixed(1)),
    };
  }));
  console.log('Leia a MEDIANA antes da média: um post que viraliza puxa a média de um grupo pequeno. Compare grupos de idade parecida.');
}

main().catch((error) => {
  console.error('[audit-video-variants] falhou', error instanceof Error ? error.message : error);
  process.exit(1);
});
