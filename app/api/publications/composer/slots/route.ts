import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { chunkIds } from '@/lib/supabase/chunk';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { emptyScheduledSlotsByFormat, type ComposerFormat, type ScheduledSlotsByFormat } from '@/lib/publications/composer';

export const dynamic = 'force-dynamic';

const composerFormats: ComposerFormat[] = ['reel', 'story', 'image', 'carousel'];

/**
 * Teto por requisição. O maior grupo em produção hoje tem 623 perfis, e o
 * seletor de destino nunca pede mais do que os membros de um grupo — este
 * número existe para recusar um corpo absurdo, não para cortar uso legítimo.
 */
const MAX_PROFILE_IDS = 2_000;

/**
 * Menor que o teto de 1.000 perfis da própria RPC. Cada bloco devolve uma linha
 * por perfil, então nenhuma resposta chega perto do max_rows do PostgREST e não
 * há paginação por `.range()` aqui.
 */
const PROFILE_CHUNK_SIZE = 250;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SlotRow = { profile_id: string; scheduled_execute_ats_by_format: unknown };

function slotsFromJson(value: unknown): ScheduledSlotsByFormat {
  const slots = emptyScheduledSlotsByFormat();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return slots;
  const record = value as Record<string, unknown>;
  for (const format of composerFormats) {
    const list = record[format];
    slots[format] = Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  }
  return slots;
}

/**
 * Horários já ocupados dos perfis de um destino do compositor de /postagem.
 *
 * Existe porque estes arrays eram 89% das props que a página mandava para o
 * navegador — 13,8 MiB para os 1.401 perfis da organização Pomodoro — e só são
 * lidos depois que alguém escolhe um perfil ou grupo, para detectar conflito de
 * minuto e projetar recorrências. Agora vêm sob demanda, só para o destino
 * escolhido.
 *
 * É POST por causa do tamanho da lista: 623 UUIDs (o maior grupo em produção)
 * passam de 23 KB de query string num GET.
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
    return NextResponse.json({ slots: {} }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const supabase = await createSupabaseServerClient();
  const slots: Record<string, ScheduledSlotsByFormat> = {};

  // Blocos em série: um grupo grande já custa uma varredura por bloco, e
  // disparar todos de uma vez só troca o tempo de resposta por pressão no banco.
  for (const chunk of chunkIds(profileIds, PROFILE_CHUNK_SIZE)) {
    const { data, error } = await supabase.rpc('get_posting_composer_profile_slots', {
      p_organization_id: context.activeOrganization.id,
      p_profile_ids: chunk,
      p_slot_horizon_days: 90,
    });
    if (error) {
      console.error('Falha ao carregar horários ocupados do compositor', { organizationId: context.activeOrganization.id, profiles: chunk.length, message: error.message });
      return NextResponse.json({ error: 'Não foi possível carregar os horários já ocupados.' }, { status: 500 });
    }
    for (const row of (data ?? []) as SlotRow[]) {
      slots[row.profile_id] = slotsFromJson(row.scheduled_execute_ats_by_format);
    }
  }

  return NextResponse.json({ slots }, { headers: { 'Cache-Control': 'no-store' } });
}
