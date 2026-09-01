import { NextResponse } from 'next/server';

import { softDeleteProfileAnalytics } from '@/lib/integrations/zernio-analytics';
import { getOrganizationContext } from '@/lib/organizations/server';
import {
  MAX_BULK_PROFILE_DELETE,
  MAX_FILTER_PROFILE_DELETE,
  chunkProfileIdsForRemoval,
  isBulkDeleteConfirmed,
  profileRemovalChunkSize,
  summarizeRemovalRows,
  type ProfileRemovalRow,
} from '@/lib/profiles/bulk-removal';
import { normalizeInstagramProfilesFilters } from '@/lib/profiles/catalog';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Folga contra o `maxDuration` de 60s: quando o orçamento acaba, a rota devolve
 * o que já enfileirou e os ids restantes, em vez de ser cortada no meio sem
 * ninguém saber quanto foi feito.
 */
const WALL_BUDGET_MS = 45_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PreviewRow = {
  total: number;
  zernio_count: number;
  meta_count: number;
  already_queued: number;
  connection_labels: string[] | null;
  pending_item_count: number;
};

type BulkDeleteBody = {
  profileIds?: unknown;
  selectAllMatching?: unknown;
  excludedIds?: unknown;
  dryRun?: unknown;
  confirmation?: unknown;
  filters?: {
    query?: unknown;
    groupId?: unknown;
    status?: unknown;
    situation?: unknown;
    publication?: unknown;
    created?: { from?: unknown; to?: unknown };
  };
};

