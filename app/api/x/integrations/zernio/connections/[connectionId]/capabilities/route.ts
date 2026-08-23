import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterZernioAnalyticsSyncEnabled } from '@/lib/twitter/feature';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';
import { loadTwitterZernioConnection } from '@/lib/twitter/zernio-connections';

type CapabilityBody = {
  analyticsEnabled?: unknown;
  justification?: unknown;
  idempotencyKey?: unknown;
};

export async function PATCH(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const auth = await getTwitterRequestContext('admin');
  if ('response' in auth) return auth.response;
  const { connectionId } = await params;
  const body = await request.json().catch(() => ({})) as CapabilityBody;
  const analyticsEnabled = body.analyticsEnabled;
  const justification = typeof body.justification === 'string' ? body.justification.trim() : '';
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  const organizationId = auth.context.activeOrganization.id;

  if (typeof analyticsEnabled !== 'boolean') {
    return NextResponse.json({ error: 'Informe se o Analytics sync deve ficar ativo.' }, { status: 400 });
  }
  if (justification.length < 8 || justification.length > 1_000 || idempotencyKey.length < 8 || idempotencyKey.length > 255) {
    return NextResponse.json({ error: 'Justificativa e idempotency key válidas são obrigatórias.' }, { status: 400 });
  }
  if (analyticsEnabled && !isTwitterZernioAnalyticsSyncEnabled(organizationId)) {
    return NextResponse.json({ error: 'O gate exclusivo do Analytics sync da Zernio está desligado para esta organização.' }, { status: 409 });
  }

  const admin = createSupabaseAdminClient();
  try {
    const [{ client }, epochsResult] = await Promise.all([
      loadTwitterZernioConnection(organizationId, connectionId),
      admin.from('twitter_profile_connection_epochs')
        .select('zernio_account_id')
        .eq('organization_id', organizationId)
        .eq('connection_id', connectionId)
        .is('ended_at', null),
    ]);
    if (epochsResult.error) throw epochsResult.error;
    const accountIds = [...new Set((epochsResult.data ?? []).map((epoch) => epoch.zernio_account_id).filter(Boolean))];
    if (accountIds.length === 0) {
      return NextResponse.json({ error: 'Sincronize ao menos um perfil X antes de alterar o Analytics sync.' }, { status: 409 });
    }

    const record = async (enabled: boolean, key: string, reason: string) => admin.rpc('twitter_set_connection_capabilities', {
      p_organization_id: organizationId,
      p_connection_id: connectionId,
      p_analytics_enabled: enabled,
      p_inbox_enabled: false,
      p_actor_user_id: auth.context.user.id,
      p_actor_email: auth.context.user.email ?? null,
      p_justification: reason,
      p_idempotency_key: key,
    });

    const localResult = await record(analyticsEnabled, idempotencyKey, justification);
    if (localResult.error) throw localResult.error;

    const remoteResults = await Promise.allSettled(accountIds.map((accountId) =>
      client.setAccountCapabilities(accountId, { analytics: analyticsEnabled })));
    const failed = remoteResults.filter((result) => result.status === 'rejected').length;
    if (failed > 0) {
      if (analyticsEnabled) {
        await Promise.allSettled(accountIds.map((accountId) =>
          client.setAccountCapabilities(accountId, { analytics: false })));
        const rollbackResult = await record(false, `capability-rollback:${randomUUID()}`, 'Rollback automático após falha parcial ao habilitar Analytics sync.');
        if (rollbackResult.error) {
          await admin.from('twitter_connections').update({ analytics_enabled: false, inbox_enabled: false })
            .eq('id', connectionId).eq('organization_id', organizationId);
        }
      }
      return NextResponse.json({
        error: analyticsEnabled
          ? 'A Zernio não confirmou todas as contas. O Athena voltou o Analytics sync para desligado.'
          : 'O Athena registrou Analytics desligado, mas a Zernio não confirmou todas as contas. Repita a desativação.',
        failedAccounts: failed,
      }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      analyticsEnabled,
      inboxEnabled: false,
      accountsUpdated: accountIds.length,
      audit: localResult.data,
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Não foi possível alterar as capabilities X pela Zernio.',
    }, { status: 400 });
  }
}
