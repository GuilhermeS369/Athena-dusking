import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import {
  continuousPostingErrorResponse,
  hasContinuousPostingManageRole,
  isContinuousPostingAllowed,
  isContinuousPostingUuid,
  parseContinuousPostingToggleInput,
} from '@/lib/publications/continuous-posting';
import type { ContinuousPostingRule } from '@/lib/publications/continuous-posting';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Chave liga/desliga. O id da regra NÃO vem do corpo: é achado nas regras da
// organização ativa pelo grupo da URL e pelo formato, para a chave nunca agir
// numa regra de outro grupo ou de outra organização. Ao ligar, a função do banco
// aplica a guarda (fila aberta, reserva de horizonte, origem sem mídia, grupo sem
// perfil apto) e a recusa volta como 409 com a frase pronta.

export async function POST(
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
    input = parseContinuousPostingToggleInput(await request.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof RangeError ? error.message : 'Corpo da requisição inválido.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: rules, error: rulesError } = await supabase.rpc('get_continuous_posting_rules', { p_organization_id: context.activeOrganization.id });
  if (rulesError) {
    const mapped = continuousPostingErrorResponse(rulesError, input.format);
    if (mapped.status >= 500) console.error('Não foi possível consultar a regra de postagem contínua.', { groupId, format: input.format, code: rulesError.code, message: rulesError.message });
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }
  const rule = (Array.isArray(rules) ? rules as ContinuousPostingRule[] : [])
    .find((candidate) => candidate?.groupId?.toLowerCase() === groupId.toLowerCase() && candidate.format === input.format);
  if (!rule || !isContinuousPostingUuid(rule.id)) {
    return NextResponse.json({ error: 'Configure a postagem contínua deste grupo antes de usar a chave.' }, { status: 404 });
  }

  const { data, error } = await supabase.rpc('set_continuous_posting_rule_enabled', { p_rule_id: rule.id, p_enabled: input.enabled });
  if (error) {
    const mapped = continuousPostingErrorResponse(error, input.format);
    if (mapped.status >= 500) console.error('Não foi possível mudar a chave da postagem contínua.', { groupId, format: input.format, enabled: input.enabled, code: error.code, message: error.message });
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }
  return NextResponse.json({ rule: data }, { headers: { 'Cache-Control': 'no-store' } });
}
