import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const scopes = new Set(['account', 'batch', 'group']);

export async function GET(request: Request) {
  const context = await getOrganizationContext();

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const scope = searchParams.get('scope') ?? 'account';
  const requestedLimit = Number.parseInt(searchParams.get('limit') ?? '25', 10);
  const requestedOffset = Number.parseInt(searchParams.get('offset') ?? '0', 10);
  // Janela de histórico publicado. O teto de 168 h não é arbitrário: a migration
  // 333 apaga da tabela quente o que foi arquivado há mais de 7 dias, então
  // acima disso a contagem viria incompleta sem nenhum erro. A RPC aplica o
  // mesmo corte; aqui ele é explícito para a requisição ser recusada em vez de
  // silenciosamente reduzida.
  const requestedHistoryHours = Number.parseInt(searchParams.get('historyHours') ?? '24', 10);
  if (!scopes.has(scope)) {
    return NextResponse.json({ error: 'Agrupamento da fila inválido.' }, { status: 400 });
  }
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    return NextResponse.json({ error: 'Limite da página inválido.' }, { status: 400 });
  }
  if (!Number.isInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > 1_000_000) {
    return NextResponse.json({ error: 'Cursor da página inválido.' }, { status: 400 });
  }
  if (!Number.isInteger(requestedHistoryHours) || requestedHistoryHours < 1 || requestedHistoryHours > 168) {
    return NextResponse.json({ error: 'Janela de histórico da fila inválida.' }, { status: 400 });
  }

  const startedAt = performance.now();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('get_publication_queue_reference_page', {
    p_organization_id: context.activeOrganization.id,
    p_scope: scope,
    p_limit: requestedLimit,
    p_offset: requestedOffset,
    p_history_hours: requestedHistoryHours,
  });

  if (error) {
    console.error('Não foi possível carregar página do resumo operacional da fila.', {
      scope,
      offset: requestedOffset,
      durationMs: Math.round(performance.now() - startedAt),
      code: error.code,
      message: error.message,
    });
    return NextResponse.json({ error: 'Não foi possível carregar o resumo da fila.' }, { status: 500 });
  }

  const durationMs = Math.round(performance.now() - startedAt);
  return NextResponse.json(data ?? { historyHours: requestedHistoryHours, totals: {}, rows: [], page: { scope, offset: 0, limit: requestedLimit, totalCount: 0, hasMore: false } }, {
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'Server-Timing': `queue-summary;dur=${durationMs}`,
    },
  });
}
