import { notFound, redirect } from 'next/navigation';

import TwitterZernioClient from '@/app/x/twitter-zernio-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterModuleEnabled, isTwitterZernioAnalyticsSyncEnabled } from '@/lib/twitter/feature';

export const dynamic = 'force-dynamic';

export default async function TwitterZernioPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');
  if (!isTwitterModuleEnabled(context.activeOrganization.id)) notFound();
  const admin = createSupabaseAdminClient();
  const organizationId = context.activeOrganization.id;
  const [connectionsResult, identitiesResult, eventsResult, profilesResult, attemptsResult, settingsResult] = await Promise.all([
    admin.from('twitter_connections').select('id,identity_id,label,zernio_profile_id,status,analytics_enabled,inbox_enabled,last_verified_at,last_sync_at,last_error_message,created_at,twitter_slot_limit,remote_twitter_account_count,remote_inventory_checked_at').eq('organization_id', organizationId).is('deleted_at', null).order('created_at', { ascending: false }),
    admin.from('twitter_global_identities').select('id,transferred_at').eq('current_organization_id', organizationId).order('created_at', { ascending: false }),
    context.activeOrganization.role === 'admin' ? admin.from('twitter_identity_transfer_events').select('id,identity_id,from_organization_id,to_organization_id,reason,actor_email,created_at').or(`from_organization_id.eq.${organizationId},to_organization_id.eq.${organizationId}`).order('created_at', { ascending: false }).limit(50) : Promise.resolve({ data: [], error: null }),
    admin.from('twitter_profiles').select('current_connection_id').eq('organization_id', organizationId).is('deleted_at', null).not('current_connection_id', 'is', null),
    admin.from('twitter_connection_oauth_attempts').select('connection_id').eq('organization_id', organizationId).eq('status', 'pending').gt('expires_at', new Date().toISOString()),
    admin.from('twitter_organization_settings').select('default_initial_grant_micros,default_twitter_slot_limit').eq('organization_id', organizationId).maybeSingle(),
  ]);
  if (connectionsResult.error || identitiesResult.error || eventsResult.error || profilesResult.error || attemptsResult.error || settingsResult.error) throw new Error('Não foi possível carregar a administração Zernio do X.');
  const identities = identitiesResult.data ?? [];
  const identityIds = identities.map((identity) => identity.id);
  const [walletsResult, reservationsResult, grantsResult] = identityIds.length ? await Promise.all([
    admin.from('twitter_wallets').select('identity_id,posted_balance_micros,reserved_micros,version').in('identity_id', identityIds),
    admin.from('twitter_wallet_reservations').select('identity_id,remaining_micros').in('identity_id', identityIds).gt('remaining_micros', 0),
    admin.from('twitter_wallet_grants').select('identity_id,amount_micros,created_at').in('identity_id', identityIds),
  ]) : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
  if (walletsResult.error || reservationsResult.error || grantsResult.error) throw new Error('Não foi possível carregar as carteiras X.');
  const walletsById = new Map((walletsResult.data ?? []).map((wallet) => [wallet.identity_id, wallet]));
  const grantsById = new Map((grantsResult.data ?? []).map((grant) => [grant.identity_id, grant]));
  const profileCounts = new Map<string, number>();
  for (const profile of profilesResult.data ?? []) if (profile.current_connection_id) profileCounts.set(profile.current_connection_id, (profileCounts.get(profile.current_connection_id) ?? 0) + 1);
  const pendingCounts = new Map<string, number>();
  for (const attempt of attemptsResult.data ?? []) pendingCounts.set(attempt.connection_id, (pendingCounts.get(attempt.connection_id) ?? 0) + 1);
  const activeConnectionIdentities = new Set((connectionsResult.data ?? []).map((connection) => connection.identity_id));
  const identitiesWithReservation = new Set((reservationsResult.data ?? []).map((reservation) => reservation.identity_id));
  const destinations = context.organizations.filter((organization) => organization.id !== organizationId && organization.role === 'admin' && isTwitterModuleEnabled(organization.id)).map(({ id, name }) => ({ id, name }));
  const organizationNames = new Map(context.organizations.map((organization) => [organization.id, organization.name]));
  const settings = settingsResult.data ?? { default_initial_grant_micros: 12_000_000, default_twitter_slot_limit: 2 };

  return <main className="standalone-page zernio-page"><header className="standalone-header zernio-hero"><div><span className="section-kicker">{context.activeOrganization.name} · X / Twitter</span><h1>Zernio</h1><p>Chaves, capacidade de contas X e carteira sintética em uma administração isolada.</p></div></header><TwitterZernioClient
    activeOrganization={{ id: organizationId, name: context.activeOrganization.name, role: context.activeOrganization.role }}
    initialConnections={(connectionsResult.data ?? []).map((connection) => ({ ...connection, wallet: walletsById.get(connection.identity_id) ?? null, grant: grantsById.get(connection.identity_id) ?? null, twitter_profile_count: profileCounts.get(connection.id) ?? 0, active_slot_reservation_count: pendingCounts.get(connection.id) ?? 0 }))}
    initialDefaultGrantMicros={Number(settings.default_initial_grant_micros)} initialDefaultTwitterSlotLimit={settings.default_twitter_slot_limit}
    transferIdentities={identities.map((identity) => ({ id: identity.id, wallet: walletsById.get(identity.id) ?? null, connectionActive: activeConnectionIdentities.has(identity.id), openReservation: identitiesWithReservation.has(identity.id) }))}
    destinations={destinations} transferEvents={(eventsResult.data ?? []).map((event) => ({ ...event, fromOrganizationName: organizationNames.get(event.from_organization_id) ?? event.from_organization_id.slice(0, 8), toOrganizationName: organizationNames.get(event.to_organization_id) ?? event.to_organization_id.slice(0, 8) }))}
    analyticsGateEnabled={isTwitterZernioAnalyticsSyncEnabled(organizationId)} />
  </main>;
}
