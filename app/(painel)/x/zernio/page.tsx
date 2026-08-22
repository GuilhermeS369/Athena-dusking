import { notFound, redirect } from 'next/navigation';

import TwitterZernioClient from '@/app/x/twitter-zernio-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterModuleEnabled } from '@/lib/twitter/feature';

export const dynamic = 'force-dynamic';

export default async function TwitterZernioPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');
  if (!isTwitterModuleEnabled(context.activeOrganization.id)) notFound();
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from('twitter_connections')
    .select('id, identity_id, label, status, last_sync_at, last_error_message')
    .eq('organization_id', context.activeOrganization.id).is('deleted_at', null).order('created_at', { ascending: false });
  if (error) throw new Error('Não foi possível carregar as conexões Zernio do X.');
  const identityIds = [...new Set((data ?? []).map((item) => item.identity_id))];
  const { data: wallets } = identityIds.length
    ? await admin.from('twitter_wallets').select('identity_id, posted_balance_micros, reserved_micros, version').in('identity_id', identityIds)
    : { data: [] };
  const walletsById = new Map((wallets ?? []).map((item) => [item.identity_id, item]));
  return <div className="page-stack"><header className="page-heading"><div><span className="eyebrow">X / Twitter</span><h1>Zernio</h1><p>Conexões, carteira sintética e autorização das contas X.</p></div></header><TwitterZernioClient connections={(data ?? []).map((item) => ({ ...item, wallet: walletsById.get(item.identity_id) ?? null }))} canManage={context.activeOrganization.role === 'admin'} /></div>;
}
