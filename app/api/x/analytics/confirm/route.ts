import { NextResponse } from 'next/server';

import { getTwitterRequestContext } from '@/lib/twitter/request-context';
import {
  confirmTwitterAnalyticsQuote,
  isTwitterAnalyticsRequest,
} from '@/lib/twitter/analytics-service';
import { isTwitterAnalyticsEnabled } from '@/lib/twitter/feature';

export async function POST(request: Request) {
  const auth = await getTwitterRequestContext();
  if ('response' in auth) return auth.response;
  if (!isTwitterAnalyticsEnabled(auth.context.activeOrganization.id)) {
    return NextResponse.json(
      { error: 'Análises X estão desabilitadas.' },
      { status: 404 },
    );
  }

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (
    !body ||
    !isTwitterAnalyticsRequest(body.request) ||
    typeof body.reviewToken !== 'string' ||
    typeof body.idempotencyKey !== 'string' ||
    body.idempotencyKey.length < 8 ||
    body.idempotencyKey.length > 200
  ) {
    return NextResponse.json({ error: 'Confirmação inválida.' }, { status: 400 });
  }

  try {
    return NextResponse.json(
      await confirmTwitterAnalyticsQuote({
        organizationId: auth.context.activeOrganization.id,
        actorUserId: auth.context.user.id,
        request: body.request,
        reviewToken: body.reviewToken,
        idempotencyKey: body.idempotencyKey,
      }),
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Falha na confirmação.',
      },
      { status: (error as { status?: number }).status ?? 400 },
    );
  }
}
