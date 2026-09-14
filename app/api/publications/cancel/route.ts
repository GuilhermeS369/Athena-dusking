import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
// Uma etapa da operação é um bloco de até 1.500 itens (cabe no statement_timeout
// de ~8 s do banco) mais o begin e as releituras. O padrão de 10 s da função era
// o único orçamento não elevado entre as rotas da fila, justo na mais pesada.
export const maxDuration = 30;

const managerRoles = new Set(['admin', 'operator']);
// UUID RFC 4122: 8-4-4-4-12. O hífen entre o campo de variante e os
// 12 caracteres finais é obrigatório; sem ele, todo UUID legítimo era
// rejeitado antes de chegar à RPC de cancelamento.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cancellationScopes = new Set(['account', 'batch', 'group']);

const OPERATION_COLUMNS = 'id, scope, target_id, target_label, status, progress, result, error_message, completed_at, created_at, updated_at, last_chunk_at';
// A lista é limitada e não paginada de propósito: a tabela cresce com cliques
// do operador, não com o tamanho da fila (poucas operações por dia). 50 em 24 h
// é uma ordem de grandeza acima do uso real, e fica bem abaixo do teto do
// PostgREST.
const RECENT_OPERATIONS_LIMIT = 50;
const RECENT_OPERATIONS_WINDOW_HOURS = 24;

type CancellationOperation = {
  id: string;
  scope: 'account' | 'batch' | 'group';
  target_id: string;
  target_label: string | null;
  status: 'running' | 'completed' | 'blocked' | 'failed';
  progress: number;
  result: Record<string, unknown>;
  error_message: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string | null;
  last_chunk_at: string | null;
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
      scope: operation.scope,
      targetId: operation.target_id,
      targetLabel: operation.target_label,
      status: operation.status,
      progress: operation.progress,
      result: operation.result,
      error: operation.error_message,
      completedAt: operation.completed_at,
      createdAt: operation.created_at,
      updatedAt: operation.updated_at,
      lastChunkAt: operation.last_chunk_at,
    },
  };
}

export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return noStoreJson({ error: 'Autenticação necessária.' }, { status: 401 });

  const operationId = new URL(request.url).searchParams.get('operationId');
  const supabase = await createSupabaseServerClient();

  if (operationId === null) {
    // Fila de cancelamento da organização: tudo que correu nas últimas 24 h,
    // em execução primeiro. É o que a tela restaura ao abrir, em vez de guardar
    // uma operação só no navegador.
    const since = new Date(Date.now() - RECENT_OPERATIONS_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('publication_queue_cancellation_operations')
      .select(OPERATION_COLUMNS)
      .eq('organization_id', context.activeOrganization.id)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(RECENT_OPERATIONS_LIMIT);
    if (error) return noStoreJson({ error: 'Não foi possível listar os cancelamentos.' }, { status: 500 });
    const operations = ((data ?? []) as CancellationOperation[])
      .sort((left, right) => {
        const leftRunning = left.status === 'running' ? 0 : 1;
        const rightRunning = right.status === 'running' ? 0 : 1;
        if (leftRunning !== rightRunning) return leftRunning - rightRunning;
        return right.created_at.localeCompare(left.created_at);
      })
      .map((operation) => operationPayload(operation).operation);
    return noStoreJson({ operations });
  }

  if (!uuidPattern.test(operationId)) return noStoreJson({ error: 'Operação inválida.' }, { status: 400 });
  const { data, error } = await supabase
    .from('publication_queue_cancellation_operations')
    .select(OPERATION_COLUMNS)
    .eq('id', operationId)
    .eq('organization_id', context.activeOrganization.id)
    .maybeSingle();
  if (error || !data) return noStoreJson({ error: 'Operação de cancelamento não encontrada.' }, { status: 404 });
  return noStoreJson(operationPayload(data as CancellationOperation));
}

async function readOperation(operationId: string, organizationId: string) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('publication_queue_cancellation_operations')
    .select(OPERATION_COLUMNS)
    .eq('id', operationId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  return (data ?? null) as CancellationOperation | null;
}

