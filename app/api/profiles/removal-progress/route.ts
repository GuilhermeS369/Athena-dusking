import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Estados não terminais do incidente. `deferred` entra aqui porque o job segue
// vivo: ele foi adiado, não encerrado.
const PENDING_STATES = ['remote_removal_pending', 'retry_scheduled', 'deferred'];
const DONE_STATES = ['completed', 'remote_deleted', 'already_disconnected_404'];

const FAILED_SAMPLE_LIMIT = 50;

/**
 * Teto dos ids devolvidos, igual ao teto de perfis por operação de exclusão
 * (`MAX_FILTER_PROFILE_DELETE`). A tela usa esses ids para travar as linhas dos
 * perfis que estão saindo; passar do teto é possível só somando várias
 * operações dentro da janela de 24 h, e nesse caso a resposta **avisa** em vez
 * de cortar em silêncio — uma linha destravada por engano é um clique que
 * agenda publicação para um perfil que está sendo apagado.
 */
const IN_FLIGHT_ID_CAP = 2000;

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

  const [pendingResult, doneResult, failedResult, failedRows, inFlightRows] = await Promise.all([
    base().in('state', PENDING_STATES),
    base().in('state', DONE_STATES),
    base().eq('state', 'dead_letter'),
    supabase
      .from('zernio_profile_disconnection_incidents')
      .select('id, profile_id, username_snapshot, connection_label_snapshot, error_message, updated_at')
      .eq('organization_id', organizationId)
      .eq('signal', 'operator_requested')
      .eq('state', 'dead_letter')
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(FAILED_SAMPLE_LIMIT),
    // Quem ainda está saindo. A tela precisa dos IDS, não só da contagem: sem
    // eles não há como travar exatamente as linhas certas — e um perfil em
    // remoção que continua clicável aceita "mandar para recuperação" e
    // "cancelar fila" sobre algo que está deixando de existir.
    supabase
      .from('zernio_profile_disconnection_incidents')
      .select('profile_id')
      .eq('organization_id', organizationId)
      .eq('signal', 'operator_requested')
      .in('state', PENDING_STATES)
      .gte('updated_at', since)
      .not('profile_id', 'is', null)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(IN_FLIGHT_ID_CAP + 1),
  ]);

  if (pendingResult.error || doneResult.error || failedResult.error || failedRows.error || inFlightRows.error) {
    return NextResponse.json({ error: 'Não foi possível carregar o andamento das exclusões.' }, { status: 500 });
  }

  const pending = pendingResult.count ?? 0;
  const done = doneResult.count ?? 0;
  const failed = failedResult.count ?? 0;

  const inFlight = (inFlightRows.data ?? []) as Array<{ profile_id: string | null }>;
  const truncated = inFlight.length > IN_FLIGHT_ID_CAP;
  const failureRows = (failedRows.data ?? []) as Array<{ profile_id: string | null }>;

  return NextResponse.json({
    pending,
    done,
    failed,
    total: pending + done + failed,
    failures: failedRows.data ?? [],
    pendingProfileIds: inFlight.slice(0, IN_FLIGHT_ID_CAP).map((row) => row.profile_id).filter(Boolean),
    failedProfileIds: failureRows.map((row) => row.profile_id).filter(Boolean),
    // A tela precisa saber que a lista veio cortada para dizer isso em voz alta
    // em vez de deixar linhas destravadas parecendo seguras.
    truncated,
  }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
}
