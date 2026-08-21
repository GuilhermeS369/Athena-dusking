import { NextResponse } from 'next/server';

import { safeReturnTo } from '@/lib/integrations/meta-oauth';

export const dynamic = 'force-dynamic';

// Compatibilidade para links antigos. O fluxo atual nunca espera antes do
// Instagram: cada aparelho recebe um profile remoto exclusivo no /start.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
  const redirect = new URL(returnTo, url.origin);
  redirect.searchParams.set('error', 'zernio_intent_expired');
  redirect.searchParams.set('diagnostic', 'Este link pertence à fila OAuth antiga. Inicie uma nova autorização.');
  return NextResponse.redirect(redirect);
}
