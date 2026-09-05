import { NextResponse } from 'next/server';

import { createZernioClientForConnection, createZernioClientForOrganization } from '@/lib/integrations/zernio-client';
import { softDeleteProfileAnalytics } from '@/lib/integrations/zernio-analytics';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ profileId: string }> },
) {
  const url = new URL(request.url);
  const disconnectZernio = url.searchParams.get('disconnectZernio') === 'true';
  const { profileId } = await params;
  const context = await getOrganizationContext();
  const organization = context.organizations.find(
    (item) => item.id === context.activeOrganization?.id,
  );

  if (!context.user || !organization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  if (!['admin', 'operator'].includes(organization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: profile, error: profileError } = await supabase
    .from('instagram_profiles_safe')
    .select('id, provider, zernio_account_id, zernio_connection_id')
    .eq('id', profileId)
    .eq('organization_id', organization.id)
    .is('deleted_at', null)
    .maybeSingle();

  if (profileError || !profile) {
    return NextResponse.json({ error: 'Perfil não encontrado.' }, { status: 404 });
  }

  if (disconnectZernio && profile.provider !== 'zernio') {
    return NextResponse.json({ error: 'A desconexão remota só está disponível para perfis Zernio.' }, { status: 400 });
  }

  if (disconnectZernio) {
    if (!profile.zernio_account_id) {
      return NextResponse.json({ error: 'Perfil Zernio sem identificador remoto para desconectar.' }, { status: 400 });
    }

    try {
      const zernio = profile.zernio_connection_id
        ? await createZernioClientForConnection(organization.id, profile.zernio_connection_id)
        : await createZernioClientForOrganization(organization.id);
      await zernio.disconnectAccount(profile.zernio_account_id);
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error
          ? `Não foi possível desconectar a conta na Zernio: ${error.message}`
          : 'Não foi possível desconectar a conta na Zernio.',
      }, { status: 502 });
    }
  }

  // Perfil Meta sai pelo caminho canônico de remoção, o mesmo do bulk de
  // /perfis, da exclusão de grupo e do botão de /recuperacao. Até aqui esta
  // rota fazia à mão só as duas últimas etapas — desvincular do grupo e marcar
  // `deleted_at` — e pulava a contenção inteira: as publicações já agendadas
  // continuavam vivas apontando para um perfil excluído, e só iam falhar
  // depois, uma a uma. Agora ela também registra a vaga que fica presa no Meta
  // Developers, que é o que a migration 391 passou a exigir de toda saída.
  if (profile.provider === 'meta_official') {
    const { error: removalError } = await supabase.rpc('enqueue_instagram_profile_removal', {
      p_organization_id: organization.id,
      p_profile_ids: [profile.id],
      p_actor_label: 'operator: /perfis (exclusão individual)',
    });

    if (removalError) {
      return NextResponse.json({ error: 'Não foi possível excluir o perfil.' }, { status: 400 });
    }

    await softDeleteProfileAnalytics(profile.id).catch((error) => {
      console.error('Falha ao remover snapshots de analytics do perfil excluído.', { profileId: profile.id, error });
    });

    return NextResponse.json({ ok: true });
  }

  // Zernio continua pelo caminho antigo, DE PROPÓSITO. Lá a exclusão local só
  // pode acontecer depois que o worker de reciclagem confirmar o DELETE remoto
  // — apagar antes esconderia da tela um perfil que ainda ocupa a vaga na
  // Zernio —, e esta rota tem um `disconnectZernio` que já fez a chamada remota
  // logo acima. Trocar isso é mexer no pipeline de um provedor que está sendo
  // substituído, sem ganho para a vaga da Meta. O buraco da contenção continua
  // aberto só para ele.
  const { error: membershipError } = await supabase
    .from('profile_group_members')
    .delete()
    .eq('organization_id', organization.id)
    .eq('profile_id', profile.id);

  if (membershipError) {
    return NextResponse.json({ error: 'Não foi possível remover o perfil do grupo.' }, { status: 400 });
  }

  const { error: deleteError } = await supabase
    .from('instagram_profiles')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', profile.id)
    .eq('organization_id', organization.id)
    .is('deleted_at', null);

  if (deleteError) {
    return NextResponse.json({ error: 'Não foi possível excluir o perfil.' }, { status: 400 });
  }

  await softDeleteProfileAnalytics(profile.id).catch((error) => {
    console.error('Falha ao remover snapshots de analytics do perfil excluído.', { profileId: profile.id, error });
  });

  return NextResponse.json({ ok: true });
}
