import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

export async function GET() {
  const auth = await getTwitterRequestContext();
  if ('response' in auth) return auth.response;
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from('twitter_profiles')
    .select('id, twitter_user_id, identity_confidence, username, display_name, avatar_url, status, account_tier, tier_verified_at, can_post, can_fetch_analytics, token_valid, needs_reconnect, current_connection_id, last_health_at, last_synced_at, created_at')
    .eq('organization_id', auth.context.activeOrganization.id)
    .is('deleted_at', null)
    .order('username');
  if (error) return NextResponse.json({ error: 'Não foi possível carregar os perfis X.' }, { status: 500 });
  return NextResponse.json({ profiles: data ?? [] });
}
