import { NextResponse } from 'next/server';

import { META_GRAPH_API_VERSION } from '@/lib/integrations/meta-oauth';
import { createZernioClientForConnection, createZernioClientForOrganization } from '@/lib/integrations/zernio-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { decryptToken } from '@/lib/security/token-crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

type MetaHealthResponse = {
  user_id?: string;
  id?: string;
  username?: string;
  name?: string;
  account_type?: string;
  profile_picture_url?: string;
  error?: {
    code?: number;
    type?: string;
    message?: string;
  };
};

function errorMessage(payload: MetaHealthResponse, fallback: string) {
  const message = payload.error?.message?.trim();
  return message ? message.slice(0, 500) : fallback;
}

function normalizedUsername(value: string | undefined) {
  return value?.trim() || undefined;
}

function isReauthorizationError(response: Response, payload: MetaHealthResponse) {
  return response.status === 401
    || response.status === 403
    || payload.error?.code === 190
    || payload.error?.type === 'OAuthException';
}

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ profileId: string }> },
) {
  const { profileId } = await params;
  const context = await getOrganizationContext();
  const organization = context.organizations.find(
    (item) => item.id === context.activeOrganization?.id,
  );

  if (!context.user || !organization) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  if (!['admin', 'operator'].includes(organization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  try {
    const admin = createSupabaseAdminClient();
    const { data: profile, error: profileError } = await admin
      .from('instagram_profiles')
      .select('id, organization_id, provider, encrypted_access_token, zernio_account_id, zernio_connection_id, deleted_at')
      .eq('id', profileId)
      .eq('organization_id', organization.id)
      .is('deleted_at', null)
      .maybeSingle();

    if (profileError || !profile) {
      return NextResponse.json({ error: 'Perfil não encontrado.' }, { status: 404 });
    }

    if (profile.provider === 'zernio') {
      const client = profile.zernio_connection_id
        ? await createZernioClientForConnection(organization.id, profile.zernio_connection_id)
        : await createZernioClientForOrganization(organization.id);
      const health = await client.accountsHealth();
      const account = (health.accounts ?? []).find((item) => item.accountId === profile.zernio_account_id || item._id === profile.zernio_account_id || item.id === profile.zernio_account_id);
      const checkedAt = new Date().toISOString();
      const normalizedStatus = String(account?.status ?? '').toLowerCase();
      const status = account && !['offline', 'failed', 'error', 'unhealthy', 'reauthorization_required'].includes(normalizedStatus) && account.canPost !== false ? 'online' : 'offline';
      const message = status === 'online'
        ? 'Perfil Zernio verificado com sucesso.'
        : 'A Zernio informou que a conta não está saudável para postagem.';

      const { error: updateError } = await admin
        .from('instagram_profiles')
        .update({
          status,
          last_checked_at: checkedAt,
          last_success_at: status === 'online' ? checkedAt : undefined,
          last_failure_at: status === 'online' ? undefined : checkedAt,
          last_error_code: status === 'online' ? null : account?.status ?? 'zernio_health_failed',
          last_error_message: status === 'online' ? null : message,
          zernio_account_metadata: account ?? undefined,
        })
        .eq('id', profile.id)
        .eq('organization_id', organization.id);

      if (updateError) return NextResponse.json({ error: 'Não foi possível salvar o resultado da checagem.' }, { status: 500 });
      return NextResponse.json({ status, checkedAt, message });
    }

    if (!profile.encrypted_access_token) {
      return NextResponse.json({ error: 'Perfil Meta sem token. Reconecte o perfil.' }, { status: 400 });
    }

    const accessToken = decryptToken(profile.encrypted_access_token);
    const metaResponse = await fetch(
      `https://graph.instagram.com/${META_GRAPH_API_VERSION}/me?${new URLSearchParams({
        fields: 'user_id,username,account_type,profile_picture_url',
        access_token: accessToken,
      })}`,
      { cache: 'no-store' },
    );
    const payload = await metaResponse.json() as MetaHealthResponse;
    const checkedAt = new Date().toISOString();
    const reauthorizationRequired = isReauthorizationError(metaResponse, payload);
    const status = metaResponse.ok && payload.username
      ? 'online'
      : reauthorizationRequired
        ? 'reauthorization_required'
        : 'offline';

    const { error: updateError } = await admin
      .from('instagram_profiles')
      .update({
        status,
        username: normalizedUsername(payload.username),
        display_name: payload.name ?? undefined,
        profile_picture_url: payload.profile_picture_url ?? undefined,
        account_type: payload.account_type ?? undefined,
        last_checked_at: checkedAt,
        last_success_at: status === 'online' ? checkedAt : undefined,
        last_failure_at: status === 'online' ? undefined : checkedAt,
        last_error_code: status === 'online'
          ? null
          : String(payload.error?.code ?? metaResponse.status),
        last_error_message: status === 'online'
          ? null
          : errorMessage(payload, 'A checagem do perfil falhou.'),
      })
      .eq('id', profile.id)
      .eq('organization_id', organization.id);

    if (updateError) {
      return NextResponse.json({ error: 'Não foi possível salvar o resultado da checagem.' }, { status: 500 });
    }

    return NextResponse.json({
      status,
      checkedAt,
      message: status === 'online' ? 'Perfil verificado com sucesso.' : errorMessage(payload, 'A checagem falhou.'),
    });
  } catch (error) {
    const message = error instanceof Error && error.message.includes('TOKEN_ENCRYPTION_KEY')
      ? 'A chave de criptografia do servidor não está configurada.'
      : 'Não foi possível executar a checagem do perfil.';

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
