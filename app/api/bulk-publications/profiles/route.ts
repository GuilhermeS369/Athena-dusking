import type { PostgrestError } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import type { ComposerMetricRow } from '@/lib/publications/composer-metrics-fallback';

// Os tipos gerados não descrevem esta RPC como set-returning, então encadear
// .select() nela faz o TypeScript inferir "uma linha OU uma lista". O cast
// abaixo é só para reconciliar isso; em tempo de execução a função sempre
// devolve um conjunto, que é o que fetchAllRows pagina.
type ComposerMetricCounts = Pick<ComposerMetricRow, 'profile_id' | 'scheduled_counts' | 'published_counts'>;
import { fetchAllRows } from '@/lib/supabase/paginate';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  const organizationId = context.activeOrganization.id;
  const supabase = await createSupabaseServerClient();
  const [profilesResult, composerMetricsResult] = await Promise.all([
    // Organizations can hold more online profiles than PostgREST's default row cap (1000),
    // which would otherwise silently truncate this list.
    fetchAllRows((from, to) => supabase
      .from('instagram_profiles_safe')
      .select('id, username, display_name, profile_picture_url, provider')
      .eq('organization_id', organizationId)
      .eq('status', 'online')
      .is('deleted_at', null)
      // username não é único no banco; o desempate por id fecha a ordem total.
      .order('username', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)),
    // Mesmo teto de 1000 linhas da consulta acima, que aqui passou batido: com
    // 1.150 perfis online a RPC devolvia exatamente 1.000 linhas e os 150
    // restantes ficavam sem métrica, aparecendo como "0/0" no seletor mesmo
    // tendo dezenas de publicações agendadas. A função agrega por profile_id
    // mas não impõe ordem no resultado, e sem ordem determinística paginar
    // traria linhas repetidas e outras faltando — daí o order explícito.
    // Esta rota monta o payload apenas com publication_metrics e descarta os dois
    // arrays de horários da RPC — mas sem o select explícito abaixo ela puxava os
    // 4,88 MB inteiros do banco a cada chamada só para jogar 97% fora. Os arrays
    // scheduled_execute_ats e scheduled_execute_ats_by_format sozinhos são esses
    // 97%; pedindo só as contagens, a resposta cai para ~225 KB.
    fetchAllRows((from, to) => supabase
      .rpc('get_posting_composer_profile_metrics', {
        p_organization_id: organizationId,
        p_slot_horizon_days: 90,
      })
      .select('profile_id,scheduled_counts,published_counts')
      .order('profile_id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: ComposerMetricCounts[] | null; error: PostgrestError | null }>),
  ]);
  if (profilesResult.error) return NextResponse.json({ error: 'Não foi possível carregar os perfis online.' }, { status: 500 });
  if (composerMetricsResult.error) return NextResponse.json({ error: 'Não foi possível carregar as métricas dos perfis.' }, { status: 500 });

  const metrics = (composerMetricsResult.data ?? []) as ComposerMetricRow[];
  const metricsByProfileId = new Map(metrics.map((metric) => [metric.profile_id, metric]));
  const profiles = (profilesResult.data ?? []).map((profile) => {
    const metric = metricsByProfileId.get(profile.id);
    return {
      ...profile,
      publication_metrics: metric ? {
        scheduled: metric.scheduled_counts,
        published: metric.published_counts,
      } : undefined,
    };
  });
  return NextResponse.json({ profiles, total: String(profiles.length) }, { headers: { 'Cache-Control': 'no-store' } });
}
