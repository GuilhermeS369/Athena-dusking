import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const managerRoles = new Set(['admin', 'operator']);
const batchKinds = new Set(['common', 'reprocessed']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

const columns = 'id, group_id, happened_on, media_count, batch_kind, note, created_at';

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json(body, { ...init, headers });
}

/**
 * Marcos de troca de mídia.
 *
 * São o eixo X do acompanhamento: sem eles o "antes/depois" não tem referência,
 * e o pico do grupo (que decide se o Filtro 2 opina) não tem de onde ser
 * recontado. A análise de 31/08 registrou os dois como faltando no banco.
 */
export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return noStoreJson({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const url = new URL(request.url);
  const groupId = url.searchParams.get('groupId');
  if (groupId && !uuidPattern.test(groupId)) {
    return noStoreJson({ error: 'Grupo inválido.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('recovery_media_milestones')
    .select(columns)
    .eq('organization_id', context.activeOrganization.id)
    .order('happened_on', { ascending: false })
    .order('id', { ascending: false })
    .limit(200);
  if (groupId) query = query.eq('group_id', groupId);

  const { data, error } = await query;
  if (error) return noStoreJson({ error: error.message }, { status: 500 });
  return noStoreJson({ milestones: data ?? [] });
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  const role = context.organizations.find(
    (organization) => organization.id === context.activeOrganization?.id,
  )?.role;
  if (!context.user || !context.activeOrganization) {
    return noStoreJson({ error: 'Autenticação necessária.' }, { status: 401 });
  }
  if (!role || !managerRoles.has(role)) {
    return noStoreJson({ error: 'Ação não permitida.' }, { status: 403 });
  }

  let body: {
    groupId?: unknown;
    happenedOn?: unknown;
    mediaCount?: unknown;
    batchKind?: unknown;
    note?: unknown;
  };
  try {
    body = await request.json() as typeof body;
  } catch {
    return noStoreJson({ error: 'Requisição inválida.' }, { status: 400 });
  }

  const groupId = typeof body.groupId === 'string' ? body.groupId : '';
  if (!uuidPattern.test(groupId)) {
    return noStoreJson({ error: 'Informe o grupo.' }, { status: 400 });
  }
  const happenedOn = typeof body.happenedOn === 'string' ? body.happenedOn : '';
  if (!isoDate.test(happenedOn) || Number.isNaN(Date.parse(happenedOn))) {
    return noStoreJson({ error: 'Informe a data da troca.' }, { status: 400 });
  }
  const batchKind = typeof body.batchKind === 'string' ? body.batchKind : '';
  if (!batchKinds.has(batchKind)) {
    return noStoreJson({ error: 'A leva é comum ou reprocessada.' }, { status: 400 });
  }
  const mediaCount = Number(body.mediaCount ?? 0);
  if (!Number.isInteger(mediaCount) || mediaCount < 0 || mediaCount > 100000) {
    return noStoreJson({ error: 'Quantidade de mídias inválida.' }, { status: 400 });
  }
  const note = typeof body.note === 'string' && body.note.trim().length
    ? body.note.trim().slice(0, 500)
    : null;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('recovery_media_milestones')
    .insert({
      organization_id: context.activeOrganization.id,
      group_id: groupId,
      happened_on: happenedOn,
      media_count: mediaCount,
      batch_kind: batchKind,
      note,
      created_by: context.user.id,
    })
    .select(columns)
    .single();
  if (error) return noStoreJson({ error: error.message }, { status: 400 });
  return noStoreJson({ milestone: data }, { status: 201 });
}
