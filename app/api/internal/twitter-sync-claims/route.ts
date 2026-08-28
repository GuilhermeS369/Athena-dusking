import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterRolloutActive } from '@/lib/twitter/feature';
import { isTwitterWorkerAuthorized } from '@/lib/twitter/worker-auth';

export async function POST(request: Request) {
  if (!isTwitterWorkerAuthorized(request, 'sync')) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }
  if (
    !isTwitterRolloutActive() ||
    process.env.TWITTER_SYNC_WORKER_ENABLED !== 'true'
  ) {
    return NextResponse.json({ items: [], disabled: true });
  }

  const body = (await request.json().catch(() => ({}))) as {
    workerId?: unknown;
    limit?: unknown;
    leaseSeconds?: unknown;
  };
  const workerId =
    typeof body.workerId === 'string'
      ? body.workerId.slice(0, 255)
      : 'twitter-sync-worker';
  const limit = typeof body.limit === 'number' ? body.limit : 1;
  const leaseSeconds =
    typeof body.leaseSeconds === 'number' ? body.leaseSeconds : 300;
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc(
    'twitter_claim_sync_jobs',
    {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    },
  );

  if (error) return NextResponse.json({ error: 'Falha no claim de sync X.' }, { status: 500 });

  try {
    const items = await Promise.all(((data ?? []) as Array<Record<string, unknown>>).map(async (item) => {
      const connectionId = String(item.connection_id ?? '');
      const { data: epochs, error: epochError } = await admin.from('twitter_profile_connection_epochs')
        .select('zernio_account_id,profile_id')
        .eq('connection_id', connectionId)
        .is('ended_at', null);
      if (epochError) throw epochError;
      const profileIds = [...new Set((epochs ?? []).map((epoch) => epoch.profile_id))];
      const { data: profiles, error: profileError } = profileIds.length
        ? await admin.from('twitter_profiles').select('id,analytics_enabled').in('id', profileIds)
        : { data: [], error: null };
      if (profileError) throw profileError;
      const desiredByProfile = new Map((profiles ?? []).map((profile) => [profile.id, profile.analytics_enabled !== false]));
      return {
        ...item,
        profile_capabilities: (epochs ?? []).map((epoch) => ({
          account_id: epoch.zernio_account_id,
          analytics_enabled: desiredByProfile.get(epoch.profile_id) !== false,
        })),
      };
    }));
    return NextResponse.json({ items });
  } catch {
    return NextResponse.json({ error: 'Falha ao carregar as preferências de Analytics dos perfis.' }, { status: 500 });
  }
}
