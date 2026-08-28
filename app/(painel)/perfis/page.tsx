import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import PageLoadingSkeleton from '@/app/components/page-loading-skeleton';
import ProfilesClient from '@/app/perfis/profiles-client';
import { authMirrorLinkStateFromRow, type AuthMirrorLinkRow } from '@/lib/auth/mirror-link';
import { getOrganizationContext } from '@/lib/organizations/server';
import { getInstagramProfilesCatalogPage } from '@/lib/profiles/catalog';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

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
  const [profilesCatalog, groupsResult, zernioConnectionsResult, authMirrorLinkResult] = await Promise.all([
    getInstagramProfilesCatalogPage({
      supabase,
      organizationId: context.activeOrganization.id,
    }),
    supabase
      .from('profile_groups')
      .select('id, name')
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null)
      .order('name', { ascending: true }),
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

  if (groupsResult.error || zernioConnectionsResult.error || authMirrorLinkResult.error) {
    throw new Error('Não foi possível carregar os perfis do Instagram.');
  }

  return (
    <ProfilesClient
      activeOrganization={context.activeOrganization}
      initialCatalog={profilesCatalog}
      groups={groupsResult.data ?? []}
      zernioConnections={zernioConnectionsResult.data ?? []}
      authMirrorLink={authMirrorLinkStateFromRow(authMirrorLinkResult.data)}
      connectionResult={await searchParams}
    />
  );
}
