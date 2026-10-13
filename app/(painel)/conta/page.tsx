import { redirect } from 'next/navigation';

import AccountClient from '@/app/conta/account-client';
import { getOrganizationContext } from '@/lib/organizations/server';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const context = await getOrganizationContext();

  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  return (
    <AccountClient
      email={context.user.email ?? ''}
      organizations={context.organizations.map(({ id, name, role }) => ({ id, name, role }))}
      activeOrganizationId={context.activeOrganization.id}
    />
  );
}
