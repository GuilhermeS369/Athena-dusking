import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { createZernioClientForConnection, type ZernioError } from '@/lib/integrations/zernio-client';
import { normalizeZernioIdentity, validateSharedZernioAccountPresence, zernioInstagramAccountCount } from '@/lib/integrations/zernio-shared-removal';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

type IncidentRow = {
  id: string;
  organization_id: string;
  normalized_identity: string | null;
  username_snapshot: string;
  signal: string;
  state: string;
  retained_profile_id: string | null;
  retained_zernio_connection_id: string | null;
  retained_zernio_account_id: string | null;
  removed_zernio_connection_id: string | null;
  removed_zernio_account_id: string | null;
};

async function recordFailure(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  approval: { jobId: string; workerId: string } | null,
  error: unknown,
) {
  if (!approval) return;
  const typed = error as ZernioError;
  const { error: completionError } = await admin.rpc('complete_zernio_profile_recycling', {
    p_job_id: approval.jobId,
    p_worker_id: approval.workerId,
    p_remote_outcome: typed.retryable === false ? 'terminal_error' : 'retryable_error',
    p_http_status: Number.isInteger(typed.httpStatus) ? typed.httpStatus : null,
    p_request_id: typed.requestId ?? null,
    p_error_code: typed.code ?? 'shared_global_removal_failed',
    p_error_message: error instanceof Error ? error.message : 'Falha na remoção global controlada.',
  });
  if (completionError) {
    console.error('Falha ao registrar erro da remoção global Zernio.', { approval, completionError });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ incidentId: string }> },
) {
  const { incidentId } = await params;
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (context.activeOrganization.role !== 'admin') return NextResponse.json({ error: 'Somente administradores podem executar esta remoção.' }, { status: 403 });

  const body = await request.json().catch(() => ({})) as { confirmation?: unknown };
  const admin = createSupabaseAdminClient();
  const { data, error: incidentError } = await admin
    .from('zernio_profile_disconnection_incidents')
    .select('id, organization_id, normalized_identity, username_snapshot, signal, state, retained_profile_id, retained_zernio_connection_id, retained_zernio_account_id, removed_zernio_connection_id, removed_zernio_account_id')
    .eq('id', incidentId)
    .eq('organization_id', context.activeOrganization.id)
    .maybeSingle();
  const incident = data as IncidentRow | null;
  if (incidentError || !incident) return NextResponse.json({ error: 'Incidente de duplicidade não encontrado.' }, { status: 404 });

  const username = normalizeZernioIdentity(incident.normalized_identity ?? incident.username_snapshot);
  const expectedConfirmation = `REMOVER @${username}`;
  if (body.confirmation !== expectedConfirmation) {
    return NextResponse.json({ error: `Confirmação inválida. Digite ${expectedConfirmation}.` }, { status: 400 });
  }
  if (incident.signal !== 'duplicate_identity_auto_removed' || !['deferred', 'retry_scheduled', 'remote_removal_pending'].includes(incident.state)) {
    return NextResponse.json({ error: 'O incidente não está elegível para remoção global.' }, { status: 409 });
  }
  if (!incident.retained_profile_id || !incident.retained_zernio_connection_id || !incident.removed_zernio_connection_id) {
    return NextResponse.json({ error: 'O incidente não possui perfil e conexões estruturados para a remoção.' }, { status: 409 });
  }
  if (!incident.retained_zernio_account_id || incident.retained_zernio_account_id !== incident.removed_zernio_account_id) {
    return NextResponse.json({ error: 'Este botão só remove duplicidades cujo mesmo account ID é compartilhado pelas duas chaves.' }, { status: 409 });
  }
  const accountId = incident.retained_zernio_account_id;

  const { data: profile, error: profileError } = await admin
    .from('instagram_profiles')
    .select('id, username, provider, zernio_connection_id, zernio_account_id')
    .eq('id', incident.retained_profile_id)
    .eq('organization_id', incident.organization_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (profileError || !profile || profile.provider !== 'zernio'
    || profile.zernio_connection_id !== incident.retained_zernio_connection_id
    || profile.zernio_account_id !== incident.retained_zernio_account_id
    || normalizeZernioIdentity(profile.username) !== username) {
    return NextResponse.json({ error: 'O perfil local divergiu do incidente; nenhuma remoção foi executada.' }, { status: 409 });
  }

  let approval: { jobId: string; workerId: string } | null = null;
  try {
    const [retainedClient, removedClient] = await Promise.all([
      createZernioClientForConnection(incident.organization_id, incident.retained_zernio_connection_id),
      createZernioClientForConnection(incident.organization_id, incident.removed_zernio_connection_id),
    ]);
    const [retainedBefore, removedBefore] = await Promise.all([
      retainedClient.listAccounts(),
      removedClient.listAccounts(),
    ]);
    const presence = validateSharedZernioAccountPresence({
      accountId,
      username,
      retainedAccounts: retainedBefore.accounts ?? [],
      removedAccounts: removedBefore.accounts ?? [],
    });
    const snapshotAt = new Date().toISOString();
    const workerId = `admin-global-remove:${context.user.id}:${randomUUID()}`;
    const { data: approvalData, error: approvalError } = await admin.rpc('approve_zernio_duplicate_removal_preflight', {
      p_incident_id: incident.id,
      p_snapshot_at: snapshotAt,
      p_retained_connection_id: incident.retained_zernio_connection_id,
      p_retained_account_id: accountId,
      p_removed_connection_id: incident.removed_zernio_connection_id,
      p_removed_account_id: accountId,
      p_approved_by: workerId,
    });
    if (approvalError) throw approvalError;
    approval = approvalData as { jobId: string; workerId: string };

    const requestId = `athena-global-remove-${incident.id}`;
    let outcome: 'remote_deleted' | 'already_disconnected_404' = presence === 'absent_both'
      ? 'already_disconnected_404'
      : 'remote_deleted';
    let httpStatus = presence === 'absent_both' ? 404 : 200;
    let retainedAccountsAfter = retainedBefore.accounts ?? [];
    let removedAccountsAfter = removedBefore.accounts ?? [];
    if (presence === 'present_both') {
      try {
        await removedClient.disconnectAccount(accountId, requestId);
      } catch (error) {
        const typed = error as ZernioError;
        if (typed.httpStatus !== 404) throw error;
        outcome = 'already_disconnected_404';
        httpStatus = 404;
      }
      const [retainedAfter, removedAfter] = await Promise.all([
        retainedClient.listAccounts(),
        removedClient.listAccounts(),
      ]);
      retainedAccountsAfter = retainedAfter.accounts ?? [];
      removedAccountsAfter = removedAfter.accounts ?? [];
      if (retainedAccountsAfter.some((account) => [account.accountId, account._id, account.id].includes(accountId))
        || removedAccountsAfter.some((account) => [account.accountId, account._id, account.id].includes(accountId))) {
        throw new Error('A confirmação pós-DELETE ainda encontrou o account ID em pelo menos uma chave.');
      }
    }

    const inventorySnapshotAt = new Date().toISOString();
    const { error: inventoryError } = await admin.rpc('record_zernio_shared_global_removal_inventory', {
      p_incident_id: incident.id,
      p_job_id: approval.jobId,
      p_worker_id: approval.workerId,
      p_snapshot_at: inventorySnapshotAt,
      p_retained_instagram_count: zernioInstagramAccountCount(retainedAccountsAfter),
      p_removed_instagram_count: zernioInstagramAccountCount(removedAccountsAfter),
    });
    if (inventoryError) throw inventoryError;

    const { data: completion, error: completionError } = await admin.rpc('complete_zernio_shared_account_global_removal', {
      p_incident_id: incident.id,
      p_job_id: approval.jobId,
      p_worker_id: approval.workerId,
      p_remote_outcome: outcome,
      p_http_status: httpStatus,
      p_request_id: requestId,
      p_requested_by: context.user.id,
    });
    if (completionError) throw completionError;
    return NextResponse.json({ ok: true, username, outcome, completion });
  } catch (error) {
    await recordFailure(admin, approval, error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Não foi possível concluir a remoção global Zernio.',
    }, { status: 502 });
  }
}
