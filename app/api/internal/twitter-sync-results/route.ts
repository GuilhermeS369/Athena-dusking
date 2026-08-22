import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { applyTwitterProfileInventory } from '@/lib/twitter/zernio-profiles';
import {
  type TwitterZernioAccount,
  type TwitterZernioHealth,
} from '@/lib/twitter/zernio-client';
import { isTwitterWorkerAuthorized } from '@/lib/twitter/worker-auth';

type ResultBody = {
  jobId?: unknown;
  claimToken?: unknown;
  succeeded?: unknown;
  accounts?: unknown;
  health?: unknown;
  errorCode?: unknown;
  errorMessage?: unknown;
};

export async function POST(request: Request) {
  if (!isTwitterWorkerAuthorized(request, 'sync')) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as ResultBody;
  if (
    typeof body.jobId !== 'string' ||
    typeof body.claimToken !== 'string' ||
    typeof body.succeeded !== 'boolean'
  ) {
    return NextResponse.json({ error: 'Resultado de sync X inválido.' }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { data: job, error: jobError } = await admin
    .from('twitter_sync_jobs')
    .select('id,organization_id,connection_id,status,claim_token')
    .eq('id', body.jobId)
    .single();
  if (
    jobError ||
    !job ||
    job.status !== 'processing' ||
    job.claim_token !== body.claimToken
  ) {
    return NextResponse.json({ error: 'Claim de sync X expirado.' }, { status: 409 });
  }

  if (!body.succeeded) {
    const { data, error } = await admin.rpc('twitter_complete_sync_job', {
      p_job_id: job.id,
      p_claim_token: body.claimToken,
      p_succeeded: false,
      p_result: {},
      p_error_code:
        typeof body.errorCode === 'string' ? body.errorCode.slice(0, 120) : null,
      p_error_message:
        typeof body.errorMessage === 'string'
          ? body.errorMessage.slice(0, 700)
          : null,
    });
    return error
      ? NextResponse.json({ error: 'Falha ao concluir sync X.' }, { status: 409 })
      : NextResponse.json(data);
  }

  if (!Array.isArray(body.accounts) || !Array.isArray(body.health)) {
    return NextResponse.json({ error: 'Inventário X inválido.' }, { status: 400 });
  }
  if (body.accounts.length > 500 || body.health.length > 500) {
    return NextResponse.json({ error: 'Inventário X excede o limite.' }, { status: 413 });
  }

  try {
    const result = await applyTwitterProfileInventory(
      job.organization_id,
      job.connection_id,
      body.accounts as TwitterZernioAccount[],
      body.health as TwitterZernioHealth[],
    );
    const { data, error } = await admin.rpc('twitter_complete_sync_job', {
      p_job_id: job.id,
      p_claim_token: body.claimToken,
      p_succeeded: true,
      p_result: result,
      p_error_code: null,
      p_error_message: null,
    });
    return error
      ? NextResponse.json({ error: 'Falha ao concluir sync X.' }, { status: 409 })
      : NextResponse.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Falha ao persistir inventário X.';
    await admin.rpc('twitter_complete_sync_job', {
      p_job_id: job.id,
      p_claim_token: body.claimToken,
      p_succeeded: false,
      p_result: {},
      p_error_code: 'inventory_apply_failed',
      p_error_message: message.slice(0, 700),
    });
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
