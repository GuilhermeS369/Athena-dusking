import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { isSystemSuperUser } from '@/lib/security/super-user';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const pageSizeDefault = 80;
const pageSizeMaximum = 150;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AttentionItemPageRow = Record<string, unknown> & { id: string; updated_at: string };

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
  const cursorUpdatedAt = url.searchParams.get('cursorUpdatedAt');
  const cursorId = url.searchParams.get('cursorId');

  if ((cursorUpdatedAt && !cursorId) || (!cursorUpdatedAt && cursorId) || (cursorId && !uuidPattern.test(cursorId))) {
    return NextResponse.json({ error: 'Cursor inválido.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: visibility, error: visibilityError } = await supabase
    .from('operational_log_clear_actions')
    .select('cleared_at')
    .eq('organization_id', context.activeOrganization.id)
    .eq('actor_user_id', context.user.id)
    .eq('scope_key', 'attention_items')
    .is('undone_at', null)
    .maybeSingle();
  if (visibilityError) {
    console.error('Não foi possível carregar a visibilidade dos itens operacionais.', { organizationId: context.activeOrganization.id, error: visibilityError });
    return NextResponse.json({ error: 'Não foi possível carregar publicações com atenção.' }, { status: 500 });
  }
  const isSuperUser = isSystemSuperUser(context.user.email);
  const selectFields = isSuperUser
    ? 'id, batch_id, format, status, profile_id, execute_at, last_error_code, last_error_message, attempt_count, next_attempt_at, lease_until, claimed_by, updated_at, created_at, publication_batches(name), publication_item_media(media_assets(id, status, deleted_at))'
    : 'id, batch_id, format, status, profile_id, execute_at, last_error_code, last_error_message, attempt_count, next_attempt_at, lease_until, updated_at, created_at, publication_batches(name), publication_item_media(media_assets(id, status, deleted_at))';
  let query = supabase
    .from('publication_items')
    .select(selectFields)
    .eq('organization_id', context.activeOrganization.id)
    .in('status', ['failed', 'preparing', 'publishing', 'removed'])
    .or('last_error_code.is.null,last_error_code.neq.zernio_account_disconnected')
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);
  if (visibility?.cleared_at) query = query.gt('updated_at', visibility.cleared_at);

  if (cursorUpdatedAt && cursorId) {
    query = query.or(`updated_at.lt.${cursorUpdatedAt},and(updated_at.eq.${cursorUpdatedAt},id.lt.${cursorId})`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('Não foi possível carregar publicações com atenção.', { organizationId: context.activeOrganization.id, error });
    return NextResponse.json({ error: 'Não foi possível carregar publicações com atenção.' }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as AttentionItemPageRow[];
  const page = rows.slice(0, limit).map((item) => (isSuperUser ? item : { ...item, claimed_by: null }));
  const last = page.at(-1);
  return NextResponse.json({
    items: page,
    hasMore: rows.length > limit,
    nextCursor: last ? { updatedAt: last.updated_at, id: last.id } : null,
  });
}
