import { redirect } from 'next/navigation';

import AppShell from '@/app/components/app-shell';
import { getOrganizationContext } from '@/lib/organizations/server';
import { isTwitterModuleEnabled } from '@/lib/twitter/feature';

export const dynamic = 'force-dynamic';

export default async function AuthenticatedPanelLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const context = await getOrganizationContext();

  if (!context.user) {
    redirect('/login');
  }

  if (!context.activeOrganization) {
    redirect('/onboarding');
  }

  return (
    <AppShell
      organizations={context.organizations}
      activeOrganization={context.activeOrganization}
      twitterModuleEnabled={isTwitterModuleEnabled(context.activeOrganization.id)}
    >
      {children}
    </AppShell>
  );
}
