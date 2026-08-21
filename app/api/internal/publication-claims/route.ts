import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

function isAuthorized(request: Request) {
  const expectedSecret = process.env.PUBLICATION_WORKER_SECRET;
  const suppliedSecret = request.headers.get('x-publication-worker-secret');

  return Boolean(expectedSecret && suppliedSecret && expectedSecret === suppliedSecret);
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }

  let body: { workerId?: unknown; limit?: unknown; leaseSeconds?: unknown } = {};
  try {
    body = await request.json() as typeof body;
  } catch {
    // O corpo é opcional: o worker pode usar os valores padrão seguros.
  }

  const workerId = typeof body.workerId === 'string' && body.workerId.trim().length >= 3
    ? body.workerId.trim().slice(0, 120)
    : `vercel-${randomUUID()}`;
  const limit = typeof body.limit === 'number' && Number.isInteger(body.limit) ? body.limit : 10;
  const leaseSeconds = typeof body.leaseSeconds === 'number' && Number.isInteger(body.leaseSeconds)
    ? body.leaseSeconds
    : 120;

  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.rpc('claim_publication_items', {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    });

    if (error) {
      console.error('Falha ao reivindicar itens de publicação.', { code: error.code, message: error.message });
      return NextResponse.json({ error: 'Não foi possível reivindicar itens da fila.' }, { status: 500 });
    }

    return NextResponse.json({ workerId, items: data ?? [] });
  } catch (error) {
    console.error('Configuração do worker de publicação indisponível.', error);
    return NextResponse.json({ error: 'Worker de publicação não configurado.' }, { status: 503 });
  }
}
