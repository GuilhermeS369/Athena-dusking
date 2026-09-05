import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import {
  MAX_FILTER_PROFILE_DELETE,
  isBulkDeleteConfirmed,
  summarizeRemovalRows,
  type ProfileRemovalRow,
} from '@/lib/profiles/bulk-removal';
import { enqueueProfileRemovalInChunks } from '@/lib/profiles/enqueue-removal';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Folga contra o `maxDuration` de 60s, igual à de /api/profiles/bulk-delete:
 * quando o orçamento acaba, a rota devolve o que já enfileirou e os ids
 * restantes, em vez de ser cortada no meio sem ninguém saber quanto foi feito.
 */
const WALL_BUDGET_MS = 45_000;

/**
 * Exclusão de grupo com escopo.
 *
 * Fica numa rota própria em vez de virar um parâmetro do `DELETE
 * /api/groups/[groupId]` porque as duas coisas são diferentes: aquele é um
 * soft-delete síncrono de uma linha, e é o caminho que o comentário da migration
 * 347 cita como o que **não** dispara os `on delete restrict` do histórico de
 * recuperação. Este abre uma operação assíncrona com id próprio, drenada por
 * workers, que pode levar minutos. Empilhar os dois no mesmo verbo faria a
 * resposta significar duas coisas.
 *
 * Nada de pesado acontece aqui: a rota só ABRE a operação. Quem apaga mídia é o
 * worker de manutenção; quem apaga a conta na Zernio é o worker de publicação.
 */
type ScopeValue = 'media' | 'media_profiles';

type DeleteBody = {
  scope?: unknown;
  dryRun?: unknown;
  confirmation?: unknown;
};

type PreviewRow = {
  profile_total: number;
  zernio_count: number;
  meta_count: number;
  already_queued: number;
  connection_labels: string[] | null;
  media_exclusive: number;
  media_shared: number;
  media_in_active_plan: number;
  scheduled_items_media: number;
  scheduled_items_total: number;
  history_items_media: number;
  history_items_total: number;
  active_plan_count: number;
};

type StartRow = { job_id: string; group_name: string; profile_total: number };
type MediaJobRow = { media_job_id: string; exclusive_total: number; skipped_total: number };

function canManage(context: Awaited<ReturnType<typeof getOrganizationContext>>) {
  return Boolean(
    context.activeOrganization
      && context.organizations.some(
        (organization) => organization.id === context.activeOrganization?.id
          && ['admin', 'operator'].includes(organization.role),
      ),
  );
}