function parseIdList(value: unknown, cap: number) {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && UUID_PATTERN.test(entry)) unique.add(entry);
    if (unique.size > cap) break;
  }
  return [...unique];
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  const organizationId = context.activeOrganization.id;
  const body = await request.json().catch(() => ({})) as BulkDeleteBody;
  const dryRun = body.dryRun === true;
  const supabase = await createSupabaseServerClient();

  let profileIds: string[];

  if (body.selectAllMatching === true) {
    // O filtro é normalizado pelo mesmo helper que a listagem usa, para "todos
    // deste filtro" significar exatamente o que a tela mostra.
    const filters = normalizeInstagramProfilesFilters({
      query: typeof body.filters?.query === 'string' ? body.filters.query : '',
      groupId: typeof body.filters?.groupId === 'string' ? body.filters.groupId : null,
      status: body.filters?.status as never,
      situation: body.filters?.situation as never,
      publication: body.filters?.publication as never,
      created: {
        from: typeof body.filters?.created?.from === 'string' ? body.filters.created.from : null,
        to: typeof body.filters?.created?.to === 'string' ? body.filters.created.to : null,
      },
    });
    const rpcFilters = {
      p_organization_id: organizationId,
      p_query: filters.query || null,
      p_group_id: filters.groupId,
      p_status: filters.status === 'all' ? null : filters.status,
      p_situation: filters.situation === 'all' ? null : filters.situation,
      p_publication: filters.publication,
      p_created_from: filters.created.from,
      p_created_to: filters.created.to,
    };

    // Recusar acima do teto em vez de cortar: uma exclusão truncada em silêncio
    // parece completa e some com a diferença.
    const { data: summaryRows, error: summaryError } = await supabase
      .rpc('get_instagram_profiles_catalog_summary', rpcFilters);
    if (summaryError) {
      return NextResponse.json({ error: 'Não foi possível medir o filtro selecionado.' }, { status: 500 });
    }
    const filteredTotal = Number((summaryRows as Array<{ filtered_total: number | string }> | null)?.[0]?.filtered_total ?? 0);
    if (filteredTotal > MAX_FILTER_PROFILE_DELETE) {
      return NextResponse.json({
        error: `Este filtro tem ${filteredTotal} perfis, acima do limite de ${MAX_FILTER_PROFILE_DELETE} por operação. Refine os filtros antes de excluir em massa.`,
      }, { status: 400 });
    }

    const { data: idRows, error: idsError } = await supabase
      .rpc('list_instagram_profiles_catalog_ids', { ...rpcFilters, p_limit: MAX_FILTER_PROFILE_DELETE });
    if (idsError) {
      return NextResponse.json({ error: 'Não foi possível resolver os perfis do filtro.' }, { status: 500 });
    }
    const excluded = new Set(parseIdList(body.excludedIds, MAX_FILTER_PROFILE_DELETE));
    profileIds = ((idRows ?? []) as Array<{ id: string }>)
      .map((row) => row.id)
      .filter((id) => !excluded.has(id));
  } else {
    profileIds = parseIdList(body.profileIds, MAX_BULK_PROFILE_DELETE);
    if (Array.isArray(body.profileIds) && body.profileIds.length > MAX_BULK_PROFILE_DELETE) {
      return NextResponse.json({
        error: `Selecione no máximo ${MAX_BULK_PROFILE_DELETE} perfis por operação.`,
      }, { status: 400 });
    }
  }

  if (!profileIds.length) {
    return NextResponse.json({ error: 'Nenhum perfil válido foi selecionado.' }, { status: 400 });
  }

  const { data: previewRows, error: previewError } = await supabase
    .rpc('preview_instagram_profile_removal', { p_organization_id: organizationId, p_profile_ids: profileIds });
  if (previewError) {
    if (previewError.code !== '42501') {
      console.error('Falha ao resumir a exclusão de perfis.', {
        organizationId, profileCount: profileIds.length,
        code: previewError.code, message: previewError.message, details: previewError.details,
      });
    }
    return NextResponse.json({
      error: previewError.code === '42501'
        ? 'Ação não permitida.'
        : `Não foi possível resumir a exclusão (código ${previewError.code ?? 'desconhecido'}).`,
    }, { status: previewError.code === '42501' ? 403 : 500 });
  }
  const preview = ((previewRows ?? []) as PreviewRow[])[0];
  const summary = {
    total: Number(preview?.total ?? 0),
    zernioCount: Number(preview?.zernio_count ?? 0),
    metaCount: Number(preview?.meta_count ?? 0),
    alreadyQueued: Number(preview?.already_queued ?? 0),
    connectionLabels: preview?.connection_labels ?? [],
    pendingItemCount: Number(preview?.pending_item_count ?? 0),
  };

  if (dryRun) return NextResponse.json({ dryRun: true, profileCount: profileIds.length, summary });

  if (!isBulkDeleteConfirmed(typeof body.confirmation === 'string' ? body.confirmation : '')) {
    return NextResponse.json({ error: 'Digite EXCLUIR para confirmar a exclusão.' }, { status: 400 });
  }

  // Uma chamada só para todos os perfis estoura o statement_timeout do papel
  // assim que o conjunto tem itens de fila demais — ver o comentário de
  // profileRemovalChunkSize. Cada fatia é sua própria transação, e repetir uma
  // fatia é inofensivo porque o enfileiramento é idempotente.
  const chunks = chunkProfileIdsForRemoval(profileIds, profileRemovalChunkSize(profileIds.length, summary.pendingItemCount));
  const actorLabel = `operator: ${context.user.email ?? context.user.id}`;
  const startedAt = Date.now();
  const rows: ProfileRemovalRow[] = [];
  const chunkDurationsMs: number[] = [];
  let remaining: string[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    if (index > 0 && Date.now() - startedAt > WALL_BUDGET_MS) {
      remaining = chunks.slice(index).flat();
      break;
    }
    const chunkStartedAt = Date.now();
    const { data: chunkRows, error: enqueueError } = await supabase.rpc('enqueue_instagram_profile_removal', {
      p_organization_id: organizationId,
      p_profile_ids: chunks[index],
      p_actor_label: actorLabel,
    });
    chunkDurationsMs.push(Date.now() - chunkStartedAt);

    if (enqueueError) {
      // O erro do banco precisa aparecer em algum lugar: sem isto a falha chega
      // à tela como uma frase genérica e a causa se perde.
      console.error('Falha ao enfileirar remoção de perfis.', {
        organizationId,
        chunkIndex: index,
        chunkSize: chunks[index].length,
        chunkDurationsMs,
        code: enqueueError.code,
        message: enqueueError.message,
        details: enqueueError.details,
        hint: enqueueError.hint,
      });
      if (enqueueError.code === '42501') {
        return NextResponse.json({ error: 'Somente administradores e operadores podem excluir perfis.' }, { status: 403 });
      }
      const partial = summarizeRemovalRows(rows);
      const done = partial.queued + partial.alreadyQueued + partial.deletedLocal;
      return NextResponse.json({
        ...partial,
        error: done
          ? `${done} perfil(is) foram enfileirados antes da falha. O restante não saiu (código ${enqueueError.code ?? 'desconhecido'}); tente de novo para continuar de onde parou.`
          : `Não foi possível excluir os perfis selecionados (código ${enqueueError.code ?? 'desconhecido'}).`,
        code: enqueueError.code ?? null,
        remaining: chunks.slice(index).flat(),
        summary,
      }, { status: 500 });
    }
    rows.push(...((chunkRows ?? []) as ProfileRemovalRow[]));
  }

  const outcomes = summarizeRemovalRows(rows);

  // Perfis Zernio ainda vão ser apagados pelo worker; só os locais já saíram e
  // precisam ter os snapshots de analytics encerrados aqui.
  await Promise.all(outcomes.removedNowIds.map((profileId) => softDeleteProfileAnalytics(profileId).catch((error) => {
    console.error('Falha ao encerrar analytics de perfil excluído.', { profileId, error });
  })));

  if (remaining.length) {
    console.warn('Remoção de perfis interrompida pelo orçamento de tempo da rota.', {
      organizationId, processed: rows.length, remaining: remaining.length, chunkDurationsMs,
    });
  }

  return NextResponse.json({
    queued: outcomes.queued,
    alreadyQueued: outcomes.alreadyQueued,
    deletedLocal: outcomes.deletedLocal,
    skipped: outcomes.skipped,
    removedNowIds: outcomes.removedNowIds,
    remaining,
    chunkDurationsMs,
    summary,
  }, { status: 202 });
}
