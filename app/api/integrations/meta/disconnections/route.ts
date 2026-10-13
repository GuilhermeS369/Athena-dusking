import { NextResponse } from 'next/server';

import type { MetaPendingDisconnection } from '@/lib/integrations/meta-disconnections';
import { getOrganizationContext } from '@/lib/organizations/server';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const PENDING_COLUMNS =
  'id, profile_id, meta_app_id, username_snapshot, meta_app_label_snapshot, error_code, error_message, detected_at, signal, profile:instagram_profiles(created_at)';

/**
 * Teto por chamada, alinhado ao da RPC. A tela confirma um app por vez — a
 * maior fila em 05/09/2026 tinha 63 perfis —, então esbarrar aqui é sinal de
 * chamada malformada, não de uso.
 */
const MAX_INCIDENTS_PER_CALL = 1000;

async function loadPending(organizationId: string) {
  const supabase = await createSupabaseServerClient();
  // Mesma ordem da página: `id` é chave primária, logo ordem total. Paginar por
  // `detected_at` repetiria linhas — uma leva inteira de quedas compartilha o
  // mesmo instante.
  return fetchAllRows<MetaPendingDisconnection>((from, to) => supabase
    .from('meta_profile_disconnection_incidents')
    .select(PENDING_COLUMNS)
    .eq('organization_id', organizationId)
    .is('slot_released_at', null)
    .order('id')
    .range(from, to)
    // Sem tipos gerados o cliente lê o embed como lista; pela FK ele é um só.
    .returns<MetaPendingDisconnection[]>());
}

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  const { data, error } = await loadPending(context.activeOrganization.id);
  if (error) return NextResponse.json({ error: 'Não foi possível carregar as quedas pendentes.' }, { status: 500 });
  return NextResponse.json({ pending: data });
}

/**
 * Registra que as conexões já foram apagadas no Meta Developers.
 *
 * A confirmação é do operador porque não há de onde tirá-la: a Graph API não
 * lista as contas conectadas ao app, então o Athena não tem como conferir nem
 * fazer a limpeza sozinho. O que ele faz é parar de contar aquelas vagas como
 * ocupadas — e é por isso que a resposta devolve a fila atualizada em vez de
 * um "ok": a tela precisa mostrar o que sobrou, não o que ela imagina.
 */
export async function POST(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as { incidentIds?: unknown; action?: unknown };
  const incidentIds = Array.isArray(body.incidentIds)
    ? [...new Set(body.incidentIds.filter((value): value is string => typeof value === 'string' && value.length > 0))]
    : [];
  const undo = body.action === 'undo';

  if (incidentIds.length === 0) {
    return NextResponse.json({ error: 'Marque ao menos um perfil para confirmar a remoção.' }, { status: 400 });
  }
  if (incidentIds.length > MAX_INCIDENTS_PER_CALL) {
    return NextResponse.json(
      { error: `Confirme no máximo ${MAX_INCIDENTS_PER_CALL} perfis por vez.` },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(
    undo ? 'revert_meta_profile_slot_release' : 'confirm_meta_profile_slot_release',
    { p_incident_ids: incidentIds },
  );

  if (error) {
    return NextResponse.json({
      error: undo
        ? 'Não foi possível desfazer. Recarregue a página para ver o estado atual.'
        : 'Não foi possível registrar a remoção. Tente de novo.',
    }, { status: 500 });
  }

  const result = (data ?? {}) as { requested?: number; released?: number; reverted?: number };
  const applied = (undo ? result.reverted : result.released) ?? 0;
  const { data: pending, error: pendingError } = await loadPending(context.activeOrganization.id);

  return NextResponse.json({
    undo,
    applied,
    requested: result.requested ?? incidentIds.length,
    // Zero aplicado com pedido cheio significa que alguém já tinha mexido
    // nessas linhas — outra aba, outro operador. A tela diz isso em vez de
    // fingir sucesso.
    unchanged: (result.requested ?? incidentIds.length) - applied,
    pending: pendingError ? null : pending,
  });
}
