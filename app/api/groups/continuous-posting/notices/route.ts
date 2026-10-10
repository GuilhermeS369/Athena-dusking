import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import {
  continuousPostingErrorResponse,
  hasContinuousPostingManageRole,
  isContinuousPostingAllowed,
  isContinuousPostingUuid,
  parseContinuousPostingClearInput,
} from '@/lib/publications/continuous-posting';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Avisos da postagem contínua: post pulado, perfil em descanso, regra pausada e
// item encerrado sem postar. Esta rota só lista e limpa o aviso — limpar não
// recria nem republica nada. A função devolve os não limpos, mais recente
// primeiro, até o limite padrão dela (200).

export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }
  if (!isContinuousPostingAllowed(context.activeOrganization.id)) {
    return NextResponse.json({ error: 'Não encontrado.' }, { status: 404 });
  }

  const groupId = new URL(request.url).searchParams.get('groupId');
  if (groupId && !isContinuousPostingUuid(groupId)) {
    return NextResponse.json({ error: 'Grupo inválido.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('get_continuous_posting_notices', {
    p_organization_id: context.activeOrganization.id,
    p_group_id: groupId || null,
  });
  if (error) {
    const mapped = continuousPostingErrorResponse(error);
    if (mapped.status >= 500) console.error('Não foi possível consultar os avisos da postagem contínua.', error);
    return NextResponse.json({ error: mapped.status >= 500 ? 'Não foi possível consultar os avisos.' : mapped.message }, { status: mapped.status });
  }
  return NextResponse.json({ notices: Array.isArray(data) ? data : [] }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }
  if (!hasContinuousPostingManageRole(context.activeOrganization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }
  if (!isContinuousPostingAllowed(context.activeOrganization.id)) {
    return NextResponse.json({ error: 'Não encontrado.' }, { status: 404 });
  }

  let input;
  try {
    input = parseContinuousPostingClearInput(await request.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof RangeError ? error.message : 'Corpo da requisição inválido.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: cleared, error } = await supabase.rpc('clear_continuous_posting_notices', {
    p_notice_ids: input.noticeIds,
    p_item_ids: input.itemIds,
  });
  if (error) {
    const mapped = continuousPostingErrorResponse(error);
    if (mapped.status >= 500) console.error('Não foi possível limpar os avisos da postagem contínua.', error);
    return NextResponse.json({ error: mapped.status >= 500 ? 'Não foi possível limpar os avisos.' : mapped.message }, { status: mapped.status });
  }
  return NextResponse.json({ cleared: typeof cleared === 'number' ? cleared : 0 }, { headers: { 'Cache-Control': 'no-store' } });
}
