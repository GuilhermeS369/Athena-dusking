import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

type Cursor = { createdAt: string; id: string };
function decodeCursor(value: string | null): Cursor | null {
  if (!value) return null;
  try { const [createdAt, id] = Buffer.from(value, 'base64url').toString('utf8').split('|'); return createdAt && id && !Number.isNaN(Date.parse(createdAt)) ? { createdAt, id } : null; }
  catch { return null; }
}
function encodeCursor(row: { created_at: string; id: string }) { return Buffer.from(`${row.created_at}|${row.id}`).toString('base64url'); }

export async function GET(request: Request) {
  const auth = await getTwitterRequestContext();
  if ('response' in auth) return auth.response;
  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100));
  const cursor = decodeCursor(url.searchParams.get('cursor'));
  if (url.searchParams.has('cursor') && !cursor) return NextResponse.json({ error: 'Cursor de perfis X inválido.' }, { status: 400 });
  const organizationId = auth.context.activeOrganization.id;
  const admin = createSupabaseAdminClient();
  let query = admin.from('twitter_profiles').select('id,twitter_user_id,identity_confidence,username,display_name,avatar_url,status,account_tier,tier_verified_at,can_post,can_fetch_analytics,analytics_enabled,token_valid,needs_reconnect,current_connection_id,last_health_at,last_synced_at,created_at').eq('organization_id', organizationId).is('deleted_at', null).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1);
  if (cursor) query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: 'Não foi possível carregar os perfis X.' }, { status: 500 });
  const rows = (data ?? []).slice(0, limit), profileIds = rows.map((row) => row.id);
  const connectionIds = [...new Set(rows.map((row) => row.current_connection_id).filter((id): id is string => Boolean(id)))];
  const [membersResult, queueResult, connectionsResult] = await Promise.all([
    profileIds.length ? admin.from('twitter_group_members').select('group_id,profile_id').eq('organization_id', organizationId).in('profile_id', profileIds) : Promise.resolve({ data: [], error: null }),
    profileIds.length ? admin.rpc('twitter_profile_queue_summary_page', { p_organization_id: organizationId, p_profile_ids: profileIds }) : Promise.resolve({ data: [], error: null }),
    connectionIds.length ? admin.from('twitter_connections').select('id,identity_id,label').eq('organization_id', organizationId).in('id', connectionIds).is('deleted_at', null) : Promise.resolve({ data: [], error: null }),
  ]);
  if (membersResult.error || queueResult.error || connectionsResult.error) return NextResponse.json({ error: 'Não foi possível enriquecer os perfis X.' }, { status: 500 });
  const identityIds = [...new Set((connectionsResult.data ?? []).map((row) => row.identity_id))];
  const walletsResult = identityIds.length ? await admin.from('twitter_wallets').select('identity_id,posted_balance_micros,reserved_micros').eq('organization_id', organizationId).in('identity_id', identityIds) : { data: [], error: null };
  if (walletsResult.error) return NextResponse.json({ error: 'Não foi possível carregar os saldos X.' }, { status: 500 });
  const groups = new Map<string, string[]>(); for (const member of membersResult.data ?? []) groups.set(member.profile_id, [...(groups.get(member.profile_id) ?? []), member.group_id]);
  const queues = new Map((queueResult.data ?? []).map((row: { profile_id: string }) => [row.profile_id, row]));
  const connections = new Map((connectionsResult.data ?? []).map((row) => [row.id, row]));
  const wallets = new Map((walletsResult.data ?? []).map((row) => [row.identity_id, row]));
  const profiles = rows.map((profile) => { const connection = profile.current_connection_id ? connections.get(profile.current_connection_id) : null; const wallet = connection ? wallets.get(connection.identity_id) : null; const queue = queues.get(profile.id) as Record<string, unknown> | undefined; return { ...profile, connection_label: connection?.label ?? null, available_micros: Number(wallet?.posted_balance_micros ?? 0) - Number(wallet?.reserved_micros ?? 0), group_ids: groups.get(profile.id) ?? [], pending_count: Number(queue?.pending_count ?? 0), text_count: Number(queue?.text_count ?? 0), image_count: Number(queue?.image_count ?? 0), gif_count: Number(queue?.gif_count ?? 0), video_count: Number(queue?.video_count ?? 0) }; });
  const hasMore = (data ?? []).length > limit;
  return NextResponse.json({ profiles, hasMore, nextCursor: hasMore && rows.length ? encodeCursor(rows.at(-1)!) : null, limit });
}
