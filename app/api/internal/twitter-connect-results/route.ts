import { NextResponse } from 'next/server';
import { encryptTwitterAuthUrl } from '@/lib/twitter/connection-intents';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterWorkerAuthorized } from '@/lib/twitter/worker-auth';
import { applyTwitterProfileAccount } from '@/lib/twitter/zernio-profiles';
import { stableZernioAccountId, type TwitterZernioAccount, type TwitterZernioHealth } from '@/lib/twitter/zernio-client';
import { safelyRecordTwitterObservabilityEvent } from '@/lib/twitter/observability-server';

export async function POST(request: Request) {
  if (!isTwitterWorkerAuthorized(request, 'connect')) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.intentId !== 'string' || typeof body.claimToken !== 'string' || typeof body.succeeded !== 'boolean' || (body.phase !== 'prepare' && body.phase !== 'reconcile')) return NextResponse.json({ error: 'Resultado OAuth X inválido.' }, { status: 400 });
  const admin = createSupabaseAdminClient();
  const { data: intentContext } = await admin.from('twitter_connection_intents').select('organization_id,connection_id,profile_id').eq('id', body.intentId).maybeSingle();
  if (!intentContext) return NextResponse.json({ error: 'Intent OAuth X não encontrado.' }, { status: 404 });
  if (!body.succeeded) {
    const errorCode = typeof body.errorCode === 'string' ? body.errorCode.slice(0, 120) : 'connect_failed';
    const errorMessage = typeof body.errorMessage === 'string' ? body.errorMessage.slice(0, 700) : 'Falha na conexão X.';
    const transient = body.phase === 'reconcile' && errorCode === 'account_not_propagated'
      || ['408','425','429','500','502','503','504','ETIMEDOUT','ECONNRESET','fetch_failed'].includes(errorCode);
    if (transient) {
      const { data, error } = await admin.rpc('twitter_retry_connection_intent', {
        p_intent_id: body.intentId, p_claim_token: body.claimToken,
        p_error_code: errorCode, p_error_message: errorMessage,
      });
      if (!error) {
        await safelyRecordTwitterObservabilityEvent(admin, { organizationId: intentContext.organization_id, domain: 'connection', severity: 'warning', stage: `oauth_${body.phase}`, eventType: 'oauth_retry', stableCode: errorCode, message: errorMessage, sourceType: 'connection_intent_result', sourceId: `${body.intentId}:${body.claimToken}:retry`, connectionId: intentContext.connection_id, jobId: body.intentId, workerName: 'athena-twitter-connect-worker', evidence: { transient: true } });
        return NextResponse.json(data, { status: 202 });
      }
    }
    const { data, error } = await admin.rpc('twitter_complete_connection_intent', { p_intent_id: body.intentId, p_claim_token: body.claimToken, p_succeeded: false, p_profile_id: null, p_error_code: typeof body.errorCode === 'string' ? body.errorCode : null, p_error_message: typeof body.errorMessage === 'string' ? body.errorMessage : null });
    return error ? NextResponse.json({ error: 'Claim OAuth X expirado.' }, { status: 409 }) : NextResponse.json(data);
  }
  if (body.phase === 'prepare') {
    if (typeof body.authUrl !== 'string' || !/^https:\/\//.test(body.authUrl)) return NextResponse.json({ error: 'URL OAuth X inválida.' }, { status: 400 });
    const { data, error } = await admin.rpc('twitter_mark_connection_intent_ready', { p_intent_id: body.intentId, p_claim_token: body.claimToken, p_encrypted_auth_url: encryptTwitterAuthUrl(body.authUrl) });
    return error ? NextResponse.json({ error: 'Claim OAuth X expirado.' }, { status: 409 }) : NextResponse.json(data);
  }
  if (!body.account || typeof body.account !== 'object') return NextResponse.json({ error: 'Conta X reconciliada ausente.' }, { status: 400 });
  const { data: intent } = await admin.from('twitter_connection_intents').select('organization_id,connection_id,returned_account_id,status,claim_token,created_by').eq('id', body.intentId).maybeSingle();
  const account = body.account as TwitterZernioAccount;
  if (!intent || intent.status !== 'reconciling' || intent.claim_token !== body.claimToken || stableZernioAccountId(account) !== intent.returned_account_id) return NextResponse.json({ error: 'Conta X não corresponde ao intent.' }, { status: 409 });
  try {
    const { error: capabilityError } = await admin.rpc('twitter_set_connection_capabilities', {
      p_organization_id: intent.organization_id,
      p_connection_id: intent.connection_id,
      p_analytics_enabled: true,
      p_inbox_enabled: false,
      p_actor_user_id: intent.created_by,
      p_actor_email: null,
      p_justification: 'Ativação obrigatória ao conectar um perfil X pela tela de perfis.',
      p_idempotency_key: `profile-connect-analytics:${body.intentId}`,
    });
    if (capabilityError) throw new Error('O Analytics obrigatório não pôde ser ativado para a conexão X.');
    const health = { ...((body.health as TwitterZernioHealth | undefined) ?? {}), canFetchAnalytics: true } as TwitterZernioHealth;
    const profile = await applyTwitterProfileAccount(intent.organization_id, intent.connection_id, account, health);
    const { data, error } = await admin.rpc('twitter_complete_connection_intent', { p_intent_id: body.intentId, p_claim_token: body.claimToken, p_succeeded: true, p_profile_id: profile.profileId, p_error_code: null, p_error_message: null });
    return error ? NextResponse.json({ error: 'Falha ao concluir intent X.' }, { status: 409 }) : NextResponse.json(data);
  } catch (error) {
    await admin.rpc('twitter_complete_connection_intent', { p_intent_id: body.intentId, p_claim_token: body.claimToken, p_succeeded: false, p_profile_id: null, p_error_code: 'reconciliation_failed', p_error_message: error instanceof Error ? error.message : 'Falha na reconciliação X.' });
    const message = error instanceof Error ? error.message : 'Falha na reconciliação X.';
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