function parseScope(value: unknown): ScopeValue {
  return value === 'media_profiles' ? 'media_profiles' : 'media';
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await params;
  const context = await getOrganizationContext();

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }
  if (!canManage(context)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  const organizationId = context.activeOrganization.id;
  const body = await request.json().catch(() => ({})) as DeleteBody;
  const scope = parseScope(body.scope);
  const supabase = await createSupabaseServerClient();

  const { data: previewRows, error: previewError } = await supabase
    .rpc('preview_profile_group_deletion', { p_organization_id: organizationId, p_group_id: groupId });

  if (previewError) {
    if (previewError.code !== '42501') {
      console.error('Falha ao resumir a exclusão do grupo.', {
        organizationId, groupId, code: previewError.code, message: previewError.message,
      });
    }
    return NextResponse.json({
      error: previewError.code === '42501'
        ? 'Ação não permitida.'
        : `Não foi possível resumir a exclusão do grupo (código ${previewError.code ?? 'desconhecido'}).`,
    }, { status: previewError.code === '42501' ? 403 : 500 });
  }

  const preview = ((previewRows ?? []) as PreviewRow[])[0];
  const summary = {
    profileTotal: Number(preview?.profile_total ?? 0),
    zernioCount: Number(preview?.zernio_count ?? 0),
    metaCount: Number(preview?.meta_count ?? 0),
    alreadyQueued: Number(preview?.already_queued ?? 0),
    connectionLabels: preview?.connection_labels ?? [],
    mediaExclusive: Number(preview?.media_exclusive ?? 0),
    mediaShared: Number(preview?.media_shared ?? 0),
    mediaInActivePlan: Number(preview?.media_in_active_plan ?? 0),
    // O par `_media` / `_total` existe porque o mesmo item pode ser atingido
    // pelos dois lados (a mídia e o perfil): somar os dois contaria duas vezes.
    scheduledItems: scope === 'media_profiles'
      ? Number(preview?.scheduled_items_total ?? 0)
      : Number(preview?.scheduled_items_media ?? 0),
    historyItems: scope === 'media_profiles'
      ? Number(preview?.history_items_total ?? 0)
      : Number(preview?.history_items_media ?? 0),
    activePlanCount: Number(preview?.active_plan_count ?? 0),
  };

  if (body.dryRun === true) {
    return NextResponse.json({ dryRun: true, scope, summary }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // Confirmação digitada nas DUAS opções: mesmo sem tocar em perfil, a exclusão
  // de mídia leva o arquivo do Storage junto e não volta.
  if (!isBulkDeleteConfirmed(typeof body.confirmation === 'string' ? body.confirmation : '')) {
    return NextResponse.json({ error: 'Digite EXCLUIR para confirmar a exclusão.' }, { status: 400 });
  }

  // Recusar acima do teto ANTES de abrir o job, em vez de cortar depois: uma
  // exclusão truncada em silêncio parece completa e some com a diferença. É o
  // mesmo teto de /perfis, e é ele que garante que a leitura do snapshot mais
  // abaixo nunca precise de uma segunda página.
  if (scope === 'media_profiles' && summary.profileTotal > MAX_FILTER_PROFILE_DELETE) {
    return NextResponse.json({
      error: `Este grupo tem ${summary.profileTotal} perfis, acima do limite de ${MAX_FILTER_PROFILE_DELETE} por operação. Remova parte dos perfis antes de excluir o grupo com eles.`,
    }, { status: 400 });
  }

  const { data: startRows, error: startError } = await supabase.rpc('start_profile_group_deletion', {
    p_organization_id: organizationId,
    p_group_id: groupId,
    p_scope: scope,
    p_actor_label: `operator: ${context.user.email ?? context.user.id}`,
  });

  if (startError) {
    // 23505 é o índice parcial de "um job ativo por grupo": dois cliques, não um
    // erro. Dizer isso em voz alta evita que a pessoa ache que nada aconteceu e
    // clique de novo.
    if (startError.code === '23505') {
      return NextResponse.json({ error: 'Este grupo já está sendo excluído. Acompanhe o andamento na tela.' }, { status: 409 });
    }
    if (startError.code === '42501') {
      return NextResponse.json({ error: 'Somente administradores e operadores podem excluir grupos.' }, { status: 403 });
    }
    if (startError.code === 'P0002') {
      return NextResponse.json({ error: 'Grupo não encontrado ou já excluído.' }, { status: 404 });
    }
    console.error('Falha ao abrir a exclusão do grupo.', {
      organizationId, groupId, scope, code: startError.code, message: startError.message,
    });
    return NextResponse.json({
      error: `Não foi possível iniciar a exclusão do grupo (código ${startError.code ?? 'desconhecido'}).`,
    }, { status: 500 });
  }

  const started = ((startRows ?? []) as StartRow[])[0];
  if (!started?.job_id) {
    return NextResponse.json({ error: 'Não foi possível iniciar a exclusão do grupo.' }, { status: 500 });
  }

  // ORDEM IMPORTA: o job de mídia é criado ANTES de desvincular as
  // compartilhadas. Invertido, uma falha aqui deixaria mídias já desvinculadas
  // do grupo sem nenhum job registrando isso — efeito parcial e silencioso.
  const { data: mediaRows, error: mediaError } = await supabase.rpc('create_group_media_deletion_job', {
    p_organization_id: organizationId,
    p_group_id: groupId,
    p_deletion_job_id: started.job_id,
  });

  if (mediaError) {
    console.error('Falha ao enfileirar a exclusão das mídias do grupo.', {
      organizationId, groupId, jobId: started.job_id, code: mediaError.code, message: mediaError.message,
    });
    await supabase
      .from('profile_group_deletion_jobs')
      .update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        last_error_message: `Não foi possível enfileirar as mídias (código ${mediaError.code ?? 'desconhecido'}).`,
      })
      .eq('id', started.job_id)
      .eq('organization_id', organizationId);
    return NextResponse.json({
      error: `Não foi possível enfileirar as mídias do grupo (código ${mediaError.code ?? 'desconhecido'}). Nada foi excluído.`,
    }, { status: 500 });
  }

  const mediaJob = ((mediaRows ?? []) as MediaJobRow[])[0];

  const { error: detachError } = await supabase.rpc('detach_shared_group_media', {
    p_organization_id: organizationId,
    p_group_id: groupId,
    p_deletion_job_id: started.job_id,
  });
  if (detachError) {
    // Não derruba a operação: a mídia compartilhada continua existindo, só ficou
    // com um vínculo a mais. O finalize apaga o grupo do mesmo jeito e a
    // atribuição órfã some junto pelo `on delete cascade` de group_id.
    console.error('Falha ao desvincular as mídias compartilhadas do grupo.', {
      organizationId, groupId, jobId: started.job_id, code: detachError.code, message: detachError.message,
    });
  }

  if (scope !== 'media_profiles') {
    return NextResponse.json({
      job: { id: started.job_id, groupName: started.group_name, scope },
      summary,
      media: { queued: Number(mediaJob?.exclusive_total ?? 0), skipped: Number(mediaJob?.skipped_total ?? 0) },
      profiles: { queued: 0, alreadyQueued: 0, deletedLocal: 0, skipped: 0 },
      remaining: [],
    }, { status: 202 });
  }

  const { data: snapshotRows, error: snapshotError } = await supabase
    .from('profile_group_deletion_job_profiles')
    .select('profile_id')
    .eq('job_id', started.job_id)
    .eq('organization_id', organizationId)
    // Ordem total: a chave da tabela é (job_id, profile_id), e job_id está preso
    // pelo .eq() acima. Uma página só basta porque a rota já recusou acima de
    // MAX_FILTER_PROFILE_DELETE.
    .order('profile_id', { ascending: true })
    .range(0, MAX_FILTER_PROFILE_DELETE - 1);

  if (snapshotError) {
    return NextResponse.json({
      error: 'Não foi possível ler os perfis do grupo. As mídias já entraram na fila; tente de novo para os perfis.',
      job: { id: started.job_id, groupName: started.group_name, scope },
    }, { status: 500 });
  }

  const profileIds = ((snapshotRows ?? []) as Array<{ profile_id: string }>).map((row) => row.profile_id);

  const { rows, remaining, chunkDurationsMs, splits, error: enqueueError } = await enqueueProfileRemovalInChunks(
    async (chunk) => {
      const { data, error } = await supabase.rpc('enqueue_instagram_profile_removal', {
        p_organization_id: organizationId,
        p_profile_ids: chunk,
        p_actor_label: `operator: /grupos "${started.group_name}"`,
      });
      return { data: (data ?? null) as ProfileRemovalRow[] | null, error };
    },
    { profileIds, pendingItemCount: summary.scheduledItems, budgetMs: WALL_BUDGET_MS },
  );

  const outcomes = summarizeRemovalRows(rows);

  if (enqueueError) {
    console.error('Falha ao enfileirar remoção dos perfis do grupo.', {
      organizationId, groupId, jobId: started.job_id, profileCount: profileIds.length,
      chunkDurationsMs, splits, code: enqueueError.code, message: enqueueError.message,
    });
    const done = outcomes.queued + outcomes.alreadyQueued + outcomes.deletedLocal;
    // 202 e não 500: as mídias JÁ entraram na fila e o job existe. Devolver erro
    // seco faria a tela esconder um progresso que está andando.
    return NextResponse.json({
      job: { id: started.job_id, groupName: started.group_name, scope },
      summary,
      media: { queued: Number(mediaJob?.exclusive_total ?? 0), skipped: Number(mediaJob?.skipped_total ?? 0) },
      profiles: outcomes,
      remaining,
      warning: done
        ? `${done} perfil(is) entraram na fila antes da falha. O restante não saiu (código ${enqueueError.code ?? 'desconhecido'}); use “Tentar novamente” para continuar de onde parou.`
        : `Os perfis não puderam ser enfileirados (código ${enqueueError.code ?? 'desconhecido'}). As mídias seguem na fila.`,
    }, { status: 202 });
  }

  return NextResponse.json({
    job: { id: started.job_id, groupName: started.group_name, scope },
    summary,
    media: { queued: Number(mediaJob?.exclusive_total ?? 0), skipped: Number(mediaJob?.skipped_total ?? 0) },
    profiles: outcomes,
    remaining,
  }, { status: 202 });
}
