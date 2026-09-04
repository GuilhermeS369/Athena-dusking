import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Estado de renovação dos perfis visíveis na tela.
 *
 * Existe porque o catálogo de /perfis é paginado e filtrado pelo cliente: um
 * valor calculado só no servidor vale para a primeira pintura e fica obsoleto
 * na primeira busca — o botão apareceria em alguns perfis e sumiria em outros
 * sem motivo aparente. A alternativa seria devolver estas colunas pela RPC do
 * catálogo, o que significaria recriar uma função grande e quente por causa de
 * quatro campos.
 *
 * O teto de ids é o tamanho de uma página do catálogo com folga: isto responde
 * sobre o que está na tela, nunca sobre a organização inteira.
 */
const MAX_PROFILE_IDS = 200;

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });

  const body = await request.json().catch(() => ({})) as { profileIds?: unknown };
  const profileIds = Array.isArray(body.profileIds)
    ? body.profileIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, MAX_PROFILE_IDS)
    : [];

  if (profileIds.length === 0) return NextResponse.json({ states: [] });

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('instagram_profiles_safe')
    .select('id, provider, token_expires_at, token_refreshed_at, token_refresh_attempted_at, token_refresh_error, token_refresh_failure_count')
    .eq('organization_id', context.activeOrganization.id)
    .eq('provider', 'meta_official')
    .in('id', profileIds)
    // Os ids já vêm cortados em MAX_PROFILE_IDS, então este teto não corta nada
    // de verdade — ele existe para que o limite fique escrito na consulta, e
    // não só na variável acima.
    .limit(MAX_PROFILE_IDS);

  if (error) return NextResponse.json({ error: 'Não foi possível ler o estado dos tokens.' }, { status: 500 });
  return NextResponse.json({ states: data ?? [] });
}
