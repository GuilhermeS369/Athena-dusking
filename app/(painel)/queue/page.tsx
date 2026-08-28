import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import PageLoadingSkeleton from '@/app/components/page-loading-skeleton';
import QueueClient from '@/app/queue/queue-client';
import { getOrganizationContext } from '@/lib/organizations/server';

export const dynamic = 'force-dynamic';

export default function QueuePage() {
  return (
    <Suspense fallback={<PageLoadingSkeleton variant="cards" />}>
      <QueuePageContent />
    </Suspense>
  );
}

async function QueuePageContent() {
  const context = await getOrganizationContext();

  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  return <QueueClient activeOrganization={context.activeOrganization} />;
}
