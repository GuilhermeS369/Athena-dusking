import ZernioOauthWaitingClient from './waiting-client';

import { safeReturnTo } from '@/lib/integrations/meta-oauth';

export default async function ZernioOauthWaitingPage({ searchParams }: { searchParams: Promise<{ turnId?: string; returnTo?: string }> }) {
  const params = await searchParams;
  return <ZernioOauthWaitingClient turnId={params.turnId ?? ''} returnTo={safeReturnTo(params.returnTo ?? null)} />;
}

