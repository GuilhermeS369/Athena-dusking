import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { chunkIds } from '@/lib/supabase/chunk';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Teto por requisição. Espelha o da rota de horários ocupados: o seletor nunca
 * pede mais do que os membros de um destino, e este número existe para recusar
 * um corpo absurdo, não para cortar uso legítimo.
 */
const MAX_PROFILE_IDS = 2_000;

/**
 * Blocos de 250 porque foi o tamanho medido. Em 06/09/2026, na organização
 * Pomodoro (1.526 perfis, 536.592 linhas na tabela quente), um bloco de 250
 * perfis custou ~1 s; a organização inteira estourava o `statement_timeout` de
 * 8 s. O cliente também fatia antes de chamar, para a tela ir se preenchendo —
 * este laço é a rede de segurança para quem mandar um destino grande de uma vez.
 */
const PROFILE_CHUNK_SIZE = 250;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SummaryRow = {
  profile_id: string;
  scheduled_post_count: number | null;
  scheduled_counts: unknown;
  published_counts: unknown;
  scheduled_by_time: unknown;
  scheduled_by_format_and_time: unknown;
};

/**
 * Contagens agendadas/publicadas dos perfis de um destino do compositor.
 *
 * Existe pelo mesmo motivo da rota irmã de horários ocupados, e resolve a falha
 * que ela deixou passar: as contagens continuaram sendo lidas para a
 * organização inteira no SSR de /postagem, e em 06/09/2026 passaram a estourar
 * o tempo limite do banco. A página engole esse erro de propósito — para uma
 * instabilidade de leitura não virar 500 — então a falha aparecia como "todos
 * os perfis com 0 agendadas", com 87 mil publicações na fila.
 *
 * É POST pelo tamanho da lista: os 623 UUIDs do maior grupo em produção passam
 * de 23 KB de query string num GET.
 */
export async function POST(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Corpo da requisição inválido.' }, { status: 400 });
  }

  const rawIds = (body as { profileIds?: unknown } | null)?.profileIds;
  if (!Array.isArray(rawIds)) {
    return NextResponse.json({ error: 'Informe profileIds como lista.' }, { status: 400 });
  }
  const profileIds = [...new Set(rawIds.filter((id): id is string => typeof id === 'string' && UUID_PATTERN.test(id)))];
  if (profileIds.length !== new Set(rawIds).size) {
    return NextResponse.json({ error: 'profileIds contém identificadores inválidos.' }, { status: 400 });
  }
  if (profileIds.length > MAX_PROFILE_IDS) {
    return NextResponse.json({ error: `Máximo de ${MAX_PROFILE_IDS} perfis por consulta.` }, { status: 400 });
  }
  if (!profileIds.length) {
    return NextResponse.json({ summaries: {} }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const supabase = await createSupabaseServerClient();
  const summaries: Record<string, Omit<SummaryRow, 'profile_id'>> = {};

  // Em série, como na rota de horários: disparar todos os blocos de uma vez só
  // troca tempo de resposta por pressão no banco.
  for (const chunk of chunkIds(profileIds, PROFILE_CHUNK_SIZE)) {
    const { data, error } = await supabase.rpc('get_posting_composer_profile_summaries', {
      p_organization_id: context.activeOrganization.id,
      p_profile_ids: chunk,
      p_slot_horizon_days: 90,
    });
    if (error) {
      console.error('Falha ao carregar contagens do compositor', {
        organizationId: context.activeOrganization.id,
        profiles: chunk.length,
        code: error.code,
        message: error.message,
      });
      return NextResponse.json({ error: 'Não foi possível carregar as contagens deste destino.' }, { status: 500 });
    }
    for (const row of (data ?? []) as SummaryRow[]) {
      const { profile_id: profileId, ...counts } = row;
      summaries[profileId] = counts;
    }
  }

  return NextResponse.json({ summaries }, { headers: { 'Cache-Control': 'no-store' } });
}
