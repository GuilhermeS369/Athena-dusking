import { notFound, redirect } from 'next/navigation';

import TwitterGroupsClient from '@/app/x/twitter-groups-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterModuleEnabled } from '@/lib/twitter/feature';

export const dynamic = 'force-dynamic';

export default async function TwitterGroupsPage() {
  const context = await getOrganizationContext(); if (!context.user) redirect('/login'); if (!context.activeOrganization) redirect('/onboarding'); if (!isTwitterModuleEnabled(context.activeOrganization.id)) notFound();
  const admin = createSupabaseAdminClient();
  const [groups, profiles] = await Promise.all([
    admin.from('twitter_groups').select('id,name,description,created_at').eq('organization_id', context.activeOrganization.id).is('deleted_at', null).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(101),
    admin.from('twitter_profiles').select('id,username,display_name,avatar_url,status,created_at').eq('organization_id', context.activeOrganization.id).is('deleted_at', null).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(101),
  ]);
  const groupRows=(groups.data??[]).slice(0,100),profileRows=(profiles.data??[]).slice(0,100);
  const groupIds=groupRows.map(group=>group.id),profileIds=profileRows.map(profile=>profile.id);
  const members=groupIds.length||profileIds.length?await admin.from('twitter_group_members').select('group_id,profile_id,created_at').eq('organization_id', context.activeOrganization.id).or(`${groupIds.length?`group_id.in.(${groupIds.join(',')})`:''}${groupIds.length&&profileIds.length?',':''}${profileIds.length?`profile_id.in.(${profileIds.join(',')})`:''}`):{data:[],error:null};
  if (groups.error || profiles.error || members.error) throw new Error('Não foi possível carregar os grupos X.');
  return <TwitterGroupsClient organizationName={context.activeOrganization.name} groups={groupRows} profiles={profileRows} memberships={members.data ?? []} canEdit={context.activeOrganization.role !== 'viewer'} initialGroupsHasMore={(groups.data??[]).length>100} initialGroupsCursor={(groups.data??[]).length>100&&groupRows.length?Buffer.from(`${groupRows.at(-1)!.created_at}|${groupRows.at(-1)!.id}`).toString('base64url'):null} initialProfilesHasMore={(profiles.data??[]).length>100} initialProfilesCursor={(profiles.data??[]).length>100&&profileRows.length?Buffer.from(`${profileRows.at(-1)!.created_at}|${profileRows.at(-1)!.id}`).toString('base64url'):null} />;
}
