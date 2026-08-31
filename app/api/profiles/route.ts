import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import { ACTIVE_ORGANIZATION_COOKIE } from '@/lib/organizations/server';
import {
  decodeInstagramProfilesCursor,
  getInstagramProfilesCatalogPage,
  normalizeInstagramProfilesFilters,
  normalizeInstagramProfilesLimit,
} from '@/lib/profiles/catalog';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();
  const [{ data: sessionData, error: sessionError }, cookieStore] = await Promise.all([
    supabase.auth.getSession(),
    cookies(),
  ]);
  const userId = sessionData.session?.user.id ?? null;
  if (sessionError || !userId) return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });

  let organizationId = cookieStore.get(ACTIVE_ORGANIZATION_COOKIE)?.value ?? null;
  if (!organizationId || !UUID_PATTERN.test(organizationId)) {
    const { data: membership, error: membershipError } = await supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', userId)
      .order('joined_at', { ascending: true })
      .limit(1)
      .maybeSingle<{ organization_id: string }>();
    if (membershipError || !membership) return NextResponse.json({ error: 'Organização ativa necessária.' }, { status: 401 });
    organizationId = membership.organization_id;
  }

  const url = new URL(request.url);
  const rawCursor = url.searchParams.get('cursor');
  const cursor = decodeInstagramProfilesCursor(rawCursor);
  if (rawCursor && !cursor) return NextResponse.json({ error: 'Cursor de perfis inválido.' }, { status: 400 });

  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '40', 10);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) return NextResponse.json({ error: 'Limite da página inválido.' }, { status: 400 });

  const filters = normalizeInstagramProfilesFilters({
    query: url.searchParams.get('query') ?? '',
    groupId: url.searchParams.get('groupId'),
    status: url.searchParams.get('status') as never,
    situation: url.searchParams.get('situation') as never,
    publication: url.searchParams.get('publication') as never,
    sort: url.searchParams.get('sort') as never,
  });
  const startedAt = performance.now();
  try {
    const page = await getInstagramProfilesCatalogPage({
      supabase,
      organizationId,
      filters,
      cursor,
      limit: normalizeInstagramProfilesLimit(rawLimit),
    });
    return NextResponse.json(page, {
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'Server-Timing': `profiles-catalog;dur=${Math.round(performance.now() - startedAt)}`,
      },
    });
  } catch (error) {
    console.error('Não foi possível carregar o catálogo paginado de perfis.', {
      organizationId,
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Não foi possível carregar os perfis do Instagram.' }, { status: 500 });
  }
}
