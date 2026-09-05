import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { fetchAllRowsByIds } from '@/lib/supabase/chunk';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Andamento das exclusões de grupo.
 *
 * ESTA É A ROTA QUE FAZ O PROGRESSO SOBREVIVER AO F5. A tela não guarda nada: ela
 * chama isto no mount e monta o painel a partir do que o banco responde. É a
 * diferença em relação a `/perfis` e `/galeria`, onde o estado começa `null` e o
 * poll só liga depois do clique — nos dois, atualizar a página faz o progresso
 * sumir mesmo com a operação viva.
 *
 * Também é aqui que o finalize roda para quem está olhando. O worker de mídia
 * chama o mesmo finalize a cada ciclo, mas ele se recusa a rodar sob pressão de
 * geração; quem está com a tela aberta não deveria esperar por isso.
 */

/** Incidente ainda vivo: o perfil não saiu, e `deferred` conta porque o job segue de pé. */
const PENDING_INCIDENT_STATES = ['remote_removal_pending', 'retry_scheduled', 'deferred'];
const DONE_INCIDENT_STATES = ['completed', 'remote_deleted', 'already_disconnected_404'];
const TERMINAL_JOB_STATES = ['completed', 'completed_with_errors', 'failed'];

/** Janela dos jobs já encerrados que o painel ainda mostra, para o relatório final não sumir sozinho. */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Teto de jobs devolvidos. Acima disso a organização tem um problema maior que este painel. */
const JOB_CAP = 50;

/** Falhas listadas por job. O suficiente para agir, não tanto que a resposta vire um dump. */
const FAILURE_SAMPLE_LIMIT = 25;

type JobRow = {
  id: string;
  group_id: string;
  group_name_snapshot: string;
  scope: 'media' | 'media_profiles';
  status: string;
  media_deletion_job_id: string | null;
  media_exclusive_total: number;
  media_detached_total: number;
  media_skipped_total: number;
  profile_total: number;
  history_items_deleted: number;
  last_error_message: string | null;
  created_at: string;
  finished_at: string | null;
};

type MediaJobRow = {
  id: string;
  status: string;
  total_count: number;
  processed_count: number;
  deleted_count: number;
  failed_count: number;
};

type IncidentRow = {
  profile_id: string;
  state: string;
  username_snapshot: string | null;
  connection_label_snapshot: string | null;
  error_message: string | null;
};

