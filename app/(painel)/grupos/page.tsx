import { redirect } from 'next/navigation';

import GroupsClient from '@/app/grupos/groups-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function GroupsPage() {
  const context = await getOrganizationContext();

  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  const supabase = await createSupabaseServerClient();
  const [groupsResult, profilesResult, membershipsResult, fallenCountsResult] = await Promise.all([
    supabase
      .from('profile_groups')
      .select('id, name, description, consumption_mode, default_caption, created_at, updated_at')
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null)
      .order('name', { ascending: true }),
    supabase
      .from('instagram_profiles_safe')
      .select('id, username, display_name, profile_picture_url, status')
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null)
      .order('username', { ascending: true }),
    supabase
      .from('profile_group_members')
      .select('group_id, profile_id')
      .eq('organization_id', context.activeOrganization.id),
    supabase
      .from('zernio_group_profile_removal_counts')
      .select('group_id, fallen_profile_count')
      .eq('organization_id', context.activeOrganization.id),
  ]);

  if (groupsResult.error || profilesResult.error || membershipsResult.error || fallenCountsResult.error) {
    throw new Error('Não foi possível carregar os grupos.');
  }

  return (
    <GroupsClient activeOrganization={context.activeOrganization} groups={groupsResult.data ?? []} profiles={profilesResult.data ?? []} memberships={membershipsResult.data ?? []} fallenCounts={fallenCountsResult.data ?? []} />
  );
}
