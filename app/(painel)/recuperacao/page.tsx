import { Suspense } from 'react';
import { redirect } from 'next/navigation';

import PageLoadingSkeleton from '@/app/components/page-loading-skeleton';
import RecoveryClient from '@/app/recuperacao/recovery-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import {
  getRecoveryCohortPage,
  getRecoveryOverview,
  listRecoveryCandidates,
  type RecoveryCandidate,
  type RecoveryCohortItem,
} from '@/lib/recovery/snapshot';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default function RecoveryPage() {
  return (
    <Suspense fallback={<PageLoadingSkeleton variant="cards" />}>
      <RecoveryPageContent />
    </Suspense>
  );
}

async function RecoveryPageContent() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  const supabase = await createSupabaseServerClient();
  const organizationId = context.activeOrganization.id;

  // O panorama é a única leitura obrigatória: ele traz a execução, os cards de
  // grupo com a série do sparkline e os marcos, tudo do snapshot. Candidatos e
  // esteira dependem de haver execução, então vêm depois e sem derrubar a
  // página se falharem.
  const overview = await getRecoveryOverview(supabase, organizationId).catch(() => null);

  let candidates: RecoveryCandidate[] = [];
  let candidatesHasMore = false;
  let cohort: RecoveryCohortItem[] = [];

  if (overview?.run?.id) {
    const [candidatesResult, cohortResult] = await Promise.all([
      listRecoveryCandidates(supabase, overview.run.id).catch(() => null),
      getRecoveryCohortPage(supabase, organizationId, { status: 'all' }).catch(() => null),
    ]);
    candidates = candidatesResult?.candidates ?? [];
    candidatesHasMore = candidatesResult?.hasMore ?? false;
    cohort = cohortResult?.members ?? [];
  }

  const canManage = ['admin', 'operator'].includes(context.activeOrganization.role);

  return (
    <RecoveryClient
      organizationName={context.activeOrganization.name}
      canManage={canManage}
      initialOverview={overview}
      initialCandidates={candidates}
      initialCandidatesHasMore={candidatesHasMore}
      initialCohort={cohort}
    />
  );
}
