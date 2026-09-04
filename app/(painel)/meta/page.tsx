import { redirect } from 'next/navigation';

import MetaAppsClient, { type MetaApp, type MetaTokenFleetRow } from '@/app/meta/meta-apps-client';
import { legacyMetaAppCredentials } from '@/lib/integrations/meta-oauth';
import {
  META_LONG_LIVED_TOKEN_DAYS,
  META_TOKEN_ALARM_AFTER_DAYS,
  META_TOKEN_REFRESH_AFTER_DAYS,
} from '@/lib/integrations/meta-token-renewal';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function MetaAppsPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) redirect('/perfis');

  const supabase = await createSupabaseServerClient();
  const [{ data, error }, { count: legacyProfileCount }, { data: fleet }] = await Promise.all([
    supabase
      .from('meta_apps_safe')
      .select('id, organization_id, label, app_id, instagram_slot_limit, active, last_connected_at, instagram_profile_count, created_at, updated_at')
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
    // Perfis que entraram pela credencial global, antes do cadastro existir.
    supabase
      .from('instagram_profiles_safe')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', context.activeOrganization.id)
      .eq('provider', 'meta_official')
      .is('meta_app_id', null)
      .is('deleted_at', null),
    // Uma linha por app (e uma com meta_app_id nulo para os legados). Os
    // limites vão daqui para o banco, e não o contrário: a política é do
    // TypeScript, o banco só conta.
    supabase.rpc('meta_token_fleet_summary', {
      p_organization_id: context.activeOrganization.id,
      p_refresh_after_days: META_TOKEN_REFRESH_AFTER_DAYS,
      p_alarm_after_days: META_TOKEN_ALARM_AFTER_DAYS,
      p_expire_after_days: META_LONG_LIVED_TOKEN_DAYS,
    }),
  ]);

  if (error) throw new Error('Não foi possível carregar os apps da Meta.');

  return (
    <MetaAppsClient
      activeOrganization={context.activeOrganization}
      initialApps={(data ?? []) as MetaApp[]}
      unlinkedProfileCount={legacyProfileCount ?? 0}
      serverAppId={legacyMetaAppCredentials()?.clientId ?? null}
      initialTokenFleet={(fleet ?? []) as MetaTokenFleetRow[]}
    />
  );
}
