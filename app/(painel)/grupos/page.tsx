import { redirect } from 'next/navigation';

import GroupsClient from '@/app/grupos/groups-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function GroupsPage() {
  const context = await getOrganizationContext();

  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  const organizationId = context.activeOrganization.id;
  const supabase = await createSupabaseServerClient();
  const [groupsResult, profilesResult, membershipsResult, fallenCountsResult] = await Promise.all([
    supabase
      .from('profile_groups')
      .select('id, name, description, consumption_mode, default_caption, recovery_enabled, recovery_source_group_id, created_at, updated_at')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('name', { ascending: true }),
    // Organizations can hold more profiles than PostgREST's default row cap (1000),
    // which would otherwise silently truncate the list and every count derived from it.
    fetchAllRows((from, to) => supabase
      .from('instagram_profiles_safe')
      .select('id, username, display_name, profile_picture_url, status')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      // username não é único no banco; sem o desempate por id a paginação
      // repete e perde perfis, e toda contagem derivada sai errada.
      .order('username', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)),
    fetchAllRows((from, to) => supabase
      .from('profile_group_members')
      .select('group_id, profile_id, created_at')
      .eq('organization_id', organizationId)
      .order('group_id', { ascending: true })
      .order('profile_id', { ascending: true })
      .range(from, to)),
    supabase
      .from('zernio_group_profile_removal_counts')
      .select('group_id, fallen_profile_count')
      .eq('organization_id', organizationId),
  ]);

  if (groupsResult.error || profilesResult.error || membershipsResult.error || fallenCountsResult.error) {
    throw new Error('Não foi possível carregar os grupos.');
  }

  return (
    <GroupsClient activeOrganization={context.activeOrganization} groups={groupsResult.data ?? []} profiles={profilesResult.data} memberships={membershipsResult.data} fallenCounts={fallenCountsResult.data ?? []} />
  );
}
