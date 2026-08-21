import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { dispatchPublicationQueue } from '@/lib/publications/dispatcher';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const managerRoles = new Set(['admin', 'operator']);

function canManage(role: string | undefined) {
  return Boolean(role && managerRoles.has(role));
}

function integerBodyValue(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  const role = context.organizations.find((organization) => organization.id === context.activeOrganization?.id)?.role;

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }
  if (!canManage(role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  let body: { action?: unknown; limit?: unknown; leaseSeconds?: unknown; batchId?: unknown; itemIds?: unknown } = {};
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
  }

  if (body.action === 'process') {
    const limit = integerBodyValue(body.limit, 5, 1, 5);
    const leaseSeconds = integerBodyValue(body.leaseSeconds, 180, 30, 900);
    const result = await dispatchPublicationQueue({
      workerId: `manual-queue-${context.user.id.slice(0, 8)}`,
      limit,
      leaseSeconds,
    });
    return NextResponse.json({ action: 'process', ...result });
  }

  if (body.action === 'release_stuck') {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .rpc('release_expired_publication_leases', {
        p_organization_id: context.activeOrganization.id,
      });

    if (error) {
      console.error('Não foi possível liberar itens travados da fila.', error);
      return NextResponse.json({ error: 'Não foi possível liberar itens travados.' }, { status: 500 });
    }

    const result = Array.isArray(data) ? data[0] : null;
    return NextResponse.json({
      action: 'release_stuck',
      released: Number(result?.released_count ?? 0),
      releasedItemIds: result?.released_item_ids ?? [],
    });
  }

  if (body.action === 'clear_completed') {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc('archive_completed_publication_items', {
      p_organization_id: context.activeOrganization.id,
    });

    if (error) {
      console.error('Não foi possível arquivar itens concluídos da fila.', error);
      return NextResponse.json({ error: 'Não foi possível arquivar os itens concluídos.' }, { status: 500 });
    }

    const result = Array.isArray(data) ? data[0] : null;
    const archived = Number(result?.archived_count ?? 0);
    return NextResponse.json({
      action: 'clear_completed',
      archived,
      archivedItemIds: result?.archived_item_ids ?? [],
      message: archived
        ? `${archived} item(ns) concluído(s) arquivado(s). O histórico foi preservado.`
        : 'Não havia itens concluídos para arquivar.',
    });
  }

  if (body.action === 'acknowledge_failures') {
    const batchId = typeof body.batchId === 'string' ? body.batchId : null;
    const itemIds = Array.isArray(body.itemIds)
      ? body.itemIds.filter((itemId): itemId is string => typeof itemId === 'string')
      : null;
    if (!batchId && (!itemIds || itemIds.length === 0)) {
      return NextResponse.json({ error: 'Informe um lote ou falhas visíveis para confirmar.' }, { status: 400 });
    }
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc('acknowledge_publication_failures', {
      p_organization_id: context.activeOrganization.id,
      p_batch_id: batchId,
      p_item_ids: batchId ? null : itemIds,
    });
    if (error) {
      console.error('Não foi possível confirmar falhas da fila.', error);
      return NextResponse.json({ error: 'Não foi possível confirmar as falhas.' }, { status: 500 });
    }
    const result = Array.isArray(data) ? data[0] : null;
    return NextResponse.json({
      action: 'acknowledge_failures',
      acknowledged: Number(result?.acknowledged_count ?? 0),
      acknowledgedItemIds: result?.acknowledged_item_ids ?? [],
    });
  }

  return NextResponse.json({ error: 'Ação de fila inválida.' }, { status: 400 });
}
