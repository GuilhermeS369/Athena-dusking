import { NextResponse } from 'next/server';

import type { DashboardMetric } from '@/lib/dashboard/analytics-period';
import type { DashboardV2Analytics, DashboardV2Section, DashboardV2TopPost } from '@/lib/dashboard/v2-types';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const METRICS = new Set<DashboardMetric>(['likes', 'comments', 'views', 'reach', 'shares', 'saves', 'interactions']);

function validDate(value: string | null) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const startDate = params.get('start');
  const endDate = params.get('end');
  const metricValue = params.get('metric') ?? 'likes';
  const metric = METRICS.has(metricValue as DashboardMetric) ? metricValue as DashboardMetric : null;
  const profileId = params.get('profileId');
  const groupId = params.get('groupId');
  const provider = params.get('provider');

  if (!validDate(startDate) || !validDate(endDate) || !metric) {
    return NextResponse.json({ error: 'Filtros inválidos.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const rpcParams = {
    p_organization_id: context.activeOrganization.id,
    p_start_date: startDate!,
    p_end_date: endDate!,
    p_profile_ids: profileId ? [profileId] : null,
    p_group_id: groupId || null,
    p_provider: provider || null,
    p_metric: metric,
  };
  const [analyticsResult, postsResult] = await Promise.all([
    supabase.rpc('get_dashboard_analytics_v2', { ...rpcParams, p_bucket: null }),
    supabase.rpc('get_dashboard_top_posts_v2', { ...rpcParams, p_limit: 8 }),
  ]);

  if (analyticsResult.error) {
    console.error('Dashboard V2 analytics indisponível.', {
      organizationId: context.activeOrganization.id,
      code: analyticsResult.error.code,
    });
    return NextResponse.json({ error: 'Não foi possível carregar os agregados da dashboard.' }, { status: 503 });
  }

  const topPosts: DashboardV2Section<DashboardV2TopPost[]> = postsResult.error
    ? { status: 'unavailable', data: [], error: 'Top posts temporariamente indisponíveis.' }
    : { status: 'ok', data: (postsResult.data ?? []) as DashboardV2TopPost[] };

  const analytics = analyticsResult.data as DashboardV2Analytics;
  console.info('Dashboard V2 analytics carregada.', {
    organizationId: context.activeOrganization.id,
    startDate,
    endDate,
    metric,
    selectedProfiles: analytics.coverage.selected_profiles,
    profilesWithMetrics: analytics.coverage.profiles_with_metrics,
    lastMetricDate: analytics.coverage.last_metric_date,
    topPostsStatus: topPosts.status,
    durationMs: Date.now() - startedAt,
  });

  return NextResponse.json({
    analytics: { status: 'ok', data: analytics },
    topPosts,
  }, {
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Dashboard-Version': 'v2',
      'X-Dashboard-Generated-At': analytics.generated_at,
    },
  });
}
