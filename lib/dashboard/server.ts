import { createSupabaseServerClient } from '@/lib/supabase/server';

import type { DashboardV2Bootstrap } from '@/lib/dashboard/v2-types';

export type DashboardData = {
  connections: { total: number; healthy: number; attention: number };
  operationalProfiles: number;
  scheduled: { total: number; nextAt: string | null };
  review: { total: number; failedPublications: number; profilesNeedingReauth: number };
  summary: {
    totalPosts: number;
    publishedPosts: number;
    nextScheduleAt: string | null;
    followersTotal: number;
    followersDelta: number;
    viewsTotal: number;
    reachTotal: number;
    interactionsTotal: number;
    analyticsAvailableProfiles: number;
    analyticsUnavailableProfiles: number;
  };
  onboarding: { profileConnected: boolean; groupCreated: boolean; mediaUploaded: boolean };
  analytics: {
    profiles: Array<{ id: string; username: string; display_name: string | null; provider: 'meta_official' | 'zernio'; status: string }>;
    groups: Array<{ id: string; name: string; profile_ids: string[] }>;
    snapshots: Array<{
      profile_id: string;
      period_start: string;
      period_end: string;
      followers_count: number;
      followers_delta: number;
      impressions: number;
      reach: number;
      views: number;
      likes: number;
      comments: number;
      shares: number;
      saves: number;
      total_interactions: number;
      posts_count: number;
      engagement_rate: number;
      sync_status: string;
      synced_at: string | null;
    }>;
    dailyMetrics: Array<{
      profile_id: string;
      date: string;
      posts: number;
      impressions: number;
      reach: number;
      views: number;
      likes: number;
      comments: number;
      shares: number;
      saves: number;
      interactions: number;
    }>;
    followerHistory: Array<{ profile_id: string; snapshot_date: string; followers_count: number; followers_gained: number; followers_lost: number }>;
    posts: Array<{
      id: string;
      profile_id: string;
      platform_post_url: string | null;
      content: string | null;
      media_type: string | null;
      thumbnail_url: string | null;
      published_at: string | null;
      views: number;
      reach: number;
      likes: number;
      comments: number;
      shares: number;
      saves: number;
      total_interactions: number;
      engagement_rate: number;
      sync_status: string;
    }>;
    publishedItems: Array<{ id: string; profile_id: string; published_at: string }>;
    publicationRollups: Array<{ kind: string; profile_id: string; label: string; total: number }>;
    /**
     * Contagem de perfis por situação de coleta.
     *
     * Existe para o cartão de saúde das fontes poder dizer "1.402 ativos" sem
     * que as 1.402 linhas viajem até o navegador — ver a migration 383, que
     * cortou o bootstrap de 633 KB reduzindo `analytics_state` à lista de
     * problemas.
     */
    stateCounts: Record<string, number>;
  };
};

export async function getDashboardData(organizationId: string): Promise<DashboardData> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('get_dashboard_bootstrap_v2', {
    p_organization_id: organizationId,
  });

  // Sem plano B, e isso e deliberado.
  //
  // Ate 07/09/2026 havia um caminho V1 aqui, e ele nunca foi um plano B: o
  // bootstrap V2 chama `get_dashboard_analytics_summary` na primeira linha, que
  // era exatamente a consulta que derrubava o V1. Os dois caiam juntos, pelo
  // mesmo timeout, e o fallback so trocava uma tela vazia por outra depois de
  // pagar o custo duas vezes. A migration 421 tirou a agregacao do caminho da
  // requisicao; se ainda assim falhar, a tela diz que falhou em vez de fingir
  // que a operacao esta zerada.
  if (error || !data) {
    console.error('Bootstrap da dashboard indisponível.', {
      organizationId,
      code: error?.code,
      message: error?.message,
    });
    throw new Error('Não foi possível carregar a dashboard.');
  }

  return dashboardDataFromV2Bootstrap(data as DashboardV2Bootstrap);
}

function countByStatus(rows: Array<{ sync_status: string }>) {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.sync_status] = (counts[row.sync_status] ?? 0) + 1;
  return counts;
}

function dashboardDataFromV2Bootstrap(bootstrap: DashboardV2Bootstrap): DashboardData {
  const summary = bootstrap.summary;
  return {
    connections: {
      total: summary.connections_total,
      healthy: summary.connections_healthy,
      attention: summary.connections_attention,
    },
    operationalProfiles: summary.operational_profiles,
    scheduled: { total: summary.scheduled_total, nextAt: summary.next_scheduled_at },
    review: {
      total: summary.failed_publications + summary.profiles_needing_reauth,
      failedPublications: summary.failed_publications,
      profilesNeedingReauth: summary.profiles_needing_reauth,
    },
    summary: {
      totalPosts: summary.total_posts,
      publishedPosts: summary.published_total,
      nextScheduleAt: summary.next_scheduled_at,
      followersTotal: 0,
      followersDelta: 0,
      viewsTotal: 0,
      reachTotal: 0,
      interactionsTotal: 0,
      analyticsAvailableProfiles: summary.analytics_available_profiles,
      analyticsUnavailableProfiles: summary.analytics_unavailable_profiles,
    },
    onboarding: {
      profileConnected: summary.connections_total > 0,
      groupCreated: summary.groups_total > 0,
      mediaUploaded: summary.ready_assets > 0,
    },
    analytics: {
      profiles: bootstrap.profiles,
      groups: bootstrap.groups,
      snapshots: bootstrap.analytics_state.map((state) => ({
        profile_id: state.profile_id,
        period_start: state.period_end,
        period_end: state.period_end,
        followers_count: 0,
        followers_delta: 0,
        impressions: 0,
        reach: 0,
        views: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        saves: 0,
        total_interactions: 0,
        posts_count: 0,
        engagement_rate: 0,
        sync_status: state.sync_status,
        synced_at: state.synced_at,
      })),
      dailyMetrics: [],
      followerHistory: [],
      posts: [],
      publishedItems: [],
      publicationRollups: [],
      // Sem a migration 383 o campo não vem; a contagem cai para o que a lista
      // de atenção mostra, que é o comportamento anterior.
      stateCounts: bootstrap.analytics_state_counts ?? countByStatus(bootstrap.analytics_state),
    },
  };
}
