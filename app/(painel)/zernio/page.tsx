import { redirect } from 'next/navigation';

import ZernioClient from '@/app/zernio/zernio-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function ZernioPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  const supabase = await createSupabaseServerClient();
  const [{ data, error }, { data: settings }] = await Promise.all([
    supabase.from('zernio_connections_safe')
      .select('id, organization_id, label, configured, zernio_profile_id, status, balance_cents, balance_currency, supported_platforms, instagram_slot_limit, remote_instagram_account_count, remote_inventory_checked_at, remote_inventory_error_code, remote_inventory_error_message, active_slot_reservation_count, last_checked_at, last_success_at, last_failure_at, last_sync_at, last_error_code, last_error_message, deleted_at, created_at, updated_at, instagram_profile_count, platform_counts')
      .eq('organization_id', context.activeOrganization.id).is('deleted_at', null).order('created_at', { ascending: false }),
    supabase.from('zernio_multi_connection_settings').select('default_instagram_slot_limit')
      .eq('organization_id', context.activeOrganization.id).maybeSingle(),
  ]);

  if (error) throw new Error('Não foi possível carregar as contas Zernio.');

  return (
    <ZernioClient activeOrganization={context.activeOrganization} initialConnections={data ?? []} initialDefaultInstagramSlotLimit={settings?.default_instagram_slot_limit ?? 2} />
  );
}
