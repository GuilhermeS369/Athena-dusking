import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

type QueueSummaryRow = {
  status: string;
  total: number;
  expired_leases: number;
  due_retries: number;
  overdue: number;
};

function authorized(request: Request) {
  const expected = process.env.PUBLICATION_WORKER_SECRET;
  const supplied = request.headers.get('x-publication-worker-secret')
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });

  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.rpc('get_publication_queue_operational_summary', {
      p_organization_id: null,
    });

    if (error) return NextResponse.json({ error: 'Não foi possível consultar a fila.' }, { status: 500 });

    const rows = (data ?? []) as QueueSummaryRow[];
    const counts = rows.reduce((result: Record<string, number>, item) => {
      result[item.status] = (result[item.status] ?? 0) + item.total;
      return result;
    }, {});
    const activeItems = rows.reduce((total, item) => total + item.total, 0);
    const expiredLeases = rows.reduce((total, item) => total + item.expired_leases, 0);
    const dueRetries = rows.reduce((total, item) => total + item.due_retries, 0);
    const overdue = rows.reduce((total, item) => total + item.overdue, 0);

    return NextResponse.json({
      ok: true,
      queue: { counts, activeItems, expiredLeases, dueRetries, overdue },
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Falha no health check da fila.', error);
    return NextResponse.json({ error: 'Worker não configurado.' }, { status: 503 });
  }
}
