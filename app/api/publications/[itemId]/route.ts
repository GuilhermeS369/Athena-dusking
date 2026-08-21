import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { PUBLICATION_MAX_ATTEMPTS } from '@/lib/publications/attempts';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const MANAGER_ROLES = new Set(['admin', 'operator']);

function canManage(role: string | undefined) {
  return Boolean(role && MANAGER_ROLES.has(role));
}

export async function PATCH(request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const context = await getOrganizationContext();
  const { itemId } = await params;
  const role = context.organizations.find((organization) => organization.id === context.activeOrganization?.id)?.role;

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }
  if (!canManage(role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  let action: unknown;
  try {
    ({ action } = await request.json() as { action?: unknown });
  } catch {
    return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
  }

  if (action !== 'cancel' && action !== 'retry') {
    return NextResponse.json({ error: 'Ação de fila inválida.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const organizationId = context.activeOrganization.id;
  const { data: item, error: itemError } = await supabase
    .from('publication_items')
    .select('id, status, batch_id, attempt_count')
    .eq('id', itemId)
    .eq('organization_id', organizationId)
    .single();

  if (itemError || !item) {
    return NextResponse.json({ error: 'Publicação não encontrada.' }, { status: 404 });
  }

  if (action === 'cancel') {
    if (!['waiting', 'ready', 'preparing', 'publishing', 'failed'].includes(item.status)) {
      return NextResponse.json({ error: 'A publicação não pode mais ser cancelada neste estágio.' }, { status: 409 });
    }

    const { error } = await supabase
      .from('publication_items')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        next_attempt_at: null,
        lease_until: null,
        claimed_by: null,
        creation_id: null,
      })
      .eq('id', item.id)
      .eq('organization_id', organizationId);

    if (error) return NextResponse.json({ error: 'Não foi possível cancelar a publicação.' }, { status: 500 });

    const { error: eventError } = await supabase.rpc('log_publication_item_event', {
      p_item_id: item.id,
      p_event_type: 'cancelled',
      p_previous_status: item.status,
      p_status: 'cancelled',
      p_actor_user_id: context.user.id,
      p_actor_label: context.user.email ?? null,
      p_metadata: { action: 'cancelled_by_user' },
    });
    if (eventError) return NextResponse.json({ error: 'Publicação cancelada, mas não foi possível registrar seu histórico.' }, { status: 500 });

    const { error: batchError } = await supabase.rpc('sync_publication_batch_status', { p_batch_id: item.batch_id });
    if (batchError) return NextResponse.json({ error: 'Publicação cancelada, mas não foi possível atualizar o lote.' }, { status: 500 });
    return NextResponse.json({ item: { ...item, status: 'cancelled' } });
  }

  if (item.status !== 'failed') {
    return NextResponse.json({ error: 'Somente publicações com falha podem ser reprocessadas.' }, { status: 409 });
  }
  if (item.attempt_count >= PUBLICATION_MAX_ATTEMPTS) {
    return NextResponse.json({ error: `Esta publicação já atingiu o limite de ${PUBLICATION_MAX_ATTEMPTS} tentativas.` }, { status: 409 });
  }

  const { error } = await supabase
    .from('publication_items')
    .update({
      status: 'ready',
      next_attempt_at: null,
      lease_until: null,
      claimed_by: null,
      creation_id: null,
      last_error_code: null,
      last_error_message: null,
    })
    .eq('id', item.id)
    .eq('organization_id', organizationId);

  if (error) return NextResponse.json({ error: 'Não foi possível reprocessar a publicação.' }, { status: 500 });

  const { error: eventError } = await supabase.rpc('log_publication_item_event', {
    p_item_id: item.id,
    p_event_type: 'retry_requested',
    p_previous_status: item.status,
    p_status: 'ready',
    p_actor_user_id: context.user.id,
    p_actor_label: context.user.email ?? null,
    p_metadata: { action: 'retry_requested', previous_error_preserved_in_history: true },
  });
  if (eventError) return NextResponse.json({ error: 'Publicação reenfileirada, mas não foi possível registrar seu histórico.' }, { status: 500 });
  return NextResponse.json({ item: { ...item, status: 'ready', last_error_message: null } });
}
