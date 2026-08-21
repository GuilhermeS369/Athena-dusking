import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const pageSizeDefault = 80;
const pageSizeMaximum = 150;
const allowedStatuses = new Set(['waiting', 'ready', 'preparing', 'publishing', 'published', 'failed', 'cancelled']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function defaultEndDate(start: Date) {
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 30);
  return end;
}

export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const url = new URL(request.url);
  const limitParam = Number(url.searchParams.get('limit') ?? pageSizeDefault);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), pageSizeMaximum) : pageSizeDefault;
  const profileId = url.searchParams.get('profileId');
  const status = url.searchParams.get('status');
  const cursorExecuteAt = url.searchParams.get('cursorExecuteAt');
  const cursorId = url.searchParams.get('cursorId');
  const start = parseDate(url.searchParams.get('start')) ?? new Date();
  const end = parseDate(url.searchParams.get('end')) ?? defaultEndDate(start);

  if (profileId && !uuidPattern.test(profileId)) {
    return NextResponse.json({ error: 'Perfil inválido.' }, { status: 400 });
  }
  if (status && status !== 'all' && !allowedStatuses.has(status)) {
    return NextResponse.json({ error: 'Status inválido.' }, { status: 400 });
  }
  if (end <= start) {
    return NextResponse.json({ error: 'Janela de agenda inválida.' }, { status: 400 });
  }
  if ((cursorExecuteAt && !cursorId) || (!cursorExecuteAt && cursorId) || (cursorId && !uuidPattern.test(cursorId))) {
    return NextResponse.json({ error: 'Cursor inválido.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('publication_items')
    .select('id, profile_id, format, status, execute_at, caption, attempt_count, next_attempt_at, last_error_code, last_error_message, published_at, created_at, instagram_profiles(username), publication_batches(name, timezone)')
    .eq('organization_id', context.activeOrganization.id)
    .not('execute_at', 'is', null)
    .gte('execute_at', start.toISOString())
    .lt('execute_at', end.toISOString())
    .order('execute_at', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
    .limit(limit + 1);

  if (profileId) query = query.eq('profile_id', profileId);
  if (status && status !== 'all') query = query.eq('status', status);
  if (cursorExecuteAt && cursorId) {
    query = query.or(`execute_at.gt.${cursorExecuteAt},and(execute_at.eq.${cursorExecuteAt},id.gt.${cursorId})`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('Não foi possível carregar itens da agenda.', { error, organizationId: context.activeOrganization.id });
    return NextResponse.json({ error: 'Não foi possível carregar a agenda.' }, { status: 500 });
  }

  const rows = data ?? [];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return NextResponse.json({
    items: page,
    hasMore: rows.length > limit,
    nextCursor: last?.execute_at ? { executeAt: last.execute_at, id: last.id } : null,
  });
}
