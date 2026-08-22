import { redirect } from 'next/navigation';

import { TwitterAnalyticsClient } from '@/app/x/twitter-analytics-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterAnalyticsEnabled } from '@/lib/twitter/feature';

export const dynamic = 'force-dynamic';

export default async function TwitterAnalyticsPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  const admin = createSupabaseAdminClient();
  const organizationId = context.activeOrganization.id;
  const [profilesResult, itemsResult, groupsResult, membersResult] =
    await Promise.all([
      admin
        .from('twitter_profiles')
        .select('id,username,display_name,account_tier')
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .order('username'),
      admin
        .from('twitter_publication_items')
        .select('id,profile_id,content,execute_at')
        .eq('organization_id', organizationId)
        .eq('status', 'published')
        .order('execute_at', { ascending: false })
        .limit(500),
      admin
        .from('twitter_groups')
        .select('id,name')
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .order('name'),
      admin
        .from('twitter_group_members')
        .select('group_id,profile_id')
        .eq('organization_id', organizationId),
    ]);

  if (
    profilesResult.error ||
    itemsResult.error ||
    groupsResult.error ||
    membersResult.error
  ) {
    throw new Error('Não foi possível carregar os recursos locais de Análises X.');
  }

  const profiles = profilesResult.data ?? [];
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
  const members = membersResult.data ?? [];

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <span className="eyebrow">X / Twitter</span>
          <h1>Análises manuais</h1>
          <p>
            Nenhuma métrica é consultada sem revisão financeira e confirmação.
          </p>
        </div>
      </header>
      <TwitterAnalyticsClient
        enabled={isTwitterAnalyticsEnabled(organizationId)}
        profiles={profiles.map((profile) => ({
          id: profile.id,
          profileId: profile.id,
          label: `@${profile.username}`,
          detail: profile.account_tier,
        }))}
        posts={(itemsResult.data ?? []).map((item) => ({
          id: item.id,
          profileId: item.profile_id,
          occurredAt: item.execute_at,
          label: `@${profileMap.get(item.profile_id)?.username ?? 'perfil'}`,
          detail: `${new Date(item.execute_at).toLocaleDateString('pt-BR', {
            timeZone: 'America/Sao_Paulo',
          })} · ${item.content.slice(0, 90)}`,
        }))}
        groups={(groupsResult.data ?? []).map((group) => ({
          id: group.id,
          label: group.name,
          profileIds: members
            .filter((member) => member.group_id === group.id)
            .map((member) => member.profile_id),
        }))}
      />
    </div>
  );
}