/**
 * Avança UMA etapa da operação: as fontes na primeira chamada, depois um bloco
 * de até 1.500 itens por chamada, ou a conclusão. Quem avança de verdade é o
 * worker da VPS; o navegador chama isto ao iniciar (primeiro bloco na hora) e
 * como reserva quando ninguém mexeu na operação há mais de 15 s.
 */
async function executeOperation(current: CancellationOperation, organizationId: string) {
  // A RPC foi desenhada para exigir `auth.uid()` do solicitante. A execução
  // longa pode perder a sessão do navegador; a rota já autenticou usuário,
  // organização e papel, então a execução administrativa é delimitada pelo id
  // criado para esse usuário, e a RPC repõe os claims dele.
  const executor = createSupabaseAdminClient();
  const { data: result, error } = await executor.rpc('execute_server_publication_queue_cancellation', { p_operation_id: current.id });
  if (error) {
    // A mutação é atômica: qualquer erro na RPC faz rollback. Mantemos a
    // operação em execução para o worker ou o navegador retomarem, em vez de
    // gravar uma falha terminal que esconderia trabalho pendente.
    const persisted = await readOperation(current.id, organizationId);
    return noStoreJson({ ...operationPayload(persisted ?? current), retryable: true }, { status: 503 });
  }
  const state = (result as { state?: string } | null)?.state;
  const finished = await readOperation(current.id, organizationId);
  if (!finished) return noStoreJson({ error: 'O cancelamento terminou sem confirmação durável.' }, { status: 500 });

  // Outro executor está no meio de um bloco desta operação: nada a fazer agora.
  if (state === 'busy') return noStoreJson({ ...operationPayload(finished), busy: true }, { status: 202 });

  if (finished.status === 'completed') {
    // A tela lê um snapshot; empurrar o carimbo dele para trás faz o worker de
    // resumo recalcular no próximo tick, sem agregar nada nesta requisição.
    const { error: invalidateError } = await executor.rpc('invalidate_publication_queue_summary', { p_organization_id: organizationId });
    if (invalidateError) console.error('Não foi possível invalidar o resumo da fila após o cancelamento.', { organizationId, message: invalidateError.message });
  }
  if (finished.status === 'blocked') return noStoreJson({ ...operationPayload(finished), cancellation: result }, { status: 409 });
  if (finished.status === 'failed') return noStoreJson(operationPayload(finished), { status: 500 });
  // 'running' é resposta normal: esta chamada processou uma etapa e devolveu
  // progresso real; o worker (ou o navegador, como reserva) chama de novo.
  return noStoreJson(operationPayload(finished));
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  const role = context.organizations.find((organization) => organization.id === context.activeOrganization?.id)?.role;
  if (!context.user || !context.activeOrganization) return noStoreJson({ error: 'Autenticação necessária.' }, { status: 401 });
  if (!role || !managerRoles.has(role)) return noStoreJson({ error: 'Ação não permitida.' }, { status: 403 });
  const organizationId = context.activeOrganization.id;

  let body: { scope?: unknown; targetId?: unknown; idempotencyKey?: unknown; execute?: unknown; operationId?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return noStoreJson({ error: 'Requisição inválida.' }, { status: 400 });
  }

  // Avançar uma operação já existente. Passa ao largo do `begin` de propósito:
  // com a lista da tela atrasada, `begin` para um alvo cuja operação acabou de
  // concluir criaria uma operação NOVA em vez de retomar a antiga.
  if (typeof body.operationId === 'string') {
    if (!uuidPattern.test(body.operationId)) return noStoreJson({ error: 'Operação inválida.' }, { status: 400 });
    const current = await readOperation(body.operationId, organizationId);
    if (!current) return noStoreJson({ error: 'Operação de cancelamento não encontrada.' }, { status: 404 });
    if (current.status !== 'running') return noStoreJson(operationPayload(current));
    return executeOperation(current, organizationId);
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

  const current = started as CancellationOperation;
  if (body.execute !== true || current.status !== 'running') {
    return noStoreJson(operationPayload(current), { status: current.status === 'running' ? 202 : current.status === 'blocked' ? 409 : 200 });
  }
  return executeOperation(current, organizationId);
}
