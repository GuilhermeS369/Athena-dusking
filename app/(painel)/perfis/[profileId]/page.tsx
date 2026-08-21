import { notFound, redirect } from 'next/navigation';
import { Suspense } from 'react';

import PageLoadingSkeleton from '@/app/components/page-loading-skeleton';
import ProfileDetailClient from '@/app/perfis/[profileId]/profile-detail-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default function ProfileDetailPage(props: { params: Promise<{ profileId: string }> }) {
  return (
    <Suspense fallback={<PageLoadingSkeleton variant="dashboard" />}>
      <ProfileDetailPageContent {...props} />
    </Suspense>
  );
}

async function ProfileDetailPageContent({ params }: { params: Promise<{ profileId: string }> }) {
  const { profileId } = await params;
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  const organizationId = context.activeOrganization.id;
  const supabase = await createSupabaseServerClient();
  const [profileResult, membershipResult, snapshotResult, followerResult, postAnalyticsResult, publicationItemsResult] = await Promise.all([
    supabase
      .from('instagram_profiles_safe')
      .select('id, username, display_name, profile_picture_url, account_type, status, provider, last_checked_at, last_success_at, last_failure_at, last_error_message')
      .eq('organization_id', organizationId)
      .eq('id', profileId)
      .is('deleted_at', null)
      .maybeSingle(),
    supabase
      .from('profile_group_members')
      .select('profile_groups(id, name)')
      .eq('organization_id', organizationId)
      .eq('profile_id', profileId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('profile_analytics_snapshots')
      .select('followers_count, followers_delta, followers_gained, followers_lost, impressions, reach, views, likes, comments, shares, saves, total_interactions, profile_links_taps, posts_count, engagement_rate, sync_status, unavailable_reason, last_error_message, synced_at, period_start, period_end, raw_payload')
      .eq('organization_id', organizationId)
      .eq('profile_id', profileId)
      .is('deleted_at', null)
      .order('period_end', { ascending: false })
      .order('synced_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('profile_follower_daily_snapshots')
      .select('snapshot_date, followers_count, followers_gained, followers_lost')
      .eq('organization_id', organizationId)
      .eq('profile_id', profileId)
      .is('deleted_at', null)
      .order('snapshot_date', { ascending: true })
      .limit(45),
    supabase
      .from('profile_post_analytics_snapshots')
      .select('id, zernio_post_id, platform_post_url, content, media_type, thumbnail_url, published_at, views, reach, likes, comments, shares, saves, total_interactions, engagement_rate, sync_status')
      .eq('organization_id', organizationId)
      .eq('profile_id', profileId)
      .is('deleted_at', null)
      .order('total_interactions', { ascending: false })
      .limit(20),
    supabase
      .from('publication_items')
      .select('id, format, status, execute_at, published_at, caption, last_error_message, created_at')
      .eq('organization_id', organizationId)
      .eq('profile_id', profileId)
      .order('created_at', { ascending: false })
      .limit(30),
  ]);

  if (profileResult.error || membershipResult.error || snapshotResult.error || followerResult.error || postAnalyticsResult.error || publicationItemsResult.error) {
    throw new Error('Não foi possível carregar os detalhes do perfil.');
  }
  if (!profileResult.data) notFound();

  const membership = membershipResult.data as { profile_groups?: { id: string; name: string } | { id: string; name: string }[] | null } | null;
  const rawGroup = Array.isArray(membership?.profile_groups) ? membership?.profile_groups[0] : membership?.profile_groups;

  return (
    <ProfileDetailClient
      profile={profileResult.data}
      group={rawGroup ?? null}
      snapshot={snapshotResult.data}
      followerHistory={followerResult.data ?? []}
      postAnalytics={postAnalyticsResult.data ?? []}
      publicationItems={publicationItemsResult.data ?? []}
      canManage={['admin', 'operator'].includes(context.activeOrganization.role)}
    />
  );
}
