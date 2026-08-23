import { NextResponse } from 'next/server';

import { prepareTwitterBulkReview, type TwitterBulkRequest } from '@/lib/twitter/bulk-service';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

export async function POST(request: Request) {
  const auth = await getTwitterRequestContext('operator');
  if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => null) as TwitterBulkRequest | null;
  if (!body) return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
  try {
    const review = await prepareTwitterBulkReview(auth.context.activeOrganization.id, body);
    return NextResponse.json({
      reviewToken: review.reviewToken,
      rateCardVersion: review.rateCardVersion,
      totalRequested: review.totalRequested,
      fundedCount: review.fundedCount,
      unfundedCount: review.unfundedCount,
      reservedMicros: review.reservedMicros,
      costBreakdown: review.costBreakdown,
      walletSnapshots: review.walletSnapshots,
      shortfalls: review.shortfalls,
      schedule: review.schedule,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Falha na revisão X.' }, { status: 400 });
  }
}