type Failure = { kind: 'media' | 'profile'; label: string; detail: string | null; message: string };

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const organizationId = context.activeOrganization.id;
  const supabase = await createSupabaseServerClient();
  const canManage = context.organizations.some(
    (organization) => organization.id === organizationId && ['admin', 'operator'].includes(organization.role),
  );

  // Fecha o que já terminou antes de ler, para o painel não ficar mostrando
  // "em andamento" um job cujas duas metades acabaram há um ciclo.
  if (canManage) {
    const { error: finalizeError } = await supabase.rpc('finalize_profile_group_deletion_jobs', {
      p_organization_id: organizationId,
    });
    if (finalizeError && finalizeError.code !== '42501') {
      // Falhar aqui não pode esconder o andamento: a leitura abaixo continua
      // valendo, e o worker de mídia tenta de novo no próximo ciclo.
      console.error('Falha ao finalizar exclusões de grupo.', {
        organizationId, code: finalizeError.code, message: finalizeError.message,
      });
    }
  }

  const since = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
  const { data: jobRows, error: jobsError } = await supabase
    .from('profile_group_deletion_jobs')
    .select('id, group_id, group_name_snapshot, scope, status, media_deletion_job_id, media_exclusive_total, media_detached_total, media_skipped_total, profile_total, history_items_deleted, last_error_message, created_at, finished_at')
    .eq('organization_id', organizationId)
    .or(`status.in.(pending,processing),created_at.gte.${since}`)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(JOB_CAP);

  if (jobsError) {
    return NextResponse.json({ error: 'Não foi possível carregar o andamento das exclusões.' }, { status: 500 });
  }

  const jobs = (jobRows ?? []) as JobRow[];
  if (!jobs.length) {
    return NextResponse.json({ jobs: [], deletingGroupIds: [] }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
  }

  const mediaJobIds = jobs.map((job) => job.media_deletion_job_id).filter((id): id is string => Boolean(id));

  // Uma consulta por dimensão, não uma por job: o painel é uma tela de
  // acompanhamento, e o teto de JOB_CAP mantém cada `in()` pequeno.
  const [mediaJobs, mediaFailures, snapshots] = await Promise.all([
    mediaJobIds.length
      ? supabase
        .from('media_deletion_jobs')
        .select('id, status, total_count, processed_count, deleted_count, failed_count')
        .eq('organization_id', organizationId)
        .in('id', mediaJobIds)
      : Promise.resolve({ data: [] as MediaJobRow[], error: null }),
    mediaJobIds.length
      ? supabase
        .from('media_deletion_job_items')
        .select('job_id, media_asset_id, error_message, media_assets(original_name)')
        .eq('organization_id', organizationId)
        .in('job_id', mediaJobIds)
        .eq('status', 'failed')
        .order('job_id', { ascending: true })
        .order('media_asset_id', { ascending: true })
        .range(0, JOB_CAP * FAILURE_SAMPLE_LIMIT - 1)
      : Promise.resolve({ data: [], error: null }),
    // Cada job cabe em 2000 perfis, mas vários jobs somados passam do teto de
    // uma página. Paginado com ordem TOTAL — a chave da tabela é
    // (job_id, profile_id) — porque ordenar só por job_id repetiria e perderia
    // linhas entre páginas sem mudar a contagem, que é o pior jeito de errar.
    fetchAllRows<{ job_id: string; profile_id: string; username_snapshot: string | null }>((from, to) => supabase
      .from('profile_group_deletion_job_profiles')
      .select('job_id, profile_id, username_snapshot')
      .eq('organization_id', organizationId)
      .in('job_id', jobs.map((job) => job.id))
      .order('job_id', { ascending: true })
      .order('profile_id', { ascending: true })
      .range(from, to)),
  ]);

  if (mediaJobs.error || mediaFailures.error || snapshots.error) {
    return NextResponse.json({ error: 'Não foi possível carregar o andamento das exclusões.' }, { status: 500 });
  }

  const snapshotRows = (snapshots.data ?? []) as Array<{ job_id: string; profile_id: string; username_snapshot: string | null }>;
  const allProfileIds = [...new Set(snapshotRows.map((row) => row.profile_id))];

  // Em fatias de ids: um `.in()` com milhares de UUIDs é ao mesmo tempo risco de
  // truncamento e uma URL de dezenas de KB.
  const incidents = await fetchAllRowsByIds<IncidentRow>(allProfileIds, (chunk, from, to) => supabase
    .from('zernio_profile_disconnection_incidents')
    .select('profile_id, state, username_snapshot, connection_label_snapshot, error_message')
    .eq('organization_id', organizationId)
    .in('profile_id', chunk)
    // profile_id tem unique (organization_id, profile_id) no incidente, e a
    // organização está presa pelo .eq(): a ordem é total.
    .order('profile_id', { ascending: true })
    .range(from, to));

  if (incidents.error) {
    return NextResponse.json({ error: 'Não foi possível carregar o andamento das exclusões.' }, { status: 500 });
  }

  const incidentByProfile = new Map((incidents.data ?? []).map((row) => [row.profile_id, row]));
  const mediaJobById = new Map(((mediaJobs.data ?? []) as MediaJobRow[]).map((row) => [row.id, row]));
  const snapshotsByJob = new Map<string, typeof snapshotRows>();
  snapshotRows.forEach((row) => {
    snapshotsByJob.set(row.job_id, [...(snapshotsByJob.get(row.job_id) ?? []), row]);
  });
  const mediaFailuresByJob = new Map<string, Failure[]>();
  ((mediaFailures.data ?? []) as Array<{ job_id: string; media_asset_id: string; error_message: string | null; media_assets: { original_name: string | null } | { original_name: string | null }[] | null }>)
    .forEach((row) => {
      const asset = Array.isArray(row.media_assets) ? row.media_assets[0] : row.media_assets;
      const current = mediaFailuresByJob.get(row.job_id) ?? [];
      if (current.length >= FAILURE_SAMPLE_LIMIT) return;
      current.push({
        kind: 'media',
        label: asset?.original_name ?? 'Mídia sem nome',
        detail: null,
        message: row.error_message ?? 'Falha sem detalhe registrada.',
      });
      mediaFailuresByJob.set(row.job_id, current);
    });

  const deletingGroupIds: string[] = [];

  const payload = jobs.map((job) => {
    const mediaJob = job.media_deletion_job_id ? mediaJobById.get(job.media_deletion_job_id) : undefined;
    const mediaTotal = Number(mediaJob?.total_count ?? job.media_exclusive_total ?? 0);
    const mediaProcessed = Number(mediaJob?.processed_count ?? 0);
    const mediaFailed = Number(mediaJob?.failed_count ?? 0);

    const snapshot = job.scope === 'media_profiles' ? (snapshotsByJob.get(job.id) ?? []) : [];
    let profileDone = 0;
    let profileFailed = 0;
    const profileFailures: Failure[] = [];
    snapshot.forEach((row) => {
      const incident = incidentByProfile.get(row.profile_id);
      // Sem incidente o perfil é meta_official: ele termina de forma síncrona
      // dentro do próprio enfileiramento, e nunca vai aparecer aqui.
      if (!incident) {
        profileDone += 1;
        return;
      }
      if (incident.state === 'dead_letter') {
        profileFailed += 1;
        if (profileFailures.length < FAILURE_SAMPLE_LIMIT) {
          profileFailures.push({
            kind: 'profile',
            label: `@${incident.username_snapshot ?? row.username_snapshot ?? 'perfil'}`,
            detail: incident.connection_label_snapshot,
            message: incident.error_message ?? 'Falha terminal na remoção remota.',
          });
        }
        return;
      }
      if (DONE_INCIDENT_STATES.includes(incident.state)) profileDone += 1;
      else if (!PENDING_INCIDENT_STATES.includes(incident.state)) profileDone += 1;
    });

    const profileTotal = snapshot.length;
    // Unidades de trabalho das duas metades no mesmo denominador: uma barra só,
    // que anda tanto quando uma mídia sai quanto quando um perfil sai.
    const total = mediaTotal + profileTotal;
    const done = Math.min(mediaProcessed - mediaFailed, mediaTotal) + profileDone;
    const failed = mediaFailed + profileFailed;
    const terminal = TERMINAL_JOB_STATES.includes(job.status);

    if (!terminal) deletingGroupIds.push(job.group_id);

    return {
      id: job.id,
      groupId: job.group_id,
      groupName: job.group_name_snapshot,
      scope: job.scope,
      status: job.status,
      terminal,
      total,
      done: Math.max(0, done),
      failed,
      percent: total > 0 ? Math.round(((Math.max(0, done) + failed) / total) * 100) : (terminal ? 100 : 0),
      media: {
        total: mediaTotal,
        deleted: Number(mediaJob?.deleted_count ?? 0),
        failed: mediaFailed,
        detached: Number(job.media_detached_total ?? 0),
        skipped: Number(job.media_skipped_total ?? 0),
      },
      profiles: { total: profileTotal, done: profileDone, failed: profileFailed },
      historyItemsDeleted: Number(job.history_items_deleted ?? 0),
      lastErrorMessage: job.last_error_message,
      failures: [...(mediaFailuresByJob.get(job.id) ?? []), ...profileFailures],
      createdAt: job.created_at,
      finishedAt: job.finished_at,
    };
  });

  return NextResponse.json({ jobs: payload, deletingGroupIds }, {
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  });
}
