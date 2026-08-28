import { NextResponse } from 'next/server';

import { getTwitterRequestContext } from '@/lib/twitter/request-context';
import {
  isTwitterAnalyticsRequest,
  prepareTwitterAnalyticsQuote,
} from '@/lib/twitter/analytics-service';
import { isTwitterAnalyticsEnabled } from '@/lib/twitter/feature';

export async function POST(request: Request) {
  // Analytics manuais são auditados por created_by e, por decisão de produto,
  // podem ser confirmados por qualquer membro da organização.
  const auth = await getTwitterRequestContext();
  if ('response' in auth) return auth.response;
  if (!isTwitterAnalyticsEnabled(auth.context.activeOrganization.id)) {
    return NextResponse.json(
      { error: 'Análises X estão desabilitadas.' },
      { status: 404 },
    );
  }

  const body = await request.json().catch(() => null);
  if (!isTwitterAnalyticsRequest(body)) {
    return NextResponse.json({ error: 'Seleção inválida.' }, { status: 400 });
  }

  try {
    return NextResponse.json(
      await prepareTwitterAnalyticsQuote(
        auth.context.activeOrganization.id,
        body,
      ),
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Falha na cotação.' },
      { status: (error as { status?: number }).status ?? 400 },
    );
  }
}
