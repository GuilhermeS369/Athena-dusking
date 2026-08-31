import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

type Action = 'add' | 'remove' | 'replace';
type BulkGroupJobResult = { job_id: string; total_count: number };

const MAX_SYNC_ASSETS = 500;
const MAX_SYNC_ASSIGNMENT_EDGES = 5000;
const MAX_ASYNC_ASSETS = 50000;
const MAX_ASYNC_GROUPS = 1000;


/**
 * Grava o marco de troca de mídia da tela de Recuperação.
 *
 * Fica aqui, depois da atribuição já aceita, e **nunca** dentro do job SQL: a
 * atribuição é um caminho compartilhado com a Galeria que já funciona, e o
 * marco é registro, não regra. Se falhar, a atribuição continua valendo — o
 * erro vai para o log e ninguém fica sem mídia por causa de um marcador.
 *
 * `remove` não gera marco: tirar mídia de um grupo não é uma troca de leva.
 */
async function recordRecoveryMilestones(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  organizationId: string,
  groupIds: string[],
  mediaCount: number,
  action: Action,
) {
  if (action === 'remove' || !groupIds.length || mediaCount <= 0) return;
  const { error } = await supabase.rpc('record_auto_media_milestones', {
    p_organization_id: organizationId,
    p_group_ids: groupIds,
    p_media_count: mediaCount,
  });
  if (error) {
    console.error('recovery_auto_milestone_failed', {
      organizationId, groupIds, mediaCount, error: error.message,
    });
  }
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  const organization = context.organizations.find((item) => item.id === context.activeOrganization?.id);
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  if (!organization || !['admin', 'operator'].includes(organization.role)) return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });

  let body: { assetIds?: unknown; groupIds?: unknown; action?: unknown };
  try { body = await request.json() as typeof body; } catch { return NextResponse.json({ error: 'Corpo da requisição inválido.' }, { status: 400 }); }
  if (!Array.isArray(body.assetIds) || !Array.isArray(body.groupIds) || body.assetIds.some((id) => typeof id !== 'string') || body.groupIds.some((id) => typeof id !== 'string')) {
    return NextResponse.json({ error: 'Informe mídias e grupos válidos.' }, { status: 400 });
  }
  const assetIds = [...new Set(body.assetIds as string[])];
  const groupIds = [...new Set(body.groupIds as string[])];
  const action = body.action as Action;
  if (!assetIds.length || !groupIds.length || !['add', 'remove', 'replace'].includes(action)) return NextResponse.json({ error: 'Selecione mídias, grupos e uma operação válida.' }, { status: 400 });
  if (assetIds.length > MAX_ASYNC_ASSETS) return NextResponse.json({ error: `Selecione até ${MAX_ASYNC_ASSETS} mídias por operação.` }, { status: 400 });
  if (groupIds.length > MAX_ASYNC_GROUPS) return NextResponse.json({ error: `Selecione até ${MAX_ASYNC_GROUPS} grupos por operação.` }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  if (assetIds.length > MAX_SYNC_ASSETS || assetIds.length * groupIds.length > MAX_SYNC_ASSIGNMENT_EDGES) {
    const { data: jobRows, error: jobError } = await supabase.rpc('create_media_group_assignment_job', {
      p_organization_id: context.activeOrganization.id,
      p_media_asset_ids: assetIds,
      p_group_ids: groupIds,
      p_action: action,
    });
    if (jobError) {
      const status = ['22023', '42501'].includes(jobError.code ?? '') ? 400 : 500;
      return NextResponse.json({ error: jobError.message || 'Não foi possível enfileirar a organização das mídias.' }, { status });
    }

    const job = ((jobRows ?? []) as BulkGroupJobResult[])[0];
    await recordRecoveryMilestones(supabase, context.activeOrganization.id, groupIds, assetIds.length, action);
    return NextResponse.json({ queued: true, job: job ? { id: job.job_id, totalCount: job.total_count } : null, affected: assetIds.length }, { status: 202 });
  }

  const { data: assignments, error } = await supabase.rpc('update_media_group_assignments_bulk', {
    p_organization_id: context.activeOrganization.id,
    p_media_asset_ids: assetIds,
    p_group_ids: groupIds,
    p_action: action,
  });
  if (error) {
    const status = ['22023', '42501'].includes(error.code ?? '') ? 400 : 500;
    return NextResponse.json({ error: error.message || 'Não foi possível atualizar os grupos das mídias.' }, { status });
  }
  await recordRecoveryMilestones(supabase, context.activeOrganization.id, groupIds, assetIds.length, action);
  return NextResponse.json({ assignments: assignments ?? [], affected: assetIds.length });
}
