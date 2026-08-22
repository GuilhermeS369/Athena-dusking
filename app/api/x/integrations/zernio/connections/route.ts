import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';
import { provisionTwitterZernioConnection } from '@/lib/twitter/zernio-connections';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await getTwitterRequestContext();
  if ('response' in auth) return auth.response;
  const organizationId = auth.context.activeOrganization.id;
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('twitter_connections')
    .select('id, identity_id, label, zernio_profile_id, status, analytics_enabled, inbox_enabled, last_verified_at, last_sync_at, last_error_code, last_error_message, created_at, updated_at')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: 'Não foi possível carregar as conexões do X.' }, { status: 500 });
  const identities = [...new Set((data ?? []).map((row) => row.identity_id))];
  const { data: wallets } = identities.length
    ? await admin.from('twitter_wallets').select('identity_id, posted_balance_micros, reserved_micros, version').in('identity_id', identities)
    : { data: [] };
  const walletByIdentity = new Map((wallets ?? []).map((wallet) => [wallet.identity_id, wallet]));
  return NextResponse.json({
    connections: (data ?? []).map((connection) => ({
      ...connection,
      wallet: walletByIdentity.get(connection.identity_id) ?? null,
    })),
  });
}

export async function POST(request: Request) {
  const auth = await getTwitterRequestContext('admin');
  if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => ({})) as { label?: unknown; apiKey?: unknown };
  const label = typeof body.label === 'string' ? body.label : '';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
  try {
    const result = await provisionTwitterZernioConnection({
      organizationId: auth.context.activeOrganization.id,
      organizationName: auth.context.activeOrganization.name,
      actorUserId: auth.context.user.id,
      actorEmail: auth.context.user.email,
      label,
      apiKey,
    });
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Não foi possível cadastrar a conexão Zernio do X.';
    const conflict = message.includes('outra organização');
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 400 });
  }
}
