import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { isSystemSuperUser } from '@/lib/security/super-user';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const pageSizeDefault = 80;
const pageSizeMaximum = 150;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type OperationEventPageRow = Record<string, unknown> & { id: string; created_at: string };

function integerParam(value: string | null, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const url = new URL(request.url);
  const limit = integerParam(url.searchParams.get('limit'), pageSizeDefault, 1, pageSizeMaximum);
  const cursorCreatedAt = url.searchParams.get('cursorCreatedAt');
  const cursorId = url.searchParams.get('cursorId');

  if ((cursorCreatedAt && !cursorId) || (!cursorCreatedAt && cursorId) || (cursorId && !uuidPattern.test(cursorId))) {
    return NextResponse.json({ error: 'Cursor inválido.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: visibility, error: visibilityError } = await supabase
    .from('operational_log_clear_actions')
    .select('cleared_at')
    .eq('organization_id', context.activeOrganization.id)
    .eq('actor_user_id', context.user.id)
    .eq('scope_key', 'publication_events')
    .is('undone_at', null)
    .maybeSingle();
  if (visibilityError) {
    console.error('Não foi possível carregar a visibilidade dos eventos operacionais.', { organizationId: context.activeOrganization.id, error: visibilityError });
    return NextResponse.json({ error: 'Não foi possível carregar os eventos operacionais.' }, { status: 500 });
  }
  const isSuperUser = isSystemSuperUser(context.user.email);
  const selectFields = isSuperUser
    ? 'id, publication_item_id, event_type, previous_status, status, actor_label, error_code, error_message, metadata, created_at, publication_items(profile_id, format, batch_id, publication_batches(name))'
    : 'id, publication_item_id, event_type, previous_status, status, actor_label, error_code, error_message, created_at, publication_items(profile_id, format, batch_id, publication_batches(name))';
  let query = supabase
    .from('publication_item_events')
    .select(selectFields)
    .eq('organization_id', context.activeOrganization.id)
  // Remoções automáticas não são item de atenção: elas já têm o próprio painel.
  // Desde a migration 347 o motivo acompanha o sinal do incidente, então são dois
  // códigos automáticos em vez de um. A exclusão pedida pelo operador fica de
  // fora desta supressão de propósito — é ação deliberada e merece aparecer.
    .or('error_code.is.null,and(error_code.neq.zernio_account_disconnected,error_code.neq.zernio_duplicate_identity_removed)')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);
  if (visibility?.cleared_at) query = query.gt('created_at', visibility.cleared_at);

  if (cursorCreatedAt && cursorId) {
    query = query.or(`created_at.lt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.lt.${cursorId})`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('Não foi possível carregar eventos operacionais.', { organizationId: context.activeOrganization.id, error });
    return NextResponse.json({ error: 'Não foi possível carregar eventos operacionais.' }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as OperationEventPageRow[];
  const page = rows.slice(0, limit).map((event) => (isSuperUser ? event : { ...event, actor_label: null, metadata: null }));
  const last = page.at(-1);
  return NextResponse.json({
    events: page,
    hasMore: rows.length > limit,
    nextCursor: last ? { createdAt: last.created_at, id: last.id } : null,
  });
}
