import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import type { ComposerMetricRow } from '@/lib/publications/composer-metrics-fallback';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  const supabase = await createSupabaseServerClient();
  const [profilesResult, composerMetricsResult] = await Promise.all([
    supabase
      .from('instagram_profiles_safe')
      .select('id, username, display_name, profile_picture_url, provider')
      .eq('organization_id', context.activeOrganization.id)
      .eq('status', 'online')
      .is('deleted_at', null)
      .order('username', { ascending: true }),
    supabase.rpc('get_posting_composer_profile_metrics', {
      p_organization_id: context.activeOrganization.id,
      p_slot_horizon_days: 90,
    }),
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
