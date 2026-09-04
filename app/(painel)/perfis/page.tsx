import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import PageLoadingSkeleton from '@/app/components/page-loading-skeleton';
import ProfilesClient from '@/app/perfis/profiles-client';
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
  const [profilesCatalog, groupsResult, zernioConnectionsResult, metaAppsResult] = await Promise.all([
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
    // Os apps da Meta alimentam o Bulk Meta e a validação do texto colado.
    // O papel viewer não os enxerga por RLS, então o erro é ignorado abaixo.
    supabase
      .from('meta_apps_safe')
      .select('id, label, app_id, active, instagram_slot_limit, instagram_profile_count')
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
  ]);

  if (groupsResult.error || zernioConnectionsResult.error) {
    throw new Error('Não foi possível carregar os perfis do Instagram.');
  }

  // Estado da renovação apenas dos perfis desta página do catálogo. A RPC do
  // catálogo não devolve estas colunas, e recriá-la só por isso mexeria numa
  // função grande e quente; ler por id sobre a página já paginada custa uma
  // consulta curta e não escala com o tamanho da organização.
  const metaProfileIds = profilesCatalog.items
    .filter((profile) => profile.provider === 'meta_official')
    .map((profile) => profile.id);
  const { data: tokenRows } = metaProfileIds.length > 0
    ? await supabase
      .from('instagram_profiles_safe')
      .select('id, provider, token_expires_at, token_refreshed_at, token_refresh_attempted_at, token_refresh_error, token_refresh_failure_count')
      .eq('organization_id', context.activeOrganization.id)
      .in('id', metaProfileIds)
    : { data: [] };

  return (
    <ProfilesClient
      activeOrganization={context.activeOrganization}
      initialCatalog={profilesCatalog}
      groups={groupsResult.data ?? []}
      zernioConnections={zernioConnectionsResult.data ?? []}
      metaApps={metaAppsResult.data ?? []}
      metaTokenStates={tokenRows ?? []}
      connectionResult={await searchParams}
    />
  );
}
