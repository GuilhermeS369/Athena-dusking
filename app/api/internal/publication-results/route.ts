import { NextResponse } from 'next/server';

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

  let body: {
    itemId?: unknown;
    workerId?: unknown;
    outcome?: unknown;
    metaMediaId?: unknown;
    errorCode?: unknown;
    errorMessage?: unknown;
    retryable?: unknown;
  };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Corpo da requisição inválido.' }, { status: 400 });
  }

  if (
    typeof body.itemId !== 'string'
    || typeof body.workerId !== 'string'
    || !['published', 'failed'].includes(String(body.outcome))
  ) {
    return NextResponse.json({ error: 'Resultado de publicação inválido.' }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.rpc('complete_publication_item', {
      p_item_id: body.itemId,
      p_worker_id: body.workerId,
      p_outcome: body.outcome,
      p_meta_media_id: typeof body.metaMediaId === 'string' ? body.metaMediaId : null,
      p_error_code: typeof body.errorCode === 'string' ? body.errorCode : null,
      p_error_message: typeof body.errorMessage === 'string' ? body.errorMessage : null,
      p_retryable: body.retryable === true,
    });

    if (error) {
      const status = error.code === 'P0002' ? 409 : 500;
      console.error('Falha ao concluir item de publicação.', { code: error.code, message: error.message });
      return NextResponse.json({ error: 'Não foi possível concluir o item da fila.' }, { status });
    }

    return NextResponse.json({ item: data?.[0] ?? null });
  } catch (error) {
    console.error('Configuração do worker de publicação indisponível.', error);
    return NextResponse.json({ error: 'Worker de publicação não configurado.' }, { status: 503 });
  }
}
