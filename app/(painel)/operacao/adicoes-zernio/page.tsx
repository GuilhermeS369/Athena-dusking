import { redirect } from 'next/navigation';

import { getOrganizationContext } from '@/lib/organizations/server';

import ZernioAdditionsClient from './zernio-additions-client';

export const dynamic = 'force-dynamic';

export default async function ZernioAdditionsPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  return <ZernioAdditionsClient organizationName={context.activeOrganization.name} />;
}
