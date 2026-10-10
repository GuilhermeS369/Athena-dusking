import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import {
  continuousPostingErrorResponse,
  hasContinuousPostingManageRole,
  isContinuousPostingAllowed,
  isContinuousPostingUuid,
  parseContinuousPostingRuleInput,
} from '@/lib/publications/continuous-posting';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Configura a regra de postagem contínua de um grupo e formato. Salvar não liga
// nada: a chave é a rota `toggle`. Quem confere que o grupo e a origem são da
// organização de quem chama é a própria função do banco.

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await params;
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
  if (!isContinuousPostingUuid(groupId)) {
    return NextResponse.json({ error: 'Grupo inválido.' }, { status: 400 });
  }

  let input;
  try {
    input = parseContinuousPostingRuleInput(await request.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof RangeError ? error.message : 'Corpo da requisição inválido.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('upsert_continuous_posting_rule', {
    p_group_id: groupId,
    p_format: input.format,
    p_source_group_id: input.sourceGroupId ?? groupId,
    p_rotation_mode: input.rotationMode,
    p_posts_per_day: input.postsPerDay,
    p_window_start_minute: input.windowStartMinute,
    p_window_end_minute: input.windowEndMinute,
    p_caption: input.caption,
  });
  if (error) {
    const mapped = continuousPostingErrorResponse(error, input.format);
    if (mapped.status >= 500) console.error('Não foi possível salvar a regra de postagem contínua.', { groupId, format: input.format, code: error.code, message: error.message });
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }
  return NextResponse.json({ rule: data }, { headers: { 'Cache-Control': 'no-store' } });
}
