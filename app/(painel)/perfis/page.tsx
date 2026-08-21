import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import PageLoadingSkeleton from '@/app/components/page-loading-skeleton';
import ProfilesClient from '@/app/perfis/profiles-client';
import { authMirrorLinkStateFromRow, type AuthMirrorLinkRow } from '@/lib/auth/mirror-link';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

type ProfileAnalyticsSummaryRow = {
  profile_id: string;
  scheduled_total: number;
  scheduled_reel: number;
  scheduled_story: number;
  scheduled_image: number;
  scheduled_carousel: number;
  published_total: number;
  published_reel: number;
  published_story: number;
  published_image: number;
  published_carousel: number;
  followers_count: number;
  followers_delta: number;
  views: number;
  reach: number;
  impressions: number;
  total_interactions: number;
  engagement_rate: number;
  posts_count: number;
  latest_published_at: string | null;
  analytics_status: 'pending' | 'synced' | 'no_data' | 'not_configured' | 'unavailable_plan' | 'permission_missing' | 'rate_limited' | 'failed';
  analytics_unavailable_reason: string | null;
  analytics_synced_at: string | null;
};

export default function ProfilesPage(props: {
  searchParams: Promise<{ connected?: string; error?: string; diagnostic?: string; synced?: string; groupAssignment?: string; groupName?: string; groupAssignmentError?: string; zernioFallbackConnection?: string; zernioConnectionId?: string; zernioHttpStatus?: string; zernioErrorCode?: string; zernioErrorReason?: string }>;
}) {
  return (
    <Suspense fallback={<PageLoadingSkeleton variant="cards" />}>
      <ProfilesPageContent {...props} />
    </Suspense>
  );
}

async function ProfilesPageContent({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string; diagnostic?: string; synced?: string; groupAssignment?: string; groupName?: string; groupAssignmentError?: string; zernioFallbackConnection?: string; zernioConnectionId?: string; zernioHttpStatus?: string; zernioErrorCode?: string; zernioErrorReason?: string }>;
}) {
  const context = await getOrganizationContext();

  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  const supabase = await createSupabaseServerClient();
  const [profilesResult, groupsResult, membershipsResult, publicationMetricsResult, zernioConnectionsResult, authMirrorLinkResult] = await Promise.all([
    supabase
      .from('instagram_profiles_safe')
      .select(
        'id, instagram_user_id, username, display_name, profile_picture_url, account_type, status, provider, zernio_account_id, zernio_connection_id, token_expires_at, last_checked_at, last_success_at, last_failure_at, last_error_code, last_error_message, deleted_at, created_at, updated_at',
      )
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false }),
    supabase
      .from('profile_groups')
      .select('id, name')
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null)
      .order('name', { ascending: true }),
    supabase
      .from('profile_group_members')
      .select('group_id, profile_id')
      .eq('organization_id', context.activeOrganization.id),
    supabase
      .rpc('get_profiles_analytics_summary', { p_organization_id: context.activeOrganization.id }),
    supabase
      .from('zernio_connections_safe')
      .select('id, label, status, balance_cents, balance_currency, instagram_profile_count, instagram_slot_limit, remote_instagram_account_count, remote_inventory_checked_at, remote_inventory_error_code, remote_inventory_error_message, active_slot_reservation_count, last_checked_at, last_sync_at, last_error_message, created_at')
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
    ['admin', 'operator'].includes(context.activeOrganization.role)
      ? supabase
        .from('auth_mirror_links')
        .select('active, activated_at, created_by_email, last_used_at, use_count')
        .eq('organization_id', context.activeOrganization.id)
        .eq('active', true)
        .maybeSingle<AuthMirrorLinkRow>()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (profilesResult.error || groupsResult.error || membershipsResult.error || publicationMetricsResult.error || zernioConnectionsResult.error || authMirrorLinkResult.error) {
    throw new Error('Não foi possível carregar os perfis do Instagram.');
  }
  const metricsByProfileId = new Map((publicationMetricsResult.data as ProfileAnalyticsSummaryRow[] | null ?? []).map((row) => [row.profile_id, row]));

  return (
    <ProfilesClient
      activeOrganization={context.activeOrganization}
      profiles={(profilesResult.data ?? []).map((profile) => ({
        ...profile,
        publication_metrics: metricsByProfileId.get(profile.id),
      }))}
      groups={groupsResult.data ?? []}
      memberships={membershipsResult.data ?? []}
      zernioConnections={zernioConnectionsResult.data ?? []}
      authMirrorLink={authMirrorLinkStateFromRow(authMirrorLinkResult.data)}
      connectionResult={await searchParams}
    />
  );
}
