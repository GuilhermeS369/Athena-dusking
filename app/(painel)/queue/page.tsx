import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import PageLoadingSkeleton from '@/app/components/page-loading-skeleton';
import QueueClient from '@/app/queue/queue-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

type ZernioConnectionRow = {
  id: string;
  label: string | null;
};

export default function QueuePage() {
  return (
    <Suspense fallback={<PageLoadingSkeleton variant="cards" />}>
      <QueuePageContent />
    </Suspense>
  );
}

async function QueuePageContent() {
  const context = await getOrganizationContext();

  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  const supabase = await createSupabaseServerClient();
  const [profilesResult, groupsResult, zernioConnectionsResult] = await Promise.all([
    supabase
      .from('instagram_profiles_safe')
      .select('id, username, display_name, profile_picture_url, provider, zernio_account_id, zernio_connection_id, status')
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null)
      .order('username', { ascending: true }),
    supabase
      .from('profile_groups')
      .select('id, name, description, profile_group_members(profile_id)')
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null)
      .order('name', { ascending: true }),
    supabase
      .from('zernio_connections_safe')
      .select('id, label')
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null),
  ]);

  const loadErrors = {
    profiles: profilesResult.error?.message,
    groups: groupsResult.error?.message,
    zernioConnections: zernioConnectionsResult.error?.message,
  };
  if (Object.values(loadErrors).some(Boolean)) {
    console.error('Falha parcial ao carregar /queue', loadErrors);
  }

  const connectionLabels = new Map((zernioConnectionsResult.data as ZernioConnectionRow[] | null ?? []).map((connection) => [connection.id, connection.label]));

  return (
    <QueueClient
      activeOrganization={context.activeOrganization}
      profiles={(profilesResult.data ?? []).map((profile) => ({
        ...profile,
        zernio_connection_label: profile.zernio_connection_id ? connectionLabels.get(profile.zernio_connection_id) ?? null : null,
      }))}
      groups={groupsResult.data ?? []}
      batches={[]}
    />
  );
}
