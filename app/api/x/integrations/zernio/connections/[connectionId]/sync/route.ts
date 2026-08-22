import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

export async function POST(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const auth = await getTwitterRequestContext('operator');
  if ('response' in auth) return auth.response;
  const { connectionId } = await params;
  const body = await request.json().catch(() => ({})) as { idempotencyKey?: unknown };
  if (typeof body.idempotencyKey !== 'string') {
    return NextResponse.json({ error: 'Idempotency key obrigatória.' }, { status: 400 });
  }
  try {
    const { data, error } = await createSupabaseAdminClient().rpc('twitter_enqueue_sync_job', {
      p_organization_id: auth.context.activeOrganization.id,
      p_connection_id: connectionId,
      p_actor_user_id: auth.context.user.id,
      p_idempotency_key: body.idempotencyKey,
    });
    if (error) throw error;
    return NextResponse.json(data, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Não foi possível enfileirar a sincronização X.' }, { status: 400 });
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const auth = await getTwitterRequestContext();
  if ('response' in auth) return auth.response;
  const { connectionId } = await params;
  const jobId = new URL(request.url).searchParams.get('jobId');
  if (!jobId) return NextResponse.json({ error: 'Job ID obrigatório.' }, { status: 400 });
  const { data, error } = await createSupabaseAdminClient().from('twitter_sync_jobs')
    .select('id,status,result,error_code,error_message,attempt_count,created_at,started_at,finished_at')
    .eq('id', jobId).eq('connection_id', connectionId)
    .eq('organization_id', auth.context.activeOrganization.id).single();
  return error || !data
    ? NextResponse.json({ error: 'Job de sync X não encontrado.' }, { status: 404 })
    : NextResponse.json(data);
}
