import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';
import { parseTwitterInitialGrantUsd } from '@/lib/twitter/zernio-import';

export async function PATCH(request: Request) {
  const auth = await getTwitterRequestContext('admin');
  if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const grant = parseTwitterInitialGrantUsd(typeof body.defaultInitialGrantUsd === 'string' ? body.defaultInitialGrantUsd : '');
  const limit = Number(body.defaultTwitterSlotLimit);
  if (grant === null || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ error: 'Informe saldo e limite padrão válidos.' }, { status: 400 });
  }
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from('twitter_organization_settings').upsert({
    organization_id: auth.context.activeOrganization.id,
    default_initial_grant_micros: grant,
    default_twitter_slot_limit: limit,
    updated_by: auth.context.user.id,
  }).select('default_initial_grant_micros,default_twitter_slot_limit').single();
  if (error) return NextResponse.json({ error: 'Não foi possível salvar os padrões do X.' }, { status: 500 });
  return NextResponse.json({ settings: data });
}
