import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { encryptToken } from '@/lib/security/token-crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ appId: string }> },
) {
  const { appId } = await params;
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (context.activeOrganization.role !== 'admin') return NextResponse.json({ error: 'Somente administradores podem editar apps da Meta.' }, { status: 403 });

  const body = await request.json().catch(() => ({})) as {
    label?: unknown;
    active?: unknown;
    instagramSlotLimit?: unknown;
    appSecret?: unknown;
  };
  const label = typeof body.label === 'string' ? body.label.trim().replace(/\s+/g, ' ') : '';
  const appSecret = typeof body.appSecret === 'string' ? body.appSecret.trim() : '';
  const instagramSlotLimit = typeof body.instagramSlotLimit === 'number'
    && Number.isInteger(body.instagramSlotLimit)
    && body.instagramSlotLimit >= 1
    && body.instagramSlotLimit <= 1000
    ? body.instagramSlotLimit
    : null;

  if (body.label !== undefined && (label.length < 2 || label.length > 80)) {
    return NextResponse.json({ error: 'Informe um nome entre 2 e 80 caracteres.' }, { status: 400 });
  }
  if (body.instagramSlotLimit !== undefined && instagramSlotLimit === null) {
    return NextResponse.json({ error: 'Informe um limite entre 1 e 1000 vagas.' }, { status: 400 });
  }
  if (body.appSecret !== undefined && !/^[a-fA-F0-9]{16,64}$/.test(appSecret)) {
    return NextResponse.json({ error: 'A chave secreta do app parece incompleta.' }, { status: 400 });
  }
  if (body.label === undefined && body.active === undefined && body.instagramSlotLimit === undefined && body.appSecret === undefined) {
    return NextResponse.json({ error: 'Nada para atualizar.' }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .from('meta_apps')
    .update({
      ...(body.label === undefined ? {} : { label }),
      ...(body.active === undefined ? {} : { active: Boolean(body.active) }),
      ...(instagramSlotLimit === null ? {} : { instagram_slot_limit: instagramSlotLimit }),
      ...(body.appSecret === undefined ? {} : { encrypted_app_secret: encryptToken(appSecret) }),
    })
    .eq('id', appId)
    .eq('organization_id', context.activeOrganization.id)
    .is('deleted_at', null);

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Já existe um app ativo com esse nome.' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Não foi possível atualizar o app da Meta.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ appId: string }> },
) {
  const { appId } = await params;
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (context.activeOrganization.role !== 'admin') return NextResponse.json({ error: 'Somente administradores podem remover apps da Meta.' }, { status: 403 });

  const body = await request.json().catch(() => ({})) as { confirmConnectedProfiles?: unknown };
  const admin = createSupabaseAdminClient();

  const { count } = await admin
    .from('instagram_profiles')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', context.activeOrganization.id)
    .eq('meta_app_id', appId)
    .is('deleted_at', null);
  const connectedProfiles = count ?? 0;

  // Remover o app não desconecta nada: os perfis continuam publicando com o
  // token que já têm. O que se perde é a contagem de vagas daquele app, e por
  // isso a remoção com contas dentro exige confirmação explícita da tela.
  if (connectedProfiles > 0 && body.confirmConnectedProfiles !== true) {
    return NextResponse.json(
      {
        error: `Este app ainda tem ${connectedProfiles} perfil(is) conectado(s). Desative-o para parar de receber contas novas, ou confirme a remoção.`,
        connectedProfiles,
      },
      { status: 409 },
    );
  }

  const { error } = await admin
    .from('meta_apps')
    .update({ deleted_at: new Date().toISOString(), active: false })
    .eq('id', appId)
    .eq('organization_id', context.activeOrganization.id)
    .is('deleted_at', null);

  if (error) return NextResponse.json({ error: 'Não foi possível remover o app da Meta.' }, { status: 500 });

  // Sem isto, os perfis ficariam apontando para um app excluído: sumiriam da
  // contagem de vagas de todos os apps E da lista de perfis sem app, deixando
  // de ser visíveis em qualquer lugar. Soltá-los devolve o número à verdade —
  // eles realmente não ocupam mais vaga de app nenhum — e permite revinculá-los
  // depois pelo cadastro.
  if (connectedProfiles > 0) {
    const { error: unlinkError } = await admin
      .from('instagram_profiles')
      .update({ meta_app_id: null })
      .eq('organization_id', context.activeOrganization.id)
      .eq('meta_app_id', appId);

    if (unlinkError) {
      return NextResponse.json(
        { error: `O app foi removido, mas ${connectedProfiles} perfil(is) continuam vinculados a ele: ${unlinkError.message}` },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ ok: true, connectedProfiles });
}
