import ZernioAdditionCompletionClient from './completion-client';

import { safeReturnTo } from '@/lib/integrations/meta-oauth';

export default async function ZernioAdditionCompletionPage({ searchParams }: {
  searchParams: Promise<{ attemptId?: string; returnTo?: string }>;
}) {
  const params = await searchParams;
  return <ZernioAdditionCompletionClient
    attemptId={params.attemptId ?? ''}
    returnTo={safeReturnTo(params.returnTo ?? null)}
  />;
}
