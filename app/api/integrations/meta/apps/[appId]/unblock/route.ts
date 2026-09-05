import { NextResponse } from 'next/server';

import { META_APP_SAFE_COLUMNS } from '@/lib/integrations/meta-apps';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Zera a janela de bloqueio de API de um app da Meta.
 *
 * A janela expira sozinha depois de uma hora — é assim que a fila volta a
 * testar o app sem nenhum processo de sonda. Este botão existe para o caso em
 * que o operador destravou o app no Meta Developers antes disso: sem ele, o
 * app ficaria parado até o fim de uma janela que já não descreve a realidade.
 *
 * Não reenfileira nada, e isso é decisão de operação, não omissão: o que venceu
 * durante o bloqueio já foi marcado como `ignored` porque passou do horário.
 * Voltar a publicar significa retomar do próximo horário em diante.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ appId: string }> }) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  const { appId } = await params;
  if (!appId) return NextResponse.json({ error: 'App não informado.' }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('clear_meta_app_api_block', {
    p_organization_id: context.activeOrganization.id,
    p_app_id: appId,
  });

  if (error) {
    const notFound = error.code === 'P0002';
    return NextResponse.json(
      { error: notFound ? 'App não encontrado.' : 'Não foi possível desbloquear o app. Tente de novo.' },
      { status: notFound ? 404 : 500 },
    );
  }

  // Devolve a linha atualizada para a tela não precisar adivinhar o novo estado.
  const { data: app } = await supabase
    .from('meta_apps_safe')
    .select(META_APP_SAFE_COLUMNS)
    .eq('organization_id', context.activeOrganization.id)
    .eq('id', appId)
    .maybeSingle();

  return NextResponse.json({ unblocked: true, app: app ?? null });
}
