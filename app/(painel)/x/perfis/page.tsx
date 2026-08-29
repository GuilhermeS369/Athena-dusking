import { notFound, redirect } from 'next/navigation';

import TwitterProfilesClient from '@/app/x/twitter-profiles-client';
import { authMirrorLinkStateFromRow, type AuthMirrorLinkRow } from '@/lib/auth/mirror-link';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { fetchAllRowsByIds } from '@/lib/supabase/chunk';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { isTwitterModuleEnabled } from '@/lib/twitter/feature';

export const dynamic = 'force-dynamic';

export default async function TwitterProfilesPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');
  if (!isTwitterModuleEnabled(context.activeOrganization.id)) notFound();
  const admin = createSupabaseAdminClient();
  const organizationId = context.activeOrganization.id;
  const canManageMirror = ['admin', 'operator'].includes(context.activeOrganization.role);
  const [profilesResult, groupsResult, membersResult, queueResult, connectionsResult, intentsResult, legacyAttemptsResult, mirrorResult] = await Promise.all([
    admin.from('twitter_profiles').select('id,username,display_name,avatar_url,status,account_tier,can_post,can_fetch_analytics,analytics_enabled,token_valid,needs_reconnect,current_connection_id,last_synced_at,created_at').eq('organization_id', organizationId).is('deleted_at', null).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(101),
    admin.from('twitter_groups').select('id,name').eq('organization_id', organizationId).is('deleted_at', null).order('name'),
    fetchAllRows((from, to) => admin.from('twitter_group_members').select('group_id,profile_id').eq('organization_id', organizationId).order('group_id').order('profile_id').range(from, to)),
    Promise.resolve({ data: [], error: null }),
    fetchAllRows((from, to) => admin.from('twitter_connections').select('id,identity_id,label,status,twitter_slot_limit,remote_twitter_account_count,remote_inventory_checked_at,last_error_code,last_error_message,last_sync_at').eq('organization_id', organizationId).is('deleted_at', null).order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to)),
    admin.from('twitter_connection_intents').select('connection_id').eq('organization_id', organizationId).in('status', ['queued','preparing','ready','callback_received','reconciling']).gt('expires_at', new Date().toISOString()),
    admin.from('twitter_connection_oauth_attempts').select('connection_id').eq('organization_id', organizationId).eq('status', 'pending').gt('expires_at', new Date().toISOString()),
    canManageMirror ? admin.from('auth_mirror_links').select('active,activated_at,created_by_email,last_used_at,use_count').eq('organization_id', organizationId).eq('active', true).maybeSingle<AuthMirrorLinkRow>() : Promise.resolve({ data: null, error: null }),
  ]);
  if ([profilesResult, groupsResult, membersResult, queueResult, connectionsResult, intentsResult, legacyAttemptsResult, mirrorResult].some((result) => result.error)) throw new Error('Não foi possível carregar os perfis X.');
  const profileRows = profilesResult.data ?? [];
  const profiles = profileRows.slice(0, 100);
  const profileIds = profiles.map((profile) => profile.id);
  const pageQueueResult = profileIds.length ? await admin.rpc('twitter_profile_queue_summary_page', { p_organization_id: organizationId, p_profile_ids: profileIds }) : { data: [], error: null };
  if (pageQueueResult.error) throw new Error('Não foi possível carregar o resumo dos perfis X.');
  const connectionIds = connectionsResult.data.map((connection) => connection.id);
  const identityIds = connectionsResult.data.map((connection) => connection.identity_id);
  const [{ data: wallets }, { data: connectionProfiles }] = await Promise.all([
    fetchAllRowsByIds(identityIds, (chunk, from, to) => admin.from('twitter_wallets').select('identity_id,posted_balance_micros,reserved_micros').eq('organization_id', organizationId).in('identity_id', chunk).order('identity_id').range(from, to)),
    // Uma linha por perfil da organização: cortado em 1.000, o localCount abaixo
    // subestimava a ocupação das conexões e a tela mostrava folga de slot que não
    // existe. O id entra no select só para dar ordem determinística à paginação.
    fetchAllRowsByIds(connectionIds, (chunk, from, to) => admin.from('twitter_profiles').select('id,current_connection_id').eq('organization_id', organizationId).in('current_connection_id', chunk).is('deleted_at', null).order('id').range(from, to)),
  ]);
  const groupsByProfile = new Map<string, string[]>();
  for (const member of membersResult.data) groupsByProfile.set(member.profile_id, [...(groupsByProfile.get(member.profile_id) ?? []), member.group_id]);
  const queueByProfile = new Map((pageQueueResult.data ?? []).map((row: { profile_id: string }) => [row.profile_id, row]));
  const walletByIdentity = new Map(wallets.map((wallet) => [wallet.identity_id, wallet]));
  const localCount = new Map<string, number>();
  const reservationCount = new Map<string, number>();
  for (const profile of connectionProfiles) if (profile.current_connection_id) localCount.set(profile.current_connection_id, (localCount.get(profile.current_connection_id) ?? 0) + 1);
  for (const reservation of [...(intentsResult.data ?? []), ...(legacyAttemptsResult.data ?? [])]) reservationCount.set(reservation.connection_id, (reservationCount.get(reservation.connection_id) ?? 0) + 1);
  const connectionById = new Map(connectionsResult.data.map((connection) => [connection.id, connection]));
  return <TwitterProfilesClient
    activeOrganization={{ id: organizationId, name: context.activeOrganization.name, role: context.activeOrganization.role }}
    groups={groupsResult.data ?? []}
    authMirrorLink={authMirrorLinkStateFromRow(mirrorResult.data)}
    initialHasMore={profileRows.length > 100}
    initialCursor={profileRows.length > 100 && profiles.length ? Buffer.from(`${profiles.at(-1)!.created_at}|${profiles.at(-1)!.id}`).toString('base64url') : null}
    connections={(connectionsResult.data ?? []).map((connection) => ({
      ...connection,
      twitter_profile_count: localCount.get(connection.id) ?? 0,
      active_slot_reservation_count: reservationCount.get(connection.id) ?? 0,
      available_micros: Number(walletByIdentity.get(connection.identity_id)?.posted_balance_micros ?? 0) - Number(walletByIdentity.get(connection.identity_id)?.reserved_micros ?? 0),
      remote_inventory_error_code: connection.last_error_code ?? (connection.remote_inventory_checked_at ? null : 'inventory_unavailable'),
    }))}
    profiles={profiles.map((profile) => {
      const queue = queueByProfile.get(profile.id) as Record<string, unknown> | undefined;
      const connection = profile.current_connection_id ? connectionById.get(profile.current_connection_id) : null;
      const wallet = connection ? walletByIdentity.get(connection.identity_id) : null;
      return {
        ...profile,
        connection_label: connection?.label ?? null,
        available_micros: Number(wallet?.posted_balance_micros ?? 0) - Number(wallet?.reserved_micros ?? 0),
        group_ids: groupsByProfile.get(profile.id) ?? [],
        pending_count: Number(queue?.pending_count ?? 0),
        text_count: Number(queue?.text_count ?? 0), image_count: Number(queue?.image_count ?? 0),
        gif_count: Number(queue?.gif_count ?? 0), video_count: Number(queue?.video_count ?? 0),
      };
    })}
  />;
}
