import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const managerRoles = new Set(['admin', 'operator']);

function canManage(role: string | undefined) {
  return Boolean(role && managerRoles.has(role));
}

async function publicationPressureResponse(action: string) {
  const admin = createSupabaseAdminClient();
  const { data: pressure, error } = await admin.rpc(
    'get_publication_generation_pressure_signal',
    { p_critical_delay_seconds: 60 },
  );
  if (error) {
    console.error('Não foi possível consultar a pressão antes da limpeza.', error);
    return NextResponse.json({ error: 'Não foi possível validar a capacidade para a limpeza.' }, { status: 503 });
  }
  if (pressure?.criticalDelay === true) {
    return NextResponse.json({
      action,
      busy: true,
      paused: true,
      reason: 'critical_publication_delay',
      retryAfterSeconds: 60,
    }, { status: 202 });
  }
  return null;
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

  let body: { action?: unknown; batchId?: unknown; itemIds?: unknown } = {};
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
  }

  if (body.action === 'clean_finished') {
    const pressureResponse = await publicationPressureResponse('clean_finished');
    if (pressureResponse) return pressureResponse;
    const supabase = await createSupabaseServerClient();
    const { data: leaseToken, error: leaseError } = await supabase.rpc(
      'acquire_operational_heavy_workload_lease',
      {
        p_category: 'queue_cleanup',
        p_holder: `queue-cleanup:${context.user.id}:${context.activeOrganization.id}`,
        p_organization_id: context.activeOrganization.id,
        p_lease_seconds: 30,
      },
    );
    if (leaseError) {
      console.error('Não foi possível reservar capacidade para limpar a fila.', leaseError);
      return NextResponse.json({ error: 'Não foi possível reservar capacidade para a limpeza.' }, { status: 500 });
    }
    if (!leaseToken) {
      return NextResponse.json({ action: 'clean_finished', busy: true }, { status: 202 });
    }

    const { data, error } = await supabase.rpc('clean_publication_queue_finished', {
      p_organization_id: context.activeOrganization.id,
      p_limit: 250,
    });
    const { error: releaseError } = await supabase.rpc('release_operational_heavy_workload_lease', {
      p_lease_token: leaseToken,
    });
    if (releaseError) console.error('Não foi possível liberar a capacidade da limpeza.', releaseError);

    if (error) {
      console.error('Não foi possível limpar itens encerrados da fila.', error);
      return NextResponse.json({ error: 'Não foi possível limpar as publicações encerradas.' }, { status: 500 });
    }

    const result = Array.isArray(data) ? data[0] : null;
    return NextResponse.json({
      action: 'clean_finished',
      archivedCompleted: Number(result?.archived_completed_count ?? 0),
      archivedFailures: Number(result?.archived_failure_count ?? 0),
      remaining: Number(result?.remaining_finished_count ?? 0),
    });
  }

  if (body.action === 'clear_completed') {
    const pressureResponse = await publicationPressureResponse('clear_completed');
    if (pressureResponse) return pressureResponse;
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
