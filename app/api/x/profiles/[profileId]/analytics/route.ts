import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';
import { loadTwitterZernioConnection } from '@/lib/twitter/zernio-connections';

type Body = { enabled?: unknown; idempotencyKey?: unknown };

export async function PATCH(request: Request, { params }: { params: Promise<{ profileId: string }> }) {
  const auth = await getTwitterRequestContext('admin');
  if ('response' in auth) return auth.response;
  const { profileId } = await params;
  const body = await request.json().catch(() => ({})) as Body;
  if (typeof body.enabled !== 'boolean' || typeof body.idempotencyKey !== 'string' || body.idempotencyKey.trim().length < 8) {
    return NextResponse.json({ error: 'Alteração de Analytics inválida.' }, { status: 400 });
  }

  const organizationId = auth.context.activeOrganization.id;
  const admin = createSupabaseAdminClient();
  const { data: profile, error: profileError } = await admin.from('twitter_profiles')
    .select('id,current_connection_id,current_epoch_id,analytics_enabled')
    .eq('id', profileId).eq('organization_id', organizationId).is('deleted_at', null).maybeSingle();
  if (profileError) return NextResponse.json({ error: 'Não foi possível validar o perfil X.' }, { status: 500 });
  if (!profile?.current_connection_id || !profile.current_epoch_id) return NextResponse.json({ error: 'Perfil X sem conexão ativa.' }, { status: 409 });
  const { data: epoch } = await admin.from('twitter_profile_connection_epochs')
    .select('zernio_account_id').eq('id', profile.current_epoch_id).eq('profile_id', profile.id).is('ended_at', null).maybeSingle();
  if (!epoch?.zernio_account_id) return NextResponse.json({ error: 'Conta Zernio atual do perfil não encontrada.' }, { status: 409 });

  const setLocal = (enabled: boolean, key: string, reason: string) => admin.rpc('twitter_set_profile_analytics_enabled', {
    p_organization_id: organizationId,
    p_profile_id: profile.id,
    p_enabled: enabled,
    p_actor_user_id: auth.context.user.id,
    p_actor_email: auth.context.user.email ?? null,
    p_idempotency_key: key,
    p_reason: reason,
  });

  try {
    const { client } = await loadTwitterZernioConnection(organizationId, profile.current_connection_id);
    if (!body.enabled && profile.analytics_enabled) {
      const local = await setLocal(false, body.idempotencyKey.trim(), 'Desativação solicitada na tela de Perfis X.');
      if (local.error) throw local.error;
      try {
        await client.setAccountCapabilities(epoch.zernio_account_id, { analytics: false });
      } catch (error) {
        await client.setAccountCapabilities(epoch.zernio_account_id, { analytics: true }).catch(() => undefined);
        await setLocal(true, `profile-analytics-rollback:${crypto.randomUUID()}`, 'Rollback automático após falha remota ao desativar Analytics.');
        throw error;
      }
    } else {
      await client.setAccountCapabilities(epoch.zernio_account_id, { analytics: body.enabled });
      const local = await setLocal(body.enabled, body.idempotencyKey.trim(), body.enabled
        ? 'Ativação solicitada na tela de Perfis X.'
        : 'Reconciliação de Analytics desligado na tela de Perfis X.');
      if (local.error) {
        if (profile.analytics_enabled !== body.enabled) {
          await client.setAccountCapabilities(epoch.zernio_account_id, { analytics: profile.analytics_enabled }).catch(() => undefined);
        }
        throw local.error;
      }
    }
    return NextResponse.json({ ok: true, profileId: profile.id, analyticsEnabled: body.enabled, inboxEnabled: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Não foi possível alterar o Analytics deste perfil X.' }, { status: 502 });
  }
}
