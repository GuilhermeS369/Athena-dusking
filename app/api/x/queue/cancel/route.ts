import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const scopes = new Set(['account', 'batch', 'group', 'item']);

type OperationRow = {
  id: string; scope: 'account' | 'batch' | 'group' | 'item'; target_id: string | null;
  target_profile_ids: string[]; target_label: string; reason: string; idempotency_key: string;
  status: 'running' | 'completed' | 'failed'; progress: number; result: Record<string, unknown>;
  error_message: string | null; completed_at: string | null; created_at: string;
};

function json(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers); headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json(body, { ...init, headers });
}
function payload(row: OperationRow) {
  return { operation: { id: row.id, scope: row.scope, targetId: row.target_id, targetLabel: row.target_label, status: row.status, progress: row.progress, result: row.result, error: row.error_message, completedAt: row.completed_at, createdAt: row.created_at, idempotencyKey: row.idempotency_key } };
}
async function findOperation(operationId: string, organizationId: string) {
  const { data, error } = await createSupabaseAdminClient().from('twitter_queue_cancellation_operations')
    .select('id,scope,target_id,target_profile_ids,target_label,reason,idempotency_key,status,progress,result,error_message,completed_at,created_at')
    .eq('id', operationId).eq('organization_id', organizationId).maybeSingle();
  return { row: data as OperationRow | null, error };
}

export async function GET(request: Request) {
  const auth = await getTwitterRequestContext(); if ('response' in auth) return auth.response;
  const operationId = new URL(request.url).searchParams.get('operationId');
  if (!operationId || !uuid.test(operationId)) return json({ error: 'Operação de cancelamento inválida.' }, { status: 400 });
  const { row, error } = await findOperation(operationId, auth.context.activeOrganization.id);
  if (error || !row) return json({ error: 'Operação de cancelamento não encontrada.' }, { status: 404 });
  return json(payload(row));
}

export async function POST(request: Request) {
  const auth = await getTwitterRequestContext('operator'); if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const organizationId = auth.context.activeOrganization.id;
  const admin = createSupabaseAdminClient();

  if (typeof body.operationId === 'string') {
    if (!uuid.test(body.operationId) || body.execute !== true) return json({ error: 'Execução de cancelamento inválida.' }, { status: 400 });
    const { row, error } = await findOperation(body.operationId, organizationId);
    if (error || !row) return json({ error: 'Operação de cancelamento não encontrada.' }, { status: 404 });
    if (row.status !== 'running') return json(payload(row));
    const { error: cancelError } = await admin.rpc('twitter_process_queue_cancellation_operation', { p_operation_id: row.id, p_limit: 500 });
    if (cancelError) {
      await admin.from('twitter_queue_cancellation_operations').update({ status: 'failed', progress: 100, error_message: 'Não foi possível confirmar o cancelamento financeiro seguro.', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', row.id);
      const failed = await findOperation(row.id, organizationId);
      return json(failed.row ? payload(failed.row) : { error: 'Não foi possível cancelar a fila X.' }, { status: 409 });
    }
    const finished = await findOperation(row.id, organizationId);
    return finished.row ? json(payload(finished.row)) : json({ error: 'O cancelamento terminou sem confirmação durável.' }, { status: 500 });
  }

  const scope = typeof body.scope === 'string' && scopes.has(body.scope) ? body.scope as OperationRow['scope'] : null;
  const targetId = typeof body.targetId === 'string' && uuid.test(body.targetId) ? body.targetId : null;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const targetLabel = typeof body.targetLabel === 'string' ? body.targetLabel.trim().slice(0, 200) : '';
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim().slice(0, 255) : '';
  if (!scope || reason.length < 4 || reason.length > 1000 || !targetLabel || idempotencyKey.length < 8 || !targetId) return json({ error: 'Informe um escopo, um motivo e um destino válidos para cancelar.' }, { status: 400 });

  const insert = { organization_id: organizationId, requested_by: auth.context.user.id, scope, target_id: targetId, target_profile_ids: [], target_label: targetLabel, reason, idempotency_key: idempotencyKey };
  const { data, error } = await admin.from('twitter_queue_cancellation_operations').upsert(insert, { onConflict: 'organization_id,idempotency_key', ignoreDuplicates: true })
    .select('id,scope,target_id,target_profile_ids,target_label,reason,idempotency_key,status,progress,result,error_message,completed_at,created_at').maybeSingle();
  if (error) return json({ error: 'Não foi possível iniciar o cancelamento da fila X.' }, { status: 500 });
  if (data) {
    const created=data as OperationRow;
    if(scope==='group'){
      const {data:members,error:membersError}=await admin.from('twitter_group_members').select('profile_id').eq('organization_id',organizationId).eq('group_id',targetId);
      if(membersError){await admin.from('twitter_queue_cancellation_operations').update({status:'failed',progress:100,error_message:'Não foi possível congelar a composição do grupo X.',completed_at:new Date().toISOString()}).eq('id',created.id);return json({error:'Não foi possível congelar a composição do grupo X.'},{status:500});}
      if((members??[]).length){const {error:targetsError}=await admin.from('twitter_queue_cancellation_targets').upsert((members??[]).map(member=>({operation_id:created.id,profile_id:member.profile_id})),{onConflict:'operation_id,profile_id'});if(targetsError){await admin.from('twitter_queue_cancellation_operations').update({status:'failed',progress:100,error_message:'Não foi possível persistir o snapshot do grupo X.',completed_at:new Date().toISOString()}).eq('id',created.id);return json({error:'Não foi possível congelar a composição do grupo X.'},{status:500});}}
    }
    return json(payload(created), { status: created.status === 'running' ? 202 : 200 });
  }
  const { data: replay } = await admin.from('twitter_queue_cancellation_operations').select('id,scope,target_id,target_profile_ids,target_label,reason,idempotency_key,status,progress,result,error_message,completed_at,created_at').eq('organization_id', organizationId).eq('idempotency_key', idempotencyKey).single();
  return json(payload(replay as OperationRow), { status: (replay as OperationRow).status === 'running' ? 202 : 200 });
}
