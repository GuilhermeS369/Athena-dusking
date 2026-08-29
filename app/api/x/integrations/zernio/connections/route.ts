import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { fetchAllRowsByIds } from '@/lib/supabase/chunk';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';
import { provisionTwitterZernioConnection } from '@/lib/twitter/zernio-connections';

export const dynamic = 'force-dynamic';

type Cursor = { createdAt: string; id: string };
function decodeCursor(value: string | null): Cursor | null { if (!value) return null; try { const [createdAt,id]=Buffer.from(value,'base64url').toString('utf8').split('|'); return createdAt&&id&&!Number.isNaN(Date.parse(createdAt))?{createdAt,id}:null; } catch { return null; } }
function encodeCursor(row:{created_at:string;id:string}) { return Buffer.from(`${row.created_at}|${row.id}`).toString('base64url'); }

export async function GET(request: Request) {
  const auth = await getTwitterRequestContext();
  if ('response' in auth) return auth.response;
  const organizationId = auth.context.activeOrganization.id;
  const url = new URL(request.url);
  const limit = Math.min(100,Math.max(1,Number.parseInt(url.searchParams.get('limit')??'100',10)||100));
  const cursor = decodeCursor(url.searchParams.get('cursor'));
  if(url.searchParams.has('cursor')&&!cursor)return NextResponse.json({error:'Cursor de conexões X inválido.'},{status:400});
  const admin = createSupabaseAdminClient();
  let query = admin
    .from('twitter_connections')
    .select('id, identity_id, label, zernio_profile_id, status, analytics_enabled, inbox_enabled, last_verified_at, last_sync_at, last_error_code, last_error_message, created_at, updated_at, twitter_slot_limit, remote_twitter_account_count, remote_inventory_checked_at')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false }).order('id',{ascending:false}).limit(limit+1);
  if(cursor)query=query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: 'Não foi possível carregar as conexões do X.' }, { status: 500 });
  const rows=(data??[]).slice(0,limit);
  const identities = [...new Set(rows.map((row) => row.identity_id))];
  const connectionIds = rows.map((row) => row.id);
  const [{ data: wallets }, { data: grants }, { data: profiles }, { data: attempts }, { data: intents }] = await Promise.all([
    identities.length ? admin.from('twitter_wallets').select('identity_id, posted_balance_micros, reserved_micros, version').in('identity_id', identities) : Promise.resolve({ data: [] }),
    identities.length ? admin.from('twitter_wallet_grants').select('identity_id,amount_micros,created_at').in('identity_id', identities) : Promise.resolve({ data: [] }),
    fetchAllRowsByIds(connectionIds, (chunk, from, to) => admin.from('twitter_profiles').select('id,current_connection_id').eq('organization_id', organizationId).in('current_connection_id', chunk).is('deleted_at', null).order('id').range(from, to)).then((result) => ({ data: result.data })),
    connectionIds.length ? admin.from('twitter_connection_oauth_attempts').select('id,connection_id,expires_at').eq('organization_id', organizationId).in('connection_id', connectionIds).eq('status', 'pending').gt('expires_at', new Date().toISOString()).order('expires_at', { ascending: true }) : Promise.resolve({ data: [] }),
    connectionIds.length ? admin.from('twitter_connection_intents').select('id,connection_id,expires_at').eq('organization_id', organizationId).in('connection_id', connectionIds).in('status', ['queued','preparing','ready','callback_received','reconciling']).gt('expires_at', new Date().toISOString()).order('expires_at', { ascending: true }) : Promise.resolve({ data: [] }),
  ]);
  const walletByIdentity = new Map((wallets ?? []).map((wallet) => [wallet.identity_id, wallet]));
  const grantByIdentity = new Map((grants ?? []).map((grant) => [grant.identity_id, grant]));
  const profileCounts = new Map<string, number>();
  for (const profile of profiles) if (profile.current_connection_id) profileCounts.set(profile.current_connection_id, (profileCounts.get(profile.current_connection_id) ?? 0) + 1);
  const pendingCounts = new Map<string, number>();
  for (const attempt of attempts ?? []) pendingCounts.set(attempt.connection_id, (pendingCounts.get(attempt.connection_id) ?? 0) + 1);
  const reservationsByConnection = new Map<string, Array<{ id: string; expires_at: string }>>();
  for (const attempt of attempts ?? []) reservationsByConnection.set(attempt.connection_id, [...(reservationsByConnection.get(attempt.connection_id) ?? []), { id: attempt.id, expires_at: attempt.expires_at }]);
  for (const intent of intents ?? []) {
    pendingCounts.set(intent.connection_id, (pendingCounts.get(intent.connection_id) ?? 0) + 1);
    reservationsByConnection.set(intent.connection_id, [...(reservationsByConnection.get(intent.connection_id) ?? []), { id: intent.id, expires_at: intent.expires_at }]);
  }
  return NextResponse.json({
    connections: rows.map((connection) => ({
      ...connection,
      wallet: walletByIdentity.get(connection.identity_id) ?? null,
      grant: grantByIdentity.get(connection.identity_id) ?? null,
      twitter_profile_count: profileCounts.get(connection.id) ?? 0,
      active_slot_reservation_count: pendingCounts.get(connection.id) ?? 0,
      oauth_reservations: reservationsByConnection.get(connection.id) ?? [],
      remote_inventory_error_code: connection.last_error_code ?? (connection.remote_inventory_checked_at ? null : 'inventory_unavailable'),
    })),
    hasMore:(data??[]).length>limit,
    nextCursor:(data??[]).length>limit&&rows.length?encodeCursor(rows.at(-1)!):null,
    limit,
  });
}

export async function POST(request: Request) {
  const auth = await getTwitterRequestContext('admin');
  if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => ({})) as { label?: unknown; apiKey?: unknown };
  const label = typeof body.label === 'string' ? body.label : '';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
  try {
    const admin = createSupabaseAdminClient();
    const { data: settings } = await admin.from('twitter_organization_settings')
      .select('default_initial_grant_micros,default_twitter_slot_limit')
      .eq('organization_id', auth.context.activeOrganization.id).maybeSingle();
    const result = await provisionTwitterZernioConnection({
      organizationId: auth.context.activeOrganization.id,
      organizationName: auth.context.activeOrganization.name,
      actorUserId: auth.context.user.id,
      actorEmail: auth.context.user.email,
      label,
      apiKey,
      initialGrantMicros: Number(settings?.default_initial_grant_micros ?? 12_000_000),
      twitterSlotLimit: Number(settings?.default_twitter_slot_limit ?? 2),
    });
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Não foi possível cadastrar a conexão Zernio do X.';
    const conflict = message.includes('outra organização');
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 400 });
  }
}
