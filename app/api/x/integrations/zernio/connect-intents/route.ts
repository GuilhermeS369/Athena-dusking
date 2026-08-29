import { NextResponse } from 'next/server';

import { enqueueTwitterConnectionIntent } from '@/lib/twitter/connection-intents';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';
import { resolveTwitterZernioTarget, type TwitterBulkConnection } from '@/lib/twitter/zernio-bulk';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/supabase/paginate';

export const dynamic = 'force-dynamic';

function cookieName(intentId: string) { return `twitter_intent_${intentId.replace(/-/g, '')}`; }

export async function POST(request: Request) {
  const auth = await getTwitterRequestContext('admin');
  if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => ({})) as {
    mode?: unknown; connectionId?: unknown; groupId?: unknown; target?: unknown; idempotencyKey?: unknown;
  };
  if ((body.mode !== 'manual' && body.mode !== 'bulk') || typeof body.idempotencyKey !== 'string') {
    return NextResponse.json({ error: 'Solicitação de conexão X inválida.' }, { status: 400 });
  }
  const organizationId = auth.context.activeOrganization.id;
  const admin = createSupabaseAdminClient();
  let connectionId = typeof body.connectionId === 'string' ? body.connectionId : '';
  let groupId = typeof body.groupId === 'string' && body.groupId ? body.groupId : null;
  if (body.mode === 'bulk') {
    if (typeof body.target !== 'string') return NextResponse.json({ error: 'Cole uma linha válida do Bulk Zernio X.' }, { status: 400 });
    const [{ data: connections }, { data: groups }, { data: profiles }, { data: intents }, { data: legacyAttempts }] = await Promise.all([
      // Com ~2 slots por conexão, a frota atual já implica centenas de conexões:
      // perto demais do teto de 1.000 para confiar no corte implícito.
      fetchAllRows((from, to) => admin.from('twitter_connections').select('id,label,twitter_slot_limit,remote_twitter_account_count,remote_inventory_checked_at,last_error_code').eq('organization_id', organizationId).is('deleted_at', null).order('id').range(from, to)),
      admin.from('twitter_groups').select('id,name').eq('organization_id', organizationId).is('deleted_at', null),
      // Uma linha por perfil: cortado em 1.000, a barreira de capacidade local
      // acreditaria haver slot livre em conexões já cheias.
      fetchAllRows((from, to) => admin.from('twitter_profiles').select('id,current_connection_id').eq('organization_id', organizationId).is('deleted_at', null).order('id').range(from, to)),
      admin.from('twitter_connection_intents').select('connection_id').eq('organization_id', organizationId).in('status', ['queued','preparing','ready','callback_received','reconciling']).gt('expires_at', new Date().toISOString()),
      admin.from('twitter_connection_oauth_attempts').select('connection_id').eq('organization_id', organizationId).eq('status', 'pending').gt('expires_at', new Date().toISOString()),
    ]);
    const local = new Map<string, number>();
    const reserved = new Map<string, number>();
    for (const profile of profiles) if (profile.current_connection_id) local.set(profile.current_connection_id, (local.get(profile.current_connection_id) ?? 0) + 1);
    for (const intent of intents ?? []) reserved.set(intent.connection_id, (reserved.get(intent.connection_id) ?? 0) + 1);
    for (const attempt of legacyAttempts ?? []) reserved.set(attempt.connection_id, (reserved.get(attempt.connection_id) ?? 0) + 1);
    const candidates = connections.map((connection) => ({ ...connection, remote_inventory_error_code: connection.last_error_code, twitter_profile_count: local.get(connection.id) ?? 0, active_slot_reservation_count: reserved.get(connection.id) ?? 0 })) as TwitterBulkConnection[];
    const resolved = resolveTwitterZernioTarget(candidates, groups ?? [], body.target);
    if (!resolved.valid || !resolved.connection) return NextResponse.json({ error: 'A linha não corresponde exatamente a uma conexão e grupo X disponíveis.' }, { status: 400 });
    connectionId = resolved.connection.id;
    groupId = resolved.group?.id ?? null;
  }
  try {
    const result = await enqueueTwitterConnectionIntent({
      organizationId, connectionId, groupId, actorUserId: auth.context.user.id,
      idempotencyKey: body.idempotencyKey, origin: new URL(request.url).origin,
    });
    const response = NextResponse.json({
      intentId: result.intentId, trackingToken: result.accessToken,
      state: result.status, expiresAt: result.expiresAt,
    }, { status: 202 });
    response.cookies.set(cookieName(result.intentId), result.accessToken, {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
      path: `/api/x/integrations/zernio/connect-intents/${result.intentId}`, maxAge: 20 * 60,
    });
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Não foi possível enfileirar a conexão X.' }, { status: 409 });
  }
}
