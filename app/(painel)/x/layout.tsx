import { notFound } from 'next/navigation';

import { getOrganizationContext } from '@/lib/organizations/server';
import { isTwitterModuleEnabled } from '@/lib/twitter/feature';

export const dynamic = 'force-dynamic';

export default async function TwitterModuleLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const context = await getOrganizationContext();
  if (!context.activeOrganization || !isTwitterModuleEnabled(context.activeOrganization.id)) notFound();
  return <div className="twitter-module-shell">{children}</div>;
}
