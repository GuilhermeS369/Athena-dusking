import { redirect } from 'next/navigation';
import TwitterConnectProgress from '@/app/x/twitter-connect-progress';
import { getOrganizationContext } from '@/lib/organizations/server';
import { isTwitterModuleEnabled } from '@/lib/twitter/feature';

export default async function TwitterWaitingPage({ searchParams }: { searchParams: Promise<{ intent?: string }> }) {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');
  if (!isTwitterModuleEnabled(context.activeOrganization.id) || context.activeOrganization.role !== 'admin') redirect('/x/perfis');
  const { intent } = await searchParams;
  if (!intent) redirect('/x/perfis');
  return <TwitterConnectProgress intentId={intent} />;
}
