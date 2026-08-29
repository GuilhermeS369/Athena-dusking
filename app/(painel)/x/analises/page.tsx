import { redirect } from 'next/navigation';

import { TwitterAnalyticsClient } from '@/app/x/twitter-analytics-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { fetchAllRowsByIds } from '@/lib/supabase/chunk';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { isTwitterAnalyticsEnabled } from '@/lib/twitter/feature';

export const dynamic = 'force-dynamic';

function saoPauloYesterday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(Date.now() - 86_400_000));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export default async function TwitterAnalyticsPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  const admin = createSupabaseAdminClient();
  const organizationId = context.activeOrganization.id;
  const [profilesResult, groupsResult, membersResult, connectionsResult, snapshotsCountResult] = await Promise.all([
    // Listas que crescem com a frota: sem paginar, o PostgREST corta em 1.000 e
    // os filtros de Análises escondem perfis sem qualquer aviso.
    fetchAllRows((from, to) => admin.from('twitter_profiles').select('id,username,display_name,avatar_url,status,account_tier,can_fetch_analytics,current_connection_id,last_synced_at').eq('organization_id', organizationId).is('deleted_at', null).order('username').order('id').range(from, to)),
    admin.from('twitter_groups').select('id,name').eq('organization_id', organizationId).is('deleted_at', null).order('name'),
    fetchAllRows((from, to) => admin.from('twitter_group_members').select('group_id,profile_id').eq('organization_id', organizationId).order('group_id').order('profile_id').range(from, to)),
    fetchAllRows((from, to) => admin.from('twitter_connections').select('id,identity_id,label,status,analytics_enabled,last_sync_at,last_error_message').eq('organization_id', organizationId).is('deleted_at', null).order('label').order('id').range(from, to)),
    admin.from('twitter_analytics_snapshots').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
  ]);

  if ([profilesResult, groupsResult, membersResult, connectionsResult, snapshotsCountResult].some((result) => result.error)) {
    throw new Error('Não foi possível carregar os recursos locais de Análises X.');
  }

  const connections = connectionsResult.data;
  const profiles = profilesResult.data;
  const identityIds = connections.map((connection) => connection.identity_id);
  const profileIds = profiles.map((profile) => profile.id);
  const [walletsResult, followersResult] = await Promise.all([
    fetchAllRowsByIds(identityIds, (chunk, from, to) => admin.from('twitter_wallets').select('identity_id,posted_balance_micros,reserved_micros').eq('organization_id', organizationId).in('identity_id', chunk).order('identity_id').range(from, to)),
    fetchAllRowsByIds<{ profile_id: string; followers_count: number | string; captured_at: string; snapshot_date: string }>(profileIds, (chunk, from, to) => (admin.from('twitter_profile_follower_daily_metrics' as never) as any).select('profile_id,snapshot_date,followers_count,captured_at').eq('organization_id', organizationId).eq('snapshot_date', saoPauloYesterday()).in('profile_id', chunk).order('profile_id').range(from, to)),
  ]);
  if (walletsResult.error) throw new Error('Não foi possível carregar os saldos X.');

  const members = membersResult.data;
  const walletByIdentity = new Map(walletsResult.data.map((wallet) => [wallet.identity_id, wallet]));
  const followersByProfile = new Map<string, { followers_count: number | string; captured_at: string; snapshot_date: string }>(
    (followersResult.error ? [] : followersResult.data).map((row) => [row.profile_id, row]),
  );
  const groupsByProfile = new Map<string, string[]>();

  for (const member of members) groupsByProfile.set(member.profile_id, [...(groupsByProfile.get(member.profile_id) ?? []), member.group_id]);

  return <TwitterAnalyticsClient
    enabled={isTwitterAnalyticsEnabled(organizationId)}
    snapshotCount={snapshotsCountResult.count ?? 0}
    connections={connections.map((connection) => {
      const wallet = walletByIdentity.get(connection.identity_id);
      return {
        id: connection.id, identityId: connection.identity_id, label: connection.label,
        status: connection.status, analyticsEnabled: connection.analytics_enabled,
        lastSyncAt: connection.last_sync_at, errorMessage: connection.last_error_message,
        postedBalanceMicros: Number(wallet?.posted_balance_micros ?? 0),
        reservedMicros: Number(wallet?.reserved_micros ?? 0),
      };
    })}
    profiles={profiles.map((profile) => {
      const follower = followersByProfile.get(profile.id);
      return {
        id: profile.id, profileId: profile.id, connectionId: profile.current_connection_id,
        username: profile.username, displayName: profile.display_name, avatarUrl: profile.avatar_url,
        accountTier: profile.account_tier, status: profile.status,
        canFetchAnalytics: profile.can_fetch_analytics, groupIds: groupsByProfile.get(profile.id) ?? [],
        lastSnapshotAt: follower?.captured_at ?? null,
        followerSnapshotDate: follower?.snapshot_date ?? null,
        followerCount: follower ? Number(follower.followers_count) : null,
      };
    })}
    groups={(groupsResult.data ?? []).map((group) => ({
      id: group.id, label: group.name,
      profileIds: members.filter((member) => member.group_id === group.id).map((member) => member.profile_id),
    }))}
  />;
}
