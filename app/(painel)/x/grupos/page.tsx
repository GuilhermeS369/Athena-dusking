import { notFound, redirect } from 'next/navigation';

import TwitterGroupsClient from '@/app/x/twitter-groups-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterModuleEnabled } from '@/lib/twitter/feature';

export const dynamic = 'force-dynamic';

export default async function TwitterGroupsPage() {
  const context = await getOrganizationContext(); if (!context.user) redirect('/login'); if (!context.activeOrganization) redirect('/onboarding'); if (!isTwitterModuleEnabled(context.activeOrganization.id)) notFound();
  const admin = createSupabaseAdminClient();
  const [groups, profiles, members] = await Promise.all([
    admin.from('twitter_groups').select('id,name,description').eq('organization_id', context.activeOrganization.id).is('deleted_at', null).order('name'),
    admin.from('twitter_profiles').select('id,username,display_name,avatar_url,status').eq('organization_id', context.activeOrganization.id).is('deleted_at', null).order('username'),
    admin.from('twitter_group_members').select('group_id,profile_id').eq('organization_id', context.activeOrganization.id),
  ]);
  if (groups.error || profiles.error || members.error) throw new Error('Não foi possível carregar os grupos X.');
  return <TwitterGroupsClient organizationName={context.activeOrganization.name} groups={groups.data ?? []} profiles={profiles.data ?? []} memberships={members.data ?? []} canEdit={context.activeOrganization.role !== 'viewer'} />;
}
