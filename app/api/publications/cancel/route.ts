import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const managerRoles = new Set(['admin', 'operator']);
// UUID RFC 4122: 8-4-4-4-12. O hífen entre o campo de variante e os
// 12 caracteres finais é obrigatório; sem ele, todo UUID legítimo era
// rejeitado antes de chegar à RPC de cancelamento.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cancellationScopes = new Set(['account', 'batch', 'group']);

type CancellationOperation = {
  id: string;
  status: 'running' | 'completed' | 'blocked' | 'failed';
  progress: number;
  result: Record<string, unknown>;
  error_message: string | null;
  completed_at: string | null;
  created_at: string;
};

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json(body, { ...init, headers });
}

function operationPayload(operation: CancellationOperation) {
  return {
    operation: {
      id: operation.id,
      status: operation.status,
      progress: operation.progress,
      result: operation.result,
      error: operation.error_message,
      completedAt: operation.completed_at,
      createdAt: operation.created_at,
    },
  };
}

export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return noStoreJson({ error: 'Autenticação necessária.' }, { status: 401 });

  const operationId = new URL(request.url).searchParams.get('operationId');
  if (!operationId || !uuidPattern.test(operationId)) return noStoreJson({ error: 'Operação inválida.' }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('publication_queue_cancellation_operations')
    .select('id, status, progress, result, error_message, completed_at, created_at')
    .eq('id', operationId)
    .eq('organization_id', context.activeOrganization.id)
    .maybeSingle();
  if (error || !data) return noStoreJson({ error: 'Operação de cancelamento não encontrada.' }, { status: 404 });
  return noStoreJson(operationPayload(data as CancellationOperation));
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  const role = context.organizations.find((organization) => organization.id === context.activeOrganization?.id)?.role;
  if (!context.user || !context.activeOrganization) return noStoreJson({ error: 'Autenticação necessária.' }, { status: 401 });
  if (!role || !managerRoles.has(role)) return noStoreJson({ error: 'Ação não permitida.' }, { status: 403 });

  let body: { scope?: unknown; targetId?: unknown; idempotencyKey?: unknown; execute?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return noStoreJson({ error: 'Requisição inválida.' }, { status: 400 });
  }
  if (typeof body.scope !== 'string' || !cancellationScopes.has(body.scope) || typeof body.targetId !== 'string' || !uuidPattern.test(body.targetId)) {
    return noStoreJson({ error: 'Informe um escopo e um destino válidos para cancelar.' }, { status: 400 });
  }
  const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim().length >= 16
    ? body.idempotencyKey.trim().slice(0, 240)
    : randomUUID();

  const supabase = await createSupabaseServerClient();
  const { data: started, error: startError } = await supabase.rpc('begin_publication_queue_cancellation', {
    p_scope: body.scope,
    p_target_id: body.targetId,
    p_idempotency_key: idempotencyKey,
  });
  if (startError || !started) return noStoreJson({ error: startError?.message || 'Não foi possível iniciar o cancelamento.' }, { status: 500 });

  let current = started as CancellationOperation;
  if (body.execute !== true) {
    return noStoreJson(operationPayload(current), { status: current.status === 'running' ? 202 : current.status === 'blocked' ? 409 : 200 });
  }
  if (current.status === 'running') {
    // A RPC foi desenhada para exigir `auth.uid()` do solicitante. A chamada
    // anterior usava o cliente autenticado no navegador, mas a execução longa
    // pode perder a sessão durante o polling e deixar a operação durável presa
    // em 5%. A rota já autenticou usuário, organização e papel; portanto a
    // execução administrativa é delimitada pelo id criado para esse usuário.
    const executor = createSupabaseAdminClient();
    const { data: result, error } = await executor.rpc('execute_server_publication_queue_cancellation', { p_operation_id: current.id });
    if (error) {
      const { data: persisted } = await supabase
        .from('publication_queue_cancellation_operations')
        .select('id, status, progress, result, error_message, completed_at, created_at')
        .eq('id', current.id)
        .maybeSingle();
      // A mutação é atômica: qualquer erro na RPC faz rollback. Mantemos a
      // operação em execução para que o navegador possa retomá-la após reload,
      // em vez de gravar uma falha terminal que esconderia trabalho pendente.
      return noStoreJson(operationPayload((persisted ?? current) as CancellationOperation), { status: 503 });
    }
    const { data: finished, error: finishedError } = await supabase
      .from('publication_queue_cancellation_operations')
      .select('id, status, progress, result, error_message, completed_at, created_at')
      .eq('id', current.id)
      .single();
    if (finishedError || !finished) return noStoreJson({ error: 'O cancelamento terminou sem confirmação durável.' }, { status: 500 });
    current = finished as CancellationOperation;
    if (current.status === 'blocked') return noStoreJson({ ...operationPayload(current), cancellation: result }, { status: 409 });
  }

  if (current.status !== 'completed') return noStoreJson(operationPayload(current), { status: current.status === 'blocked' ? 409 : 500 });
  return noStoreJson(operationPayload(current));
}
