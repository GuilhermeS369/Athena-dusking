import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * O estado da coleta, para o indicador que substituiu o botão "atualizar".
 *
 * O botão saía caro por natureza: cada clique disparava uma varredura da frota,
 * e a única coisa que o operador queria saber era se o dado estava fresco. A
 * coleta agora acontece em três horários fixos (migration 387) e a tela apenas
 * *informa* — girando enquanto a rodada corre, apagando quando ela termina, e
 * dizendo qual é o próximo horário.
 *
 * A rodada é global: a resposta é a mesma para qualquer organização. Exige
 * sessão porque é informação de operação, não pública.
 */
export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('get_meta_analytics_run_status');

  if (error) {
    // Sem estado de coleta a dashboard continua inteira — o indicador
    // simplesmente não aparece. Nada aqui justifica derrubar a tela.
    return NextResponse.json({ status: null }, { headers: { 'Cache-Control': 'no-store' } });
  }

  return NextResponse.json({ status: data }, { headers: { 'Cache-Control': 'no-store' } });
}
