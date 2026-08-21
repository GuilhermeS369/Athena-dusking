import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import DashboardClient from '@/app/dashboard-client';
import PageLoadingSkeleton from '@/app/components/page-loading-skeleton';
import { getOrganizationContext } from '@/lib/organizations/server';
import { getDashboardData } from '@/lib/dashboard/server';

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  return (
    <Suspense fallback={<PageLoadingSkeleton variant="dashboard" />}>
      <DashboardPageContent />
    </Suspense>
  );
}

async function DashboardPageContent() {
  const context = await getOrganizationContext();

  if (!context.user) {
    redirect('/login');
  }

  if (context.organizations.length === 0) {
    redirect('/onboarding');
  }

  const activeOrganization = context.activeOrganization ?? context.organizations[0];
  const dashboardData = await getDashboardData(activeOrganization.id);

  return (
    <DashboardClient organizations={context.organizations} activeOrganization={activeOrganization} data={dashboardData} />
  );
}
