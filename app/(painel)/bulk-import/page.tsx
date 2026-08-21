import { redirect } from 'next/navigation';

import MoreLoginBulkClient from '@/app/bulk-import/morelogin/morelogin-bulk-client';
import { getOrganizationContext } from '@/lib/organizations/server';

export const dynamic = 'force-dynamic';

export default async function BulkImportPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  return (
    <MoreLoginBulkClient activeOrganization={context.activeOrganization} />
  );
}
