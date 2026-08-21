import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';

import { acquireZernioConnectionOperationLease, releaseZernioConnectionOperationLease } from '@/lib/integrations/zernio-concurrency';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await params;
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (context.activeOrganization.role !== 'admin') return NextResponse.json({ error: 'Somente administradores podem executar a exclusão total.' }, { status: 403 });

  const body = await request.json().catch(() => ({})) as { confirmation?: unknown; idempotencyKey?: unknown };
  if (body.confirmation !== 'EXCLUIR TOTALMENTE') {
    return NextResponse.json({ error: 'Confirmação inválida. Digite EXCLUIR TOTALMENTE para continuar.' }, { status: 400 });
  }
  const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim().length >= 16
    ? body.idempotencyKey.trim().slice(0, 240)
    : randomUUID();

  // Esta rota é deliberadamente local: não importa cliente Zernio, não chama
  // sync/disconnect e não executa nenhuma requisição ao provedor externo.
  const holderId = await acquireZernioConnectionOperationLease(
    context.activeOrganization.id,
    connectionId,
    { leaseSeconds: 120, retries: 1 },
  ).catch(() => null);
  if (!holderId) return NextResponse.json({ error: 'Esta conta possui outra operação local em andamento. Aguarde terminar.' }, { status: 409 });

  try {
    const supabase = await createSupabaseServerClient();
    const { data: started, error: startError } = await supabase.rpc('begin_zernio_connection_total_deletion', {
      p_connection_id: connectionId,
      p_idempotency_key: idempotencyKey,
    });
    if (startError || !started) return NextResponse.json({ error: startError?.message ?? 'Não foi possível iniciar a exclusão total local.' }, { status: 400 });

    const operation = started as { id: string; status: 'running' | 'completed' | 'blocked'; result: Record<string, unknown> };
    if (operation.status !== 'running') return NextResponse.json({ operation, result: operation.result, idempotent: true });

    const { data: result, error: executionError } = await supabase.rpc('execute_zernio_connection_total_deletion', {
      p_operation_id: operation.id,
    });
    if (executionError || !result) return NextResponse.json({ error: executionError?.message ?? 'Não foi possível concluir a exclusão total local.' }, { status: 500 });

    const payload = result as { blocked?: boolean };
    return NextResponse.json({ operationId: operation.id, result }, { status: payload.blocked ? 409 : 200 });
  } finally {
    await releaseZernioConnectionOperationLease(context.activeOrganization.id, connectionId, holderId).catch(() => undefined);
  }
}
