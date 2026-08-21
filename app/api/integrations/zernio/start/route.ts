import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { createZernioConnectionAttempt, markZernioConnectionAttemptFailed, markZernioConnectionAttemptProfilePrepared, markZernioConnectionAttemptRedirected } from '@/lib/integrations/zernio-attempts';
import { listZernioInstagramAccountIds, listZernioInstagramAccountSnapshotsForConnection } from '@/lib/integrations/zernio-accounts';
import { createZernioConnectionContext } from '@/lib/integrations/zernio-client';
import { safeReturnTo } from '@/lib/integrations/meta-oauth';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

function errorRedirect(origin: string, returnTo: string, error: string, diagnostic?: string) {
  const destination = new URL(returnTo, origin);
  destination.searchParams.set('error', error);
  if (diagnostic) destination.searchParams.set('diagnostic', diagnostic.slice(0, 500));
  return NextResponse.redirect(destination);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.redirect(new URL('/login', url.origin));
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) return errorRedirect(url.origin, '/perfis', 'forbidden');

  const connectionId = url.searchParams.get('connectionId')?.trim();
  const requestedGroupId = url.searchParams.get('groupId')?.trim() || null;
  const idempotencyKey = url.searchParams.get('intentKey')?.trim() || randomUUID();
  const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
  if (!connectionId) return errorRedirect(url.origin, returnTo, 'zernio_connection_required');

  const organizationId = context.activeOrganization.id;
  const userId = context.user.id;
  const admin = createSupabaseAdminClient();
  let intentId: string | null = null;
  let attemptId: string | null = null;

  try {
    const { data: claimedIntent, error: intentError } = await admin.rpc('claim_zernio_connection_intent', {
      p_organization_id: organizationId,
      p_created_by: userId,
      p_idempotency_key: idempotencyKey,
      p_requested_connection_id: connectionId,
      p_requested_group_id: requestedGroupId,
    });
    if (intentError) throw intentError;
    const intent = (claimedIntent ?? [])[0] as { intent_id?: string; intent_status?: string; reused?: boolean } | undefined;
    if (!intent?.intent_id) throw new Error('A intenção de conexão não pôde ser criada.');
    intentId = intent.intent_id;

    if (intent.reused) {
      return errorRedirect(
        url.origin,
        returnTo,
        intent.intent_status === 'failed' ? 'zernio_intent_failed' : 'zernio_intent_in_progress',
        intent.intent_status === 'failed'
          ? 'Esta solicitação específica terminou com falha. Gere uma nova linha no Bulk Zernio para tentar novamente.'
          : 'Esta solicitação específica já está aberta. Os demais aparelhos continuam independentes.',
      );
    }

    if (requestedGroupId) {
      const { data: group } = await admin.from('profile_groups').select('id')
        .eq('id', requestedGroupId).eq('organization_id', organizationId).is('deleted_at', null).maybeSingle();
      if (!group) throw new Error('zernio_group_not_found');
    }

    const { connection, client } = await createZernioConnectionContext(organizationId, connectionId);
    if (!connection.zernio_profile_id) {
      throw new Error('A conexão não possui profile Zernio canônico. Prepare a chave novamente.');
    }

    let requestedGroup: { id: string; name: string } | null = null;
    if (requestedGroupId) {
      const { data: group } = await admin.from('profile_groups').select('id, name')
        .eq('id', requestedGroupId).eq('organization_id', organizationId).is('deleted_at', null).maybeSingle();
      if (!group) throw new Error('zernio_group_not_found');
      requestedGroup = group;
    }

    const remoteInventory = await client.listAccounts();
    const remoteInstagramAccounts = (remoteInventory.accounts ?? []).filter((account) => account.platform === 'instagram');
    const canonicalInstagramAccounts = remoteInstagramAccounts.filter((account) => {
      const remoteProfileId = typeof account.profileId === 'string' ? account.profileId : account.profileId?._id;
      return remoteProfileId === connection.zernio_profile_id;
    });
    if (connection.instagram_slot_limit != null && canonicalInstagramAccounts.length >= connection.instagram_slot_limit) {
      // A conta pode já existir remotamente após um callback, mas ainda estar
      // aguardando a propagação/reconciliação local. Nesse cenário um novo
      // OAuth só pioraria a divergência 1/2 local versus 2/2 remoto.
      const { data: recoverableAttempt } = await admin
        .from('zernio_connection_attempts')
        .select('id, worker_status, status')
        .eq('organization_id', organizationId)
        .eq('zernio_connection_id', connection.id)
        .eq('created_by', userId)
        // Também reconhece attempts que terminaram como falha após o callback:
        // em especial, uma resposta de capacidade/billing da Zernio pode chegar
        // depois de a conta já ocupar o slot remoto. A tela de conclusão então
        // deve explicar o estado real, e não abrir outro OAuth sem necessidade.
        .in('status', ['callback_received', 'failed'])
        .in('worker_status', ['pending', 'processing', 'recovery_paused', 'failed'])
        .order('callback_received_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (recoverableAttempt?.id) {
        // Esta intenção ainda não abriu OAuth nem criou profile remoto. Encerrá-la
        // evita que um refresh posterior a reutilize em vez da recuperação real.
        await admin.from('zernio_connection_intents').update({
          status: 'failed',
          diagnostic: { recoveryAttemptId: recoverableAttempt.id, reason: 'remote_capacity_held_by_post_callback_recovery' },
        }).eq('id', intentId).in('status', ['started', 'reserved']);
        const recovery = new URL('/zernio/concluindo', url.origin);
        recovery.searchParams.set('attemptId', recoverableAttempt.id);
        recovery.searchParams.set('returnTo', returnTo);
        return NextResponse.redirect(recovery);
      }
      throw new Error(`O limite de ${connection.instagram_slot_limit} conta(s) nesta chave Zernio já foi atingido globalmente.`);
    }

    const attempt = await createZernioConnectionAttempt({
      organizationId,
      connectionId: connection.id,
      userId,
      returnTo,
      zernioProfileId: null,
      request,
      knownZernioAccountIds: [],
      knownZernioAccounts: [],
      zernioSlotReservationId: null,
      zernioConnectionIntentId: intentId,
      requestedGroupId: requestedGroup?.id ?? null,
      requestedGroupName: requestedGroup?.name ?? null,
    });
    attemptId = attempt.id;

    const canonicalHasAccount = canonicalInstagramAccounts.some((account) => {
      const remoteProfileId = typeof account.profileId === 'string' ? account.profileId : account.profileId?._id;
      return remoteProfileId === connection.zernio_profile_id;
    });
    const { data: claimedRows, error: claimError } = await admin.rpc('claim_zernio_attempt_remote_profile', {
      p_attempt_id: attempt.id,
      p_canonical_has_account: canonicalHasAccount,
    });
    if (claimError) throw claimError;

    let remoteProfileId = (claimedRows ?? [])[0]?.zernio_profile_id as string | undefined;
    let remoteProfileName = (claimedRows ?? [])[0]?.profile_name as string | undefined;
    let createdDedicatedProfile = false;
    if (!remoteProfileId) {
      remoteProfileName = `Pandora ${organizationId.slice(0, 8)} ${attempt.id.slice(0, 12)}`;
      const created = await client.createProfile(remoteProfileName, attempt.id);
      remoteProfileId = created.profile?._id ?? created.profile?.id;
      if (!remoteProfileId) throw new Error('A Zernio criou o profile isolado sem retornar o identificador.');
      createdDedicatedProfile = true;
      const { error: registerError } = await admin.rpc('register_zernio_attempt_remote_profile', {
        p_attempt_id: attempt.id,
        p_zernio_profile_id: remoteProfileId,
        p_profile_name: remoteProfileName,
      });
      if (registerError) throw registerError;
    }

    const baselineAccounts = await listZernioInstagramAccountSnapshotsForConnection(client, remoteProfileId);
    const baselineIds = baselineAccounts.map((account) => account.accountId);
    if (baselineIds.length) {
      throw new Error('O profile remoto isolado selecionado já possui uma conta Instagram. Nenhuma autorização foi aberta.');
    }
    await markZernioConnectionAttemptProfilePrepared(attempt.id, remoteProfileId, {
      remoteProfileIsolation: 'exclusive_attempt_profile',
      remoteProfileName: remoteProfileName ?? null,
      createdDedicatedProfile,
      canonicalZernioProfileId: connection.zernio_profile_id,
      knownZernioAccountIds: baselineIds,
      knownZernioAccountCount: baselineIds.length,
      knownZernioAccounts: baselineAccounts,
    });

    const { error: intentUpdateError } = await admin.from('zernio_connection_intents').update({
      resolved_connection_id: connection.id,
      attempt_id: attempt.id,
      reservation_id: null,
      status: 'started',
      diagnostic: {
        requestedConnectionId: connectionId,
        oauthSerializedBeforeRedirect: false,
        remoteProfileIsolation: 'exclusive_attempt_profile',
        zernioProfileId: remoteProfileId,
      },
    }).eq('id', intentId);
    if (intentUpdateError) throw intentUpdateError;

    const callback = new URL('/api/integrations/zernio/callback', url.origin);
    callback.searchParams.set('returnTo', returnTo);
    callback.searchParams.set('connectionId', connection.id);
    callback.searchParams.set('attemptId', attempt.id);
    const result = await client.startConnect('instagram', remoteProfileId, callback.toString());
    if (!result.authUrl) throw new Error('A Zernio não retornou a URL de autorização.');
    await markZernioConnectionAttemptRedirected(attempt.id, result);
    return NextResponse.redirect(result.authUrl);
  } catch (error) {
    await markZernioConnectionAttemptFailed(attemptId, error).catch(() => undefined);
    if (attemptId) {
      await admin.rpc('release_zernio_attempt_remote_profile', {
        p_attempt_id: attemptId,
        p_reason: 'oauth_start_failed',
      }).then(() => undefined);
    }
    if (intentId) {
      await admin.from('zernio_connection_intents').update({
        status: 'failed',
        diagnostic: { error: error instanceof Error ? error.message.slice(0, 500) : 'Falha ao abrir autorização.' },
      }).eq('id', intentId).in('status', ['started', 'reserved']).then(() => undefined);
    }
    if (error instanceof Error && error.message === 'zernio_group_not_found') return errorRedirect(url.origin, returnTo, 'zernio_group_not_found');
    if (error instanceof Error && error.message.includes('Nenhuma conta Zernio com slot livre')) return errorRedirect(url.origin, returnTo, 'zernio_no_available_slot');
    return errorRedirect(url.origin, returnTo, 'zernio_connect_failed', error instanceof Error ? error.message : 'Falha desconhecida ao preparar a solicitação Zernio.');
  }
}
