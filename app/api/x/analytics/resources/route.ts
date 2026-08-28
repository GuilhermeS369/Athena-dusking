import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 20;

type Cursor = { executeAt: string; id: string };
type ProjectionRow = {
  publication_item_id: string;
  collection_stage: 'd1' | 'd7' | 'd30' | 'forced';
  captured_at: string;
};

function decodeCursor(value: string): Cursor | null {
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (!cursor.executeAt || !uuid.test(cursor.id) || Number.isNaN(new Date(cursor.executeAt).getTime())) return null;
    return cursor;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const auth = await getTwitterRequestContext();
  if ('response' in auth) return auth.response;

  const url = new URL(request.url);
  const profileId = url.searchParams.get('profileId') ?? '';
  if (!uuid.test(profileId)) return NextResponse.json({ error: 'Perfil X inválido.' }, { status: 400 });

  const rawCursor = url.searchParams.get('cursor');
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) return NextResponse.json({ error: 'Cursor de posts inválido.' }, { status: 400 });

  const admin = createSupabaseAdminClient();
  const organizationId = auth.context.activeOrganization.id;
  const { data: profile, error: profileError } = await admin
    .from('twitter_profiles')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('id', profileId)
    .is('deleted_at', null)
    .maybeSingle();
  if (profileError) return NextResponse.json({ error: 'Falha ao validar o perfil X.' }, { status: 500 });
  if (!profile) return NextResponse.json({ error: 'Perfil X não encontrado.' }, { status: 404 });

  let query = admin
    .from('twitter_publication_items')
    .select('id,profile_id,connection_id,content,execute_at')
    .eq('organization_id', organizationId)
    .eq('profile_id', profileId)
    .eq('status', 'published')
    .order('execute_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(PAGE_SIZE + 1);
  if (cursor) query = query.or(`execute_at.lt.${cursor.executeAt},and(execute_at.eq.${cursor.executeAt},id.lt.${cursor.id})`);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: 'Falha ao carregar os posts locais.' }, { status: 500 });
  const rows = data ?? [];
  const page = rows.slice(0, PAGE_SIZE);
  const ids = page.map((item) => item.id);
  const projectionResult = ids.length
    ? await (admin.from('twitter_post_analytics_current' as never) as any)
        .select('publication_item_id,collection_stage,captured_at')
        .eq('organization_id', organizationId)
        .in('publication_item_id', ids)
    : { data: [], error: null };
  if (projectionResult.error) return NextResponse.json({ error: 'Falha ao carregar os estágios de analytics.' }, { status: 500 });

  const projectionByPost = new Map<string, ProjectionRow>(
    ((projectionResult.data ?? []) as ProjectionRow[]).map((row) => [row.publication_item_id, row]),
  );
  const last = page.at(-1);
  return NextResponse.json({
    posts: page.map((item) => {
      const projection = projectionByPost.get(item.id);
      return {
        id: item.id,
        profileId: item.profile_id,
        connectionId: item.connection_id,
        occurredAt: item.execute_at,
        content: item.content,
        completedStage: projection?.collection_stage ?? null,
        lastSnapshotAt: projection?.captured_at ?? null,
      };
    }),
    hasMore: rows.length > PAGE_SIZE,
    nextCursor: rows.length > PAGE_SIZE && last
      ? Buffer.from(JSON.stringify({ executeAt: last.execute_at, id: last.id })).toString('base64url')
      : null,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
