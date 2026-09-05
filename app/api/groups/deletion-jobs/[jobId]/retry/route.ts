import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { fetchAllRowsByIds } from '@/lib/supabase/chunk';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Retoma SÓ o que falhou numa exclusão de grupo.
 *
 * A operação foi desenhada para seguir em frente quando um item falha e relatar
 * no fim, em vez de parar no primeiro erro. Isto é a outra metade dessa escolha:
 * sem um caminho de retomada, "continua e reporta" viraria "continua e desiste".
 *
 * As duas metades retomam por caminhos diferentes porque falham de formas
 * diferentes: mídia falha por item e é refeita criando um job novo com os ids
 * que sobraram; perfil falha virando dead-letter no job de reciclagem, e volta
 * ao vivo com `reopen_zernio_profile_recycling_job`, que registra o evento
 * `reopened` no histórico do incidente.
 */
type RouteContext = { params: Promise<{ jobId: string }> };

type JobRow = {
  id: string;
  organization_id: string;
  group_id: string;
  status: string;
  media_deletion_job_id: string | null;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const { jobId } = await params;
  const context = await getOrganizationContext();

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }
  const organizationId = context.activeOrganization.id;
  const canManage = context.organizations.some(
    (organization) => organization.id === organizationId && ['admin', 'operator'].includes(organization.role),
  );
  if (!canManage) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: job, error: jobError } = await supabase
    .from('profile_group_deletion_jobs')
    .select('id, organization_id, group_id, status, media_deletion_job_id')
    .eq('id', jobId)
    .eq('organization_id', organizationId)
    .maybeSingle<JobRow>();

  if (jobError) return NextResponse.json({ error: 'Não foi possível carregar a exclusão.' }, { status: 500 });
  if (!job) return NextResponse.json({ error: 'Exclusão não encontrada.' }, { status: 404 });

  // Mídia -------------------------------------------------------------------
  const failedAssets = job.media_deletion_job_id
    ? await fetchAllRows<{ media_asset_id: string }>((from, to) => supabase
      .from('media_deletion_job_items')
      .select('media_asset_id')
      .eq('organization_id', organizationId)
      .eq('job_id', job.media_deletion_job_id as string)
      .eq('status', 'failed')
      // Ordem total: a chave é (job_id, media_asset_id) e job_id está preso pelo
      // .eq() acima.
      .order('media_asset_id', { ascending: true })
      .range(from, to))
    : { data: [], error: null };

  if (failedAssets.error) {
    return NextResponse.json({ error: 'Não foi possível listar as mídias que falharam.' }, { status: 500 });
  }

  const assetIds = failedAssets.data.map((row) => row.media_asset_id);
  let requeuedMedia = 0;
  let mediaWarning: string | null = null;

  if (assetIds.length) {
    // A tentativa anterior deixou `deletion_requested_at` carimbado, e
    // create_media_deletion_job pula quem já tem o carimbo. Limpar é o que
    // devolve a mídia à condição de candidata.
    const { error: clearError } = await supabase
      .from('media_assets')
      .update({ deletion_requested_at: null, deletion_requested_by: null })
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .in('id', assetIds);

    if (clearError) {
      mediaWarning = 'Não foi possível liberar as mídias para nova tentativa.';
    } else {
      const { data: newJobRows, error: newJobError } = await supabase.rpc('create_media_deletion_job', {
        p_organization_id: organizationId,
        p_media_asset_ids: assetIds,
      });
      if (newJobError) {
        mediaWarning = `Não foi possível recriar a fila de mídia (código ${newJobError.code ?? 'desconhecido'}).`;
      } else {
        const created = ((newJobRows ?? []) as Array<{ job_id: string; total_count: number }>)[0];
        requeuedMedia = Number(created?.total_count ?? 0);
        if (created?.job_id) {
          // O job do grupo passa a acompanhar a fila NOVA: é ela que tem o que
          // ainda falta. A antiga fica no histórico, com suas falhas.
          await supabase
            .from('profile_group_deletion_jobs')
            .update({ media_deletion_job_id: created.job_id, status: 'processing', finished_at: null })
            .eq('id', job.id)
            .eq('organization_id', organizationId);
        }
      }
    }
  }

  // Perfis ------------------------------------------------------------------
  const snapshot = await fetchAllRows<{ profile_id: string }>((from, to) => supabase
    .from('profile_group_deletion_job_profiles')
    .select('profile_id')
    .eq('organization_id', organizationId)
    .eq('job_id', job.id)
    // Ordem total: chave (job_id, profile_id), com job_id preso pelo .eq().
    .order('profile_id', { ascending: true })
    .range(from, to));

  if (snapshot.error) {
    return NextResponse.json({ error: 'Não foi possível listar os perfis da exclusão.' }, { status: 500 });
  }

  const profileIds = snapshot.data.map((row) => row.profile_id);
  const deadLetters = profileIds.length
    ? await fetchAllRowsByIds<{ id: string }>(profileIds, (chunk, from, to) => supabase
      .from('zernio_profile_disconnection_incidents')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('state', 'dead_letter')
      .in('profile_id', chunk)
      .order('id', { ascending: true })
      .range(from, to))
    : { data: [], error: null };

  if (deadLetters.error) {
    return NextResponse.json({ error: 'Não foi possível listar os perfis que falharam.' }, { status: 500 });
  }

  let reopenedProfiles = 0;
  let profileWarning: string | null = null;
  for (const incident of deadLetters.data) {
    const { data: reopened, error: reopenError } = await supabase.rpc('reopen_zernio_profile_recycling_job', {
      p_organization_id: organizationId,
      p_incident_id: incident.id,
      p_reason: 'Retomada pedida pelo operador na exclusão do grupo.',
    });
    if (reopenError) {
      profileWarning = `Alguns perfis não puderam ser retomados (código ${reopenError.code ?? 'desconhecido'}).`;
      break;
    }
    if (reopened === true) reopenedProfiles += 1;
  }

  if (reopenedProfiles > 0) {
    await supabase
      .from('profile_group_deletion_jobs')
      .update({ status: 'processing', finished_at: null })
      .eq('id', job.id)
      .eq('organization_id', organizationId);
  }

  if (!requeuedMedia && !reopenedProfiles) {
    return NextResponse.json({
      requeuedMedia: 0,
      reopenedProfiles: 0,
      warning: mediaWarning ?? profileWarning ?? 'Nada a retomar: nenhuma falha pendente nesta exclusão.',
    }, { status: 200 });
  }

  return NextResponse.json({
    requeuedMedia,
    reopenedProfiles,
    warning: mediaWarning ?? profileWarning,
  }, { status: 202 });
}
