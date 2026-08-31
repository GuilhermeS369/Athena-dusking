import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Estados não terminais do incidente. `deferred` entra aqui porque o job segue
// vivo: ele foi adiado, não encerrado.
const PENDING_STATES = ['remote_removal_pending', 'retry_scheduled', 'deferred'];
const DONE_STATES = ['completed', 'remote_deleted', 'already_disconnected_404'];

const FAILED_SAMPLE_LIMIT = 50;

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const organizationId = context.activeOrganization.id;
  const supabase = await createSupabaseServerClient();
  // Só a janela recente interessa: o painel mostra o andamento da exclusão que a
  // pessoa acabou de disparar, não o histórico da organização.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // A tabela de incidentes já é legível por membros (política da migration 101);
  // `zernio_profile_recycling_jobs` é service_role-only e o estado do incidente
  // espelha o do job, então não é preciso subir para o cliente admin aqui.
  const base = () => supabase
    .from('zernio_profile_disconnection_incidents')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('signal', 'operator_requested')
    .gte('updated_at', since);

  const [pendingResult, doneResult, failedResult, failedRows] = await Promise.all([
    base().in('state', PENDING_STATES),
    base().in('state', DONE_STATES),
    base().eq('state', 'dead_letter'),
    supabase
      .from('zernio_profile_disconnection_incidents')
      .select('id, username_snapshot, connection_label_snapshot, error_message, updated_at')
      .eq('organization_id', organizationId)
      .eq('signal', 'operator_requested')
      .eq('state', 'dead_letter')
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(FAILED_SAMPLE_LIMIT),
  ]);

  if (pendingResult.error || doneResult.error || failedResult.error || failedRows.error) {
    return NextResponse.json({ error: 'Não foi possível carregar o andamento das exclusões.' }, { status: 500 });
  }

  const pending = pendingResult.count ?? 0;
  const done = doneResult.count ?? 0;
  const failed = failedResult.count ?? 0;

  return NextResponse.json({
    pending,
    done,
    failed,
    total: pending + done + failed,
    failures: failedRows.data ?? [],
  }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
}
