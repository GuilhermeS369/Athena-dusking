import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Perfis que receberam da Meta o erro 9 "User is performing too many actions"
// (migration 438). O publicador cancela os reels do perfil e grava o aviso; esta
// rota só lista e limpa o aviso — limpar não recria nem republica nada.

const MAX_CLEAR_IDS = 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listBlocks(organizationId: string) {
  const supabase = await createSupabaseServerClient();
  return supabase.rpc('get_meta_profile_action_blocks', { p_organization_id: organizationId });
}

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const { data, error } = await listBlocks(context.activeOrganization.id);
  if (error) {
    console.error('Não foi possível consultar os perfis com ações limitadas pela Meta.', error);
    return NextResponse.json({ error: 'Não foi possível consultar os perfis com ações limitadas.' }, { status: 500 });
  }
  return NextResponse.json(data ?? { snapshotAt: null, blocks: [] }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  let blockIds: string[];
  try {
    const body = await request.json() as { blockIds?: unknown };
    blockIds = Array.isArray(body.blockIds) ? [...new Set(body.blockIds)].filter((id): id is string => typeof id === 'string' && UUID_PATTERN.test(id)) : [];
  } catch {
    return NextResponse.json({ error: 'Corpo da requisição inválido.' }, { status: 400 });
  }
  if (blockIds.length === 0 || blockIds.length > MAX_CLEAR_IDS) {
    return NextResponse.json({ error: 'Selecione de 1 a 1.000 avisos.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: cleared, error } = await supabase.rpc('clear_meta_profile_action_blocks', { p_block_ids: blockIds });
  if (error) {
    const status = error.code === '42501' ? 403 : error.code === '22023' ? 400 : 500;
    if (status === 500) console.error('Não foi possível limpar os avisos de ações limitadas.', error);
    return NextResponse.json({ error: status === 403 ? 'Ação não permitida.' : 'Não foi possível limpar os avisos.' }, { status });
  }

  const { data, error: listError } = await listBlocks(context.activeOrganization.id);
  if (listError) return NextResponse.json({ cleared, snapshotAt: null, blocks: [] });
  return NextResponse.json({ cleared, ...(data ?? { snapshotAt: null, blocks: [] }) });
}
