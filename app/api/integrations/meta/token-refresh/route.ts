import { NextResponse } from 'next/server';

import { refreshMetaProfileTokens } from '@/lib/integrations/meta-token-refresh';
import {
  META_TOKEN_REFRESH_AFTER_DAYS,
  metaTokenRenewalState,
  type MetaTokenProfile,
} from '@/lib/integrations/meta-token-renewal';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/**
 * Quantos perfis um clique renova. O teto existe porque cada perfil é uma
 * chamada externa: sem ele, uma organização com milhares de contas deixaria a
 * requisição aberta por minutos e estouraria o tempo da rota. A resposta diz
 * quantos ainda faltam, então o operador clica de novo — e o worker diário
 * continua sendo o caminho normal, não este botão.
 */
const MAX_PROFILES_PER_CLICK = 120;

const RENEWAL_COLUMNS =
  'id, provider, token_expires_at, token_refreshed_at, token_refresh_attempted_at, token_refresh_error, token_refresh_failure_count';

type RenewalRow = MetaTokenProfile & { id: string };

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as { scope?: unknown; metaAppId?: unknown };
  // 'due' é o padrão e o que o worker faria. 'all' força tudo que a Meta aceita
  // renovar agora, para quando o operador quer zerar a idade da frota inteira.
  const scope = body.scope === 'all' ? 'all' : 'due';
  const metaAppId = typeof body.metaAppId === 'string' && body.metaAppId ? body.metaAppId : null;
  const organizationId = context.activeOrganization.id;
  const admin = createSupabaseAdminClient();
  const now = Date.now();

  // Ordenado pelo token mais antigo: quem está mais perto da borda dos 60 dias
  // é renovado primeiro, que é exatamente a ordem em que o risco aparece.
  let query = admin
    .from('instagram_profiles')
    .select(RENEWAL_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('provider', 'meta_official')
    .is('deleted_at', null)
    .order('token_refreshed_at', { ascending: true, nullsFirst: true })
    .order('id', { ascending: true })
    .limit(MAX_PROFILES_PER_CLICK * 4);

  if (metaAppId) query = query.eq('meta_app_id', metaAppId);

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: 'Não foi possível listar os perfis para renovar.' }, { status: 500 });
  }

  const rows = (data ?? []) as RenewalRow[];
  const eligible = rows.filter((row) => {
    const state = metaTokenRenewalState(row, now);
    return scope === 'all' ? state.canRefreshNow : state.due;
  });
  const batch = eligible.slice(0, MAX_PROFILES_PER_CLICK);

  if (batch.length === 0) {
    return NextResponse.json({
      ok: true,
      refreshed: 0,
      skipped: 0,
      failed: 0,
      needsReauthorization: 0,
      remaining: 0,
      message: scope === 'due'
        ? `Nenhum token passou de ${META_TOKEN_REFRESH_AFTER_DAYS} dias. Nada a renovar agora.`
        : 'Nenhum token está em condição de ser renovado agora.',
    });
  }

  const result = await refreshMetaProfileTokens(admin, {
    organizationId,
    profileIds: batch.map((row) => row.id),
    now,
  });

  return NextResponse.json({
    ok: true,
    refreshed: result.refreshed,
    skipped: result.skipped,
    failed: result.failed,
    needsReauthorization: result.needsReauthorization,
    remaining: Math.max(0, eligible.length - batch.length),
    failures: result.outcomes
      .filter((outcome) => outcome.status === 'failed')
      .slice(0, 10)
      .map((outcome) => ({ username: outcome.username, message: outcome.message })),
  });
}
