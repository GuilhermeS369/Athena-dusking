import { NextResponse } from 'next/server';

import { summarizeBulkPlanAttention, type BulkPlanAttentionChunk } from '@/lib/bulk-plan-attention';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const maximumLimit = 30;

// Chunks só interessam a esta rota para montar o aviso de atenção, e
// summarizeBulkPlanAttention só olha chunk em falha, cancelado ou pausado.
// Antes a consulta embutia TODOS os chunks de cada plano — com os 20 planos mais
// recentes em produção isso dava 3.621 linhas por chamada, a cada ciclo de
// polling de cada aba aberta. Buscar apenas os chunks problemáticos derruba isso
// para quase nada, e é o que torna seguro atualizar o painel ao vivo.
const attentionChunkStatuses = ['failed', 'cancelled', 'paused'];
const attentionChunkLimit = 200;

function listLimit(value: string | null) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximumLimit) : 12;
}

export async function GET(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('bulk_publication_plans')
    .select('id, batch_id, name, status, format, interval_minutes, profile_count, media_count, slots_per_profile, expected_publications, generated_publications, suspended_publications, ignored_publications, failed_publications, expected_chunks, created_by_email, created_at, updated_at, bulk_publication_plan_profiles(id, first_execute_at, last_execute_at)')
    .eq('organization_id', context.activeOrganization.id)
    // created_at, e não updated_at: o worker de geração bumpa updated_at em planos
    // antigos a cada atualização de contador, o que empurrava o lote recém-criado
    // para baixo e, com o limite da lista, para fora dela. O índice
    // (organization_id, status, created_at desc) já existe desde a migration 084.
    .order('created_at', { ascending: false })
    .limit(listLimit(new URL(request.url).searchParams.get('limit')));

  if (error) {
    console.error('Não foi possível listar programações em massa.', error);
    return NextResponse.json({ error: 'Não foi possível carregar as programações em massa.' }, { status: 500 });
  }

  const planRows = data ?? [];
  const attentionByPlan = new Map<string, BulkPlanAttentionChunk[]>();
  if (planRows.length) {
    const { data: chunkRows, error: chunkError } = await supabase
      .from('bulk_publication_generation_chunks')
      .select('plan_id, profile_id, status, slot_count, generated_items, ignored_items, failed_items, last_error_message, instagram_profiles(username, status, deleted_at)')
      .in('plan_id', planRows.map((plan) => plan.id))
      .in('status', attentionChunkStatuses)
      .limit(attentionChunkLimit);

    // Falhar ao carregar os chunks de atenção não pode derrubar o painel inteiro:
    // sem eles os planos continuam aparecendo, apenas sem o aviso detalhado.
    if (chunkError) {
      console.error('Não foi possível carregar os chunks em atenção.', chunkError);
    } else {
      for (const chunk of chunkRows ?? []) {
        const list = attentionByPlan.get(chunk.plan_id) ?? [];
        list.push(chunk as unknown as BulkPlanAttentionChunk);
        attentionByPlan.set(chunk.plan_id, list);
      }
    }
  }

  const plans = planRows.map((plan) => {
    const profiles = plan.bulk_publication_plan_profiles ?? [];
    const firstExecuteAt = profiles.reduce<string | null>((earliest, profile) => !earliest || profile.first_execute_at < earliest ? profile.first_execute_at : earliest, null);
    const lastExecuteAt = profiles.reduce<string | null>((latest, profile) => !latest || profile.last_execute_at > latest ? profile.last_execute_at : latest, null);
    return {
      planId: plan.id,
      batchId: plan.batch_id,
      name: plan.name,
      status: plan.status,
      format: plan.format,
      profileCount: String(plan.profile_count),
      mediaCount: String(plan.media_count),
      slotsPerProfile: String(plan.slots_per_profile),
      expectedPublications: String(plan.expected_publications),
      generatedPublications: String(plan.generated_publications),
      suspendedPublications: String(plan.suspended_publications),
      ignoredPublications: String(plan.ignored_publications),
      failedPublications: String(plan.failed_publications),
      expectedChunks: String(plan.expected_chunks),
      attention: summarizeBulkPlanAttention(attentionByPlan.get(plan.id) ?? [], plan.status),
      firstExecuteAt,
      lastExecuteAt,
      createdAt: plan.created_at,
      updatedAt: plan.updated_at,
      createdByEmail: plan.created_by_email,
    };
  });

  return NextResponse.json({ plans }, { headers: { 'Cache-Control': 'no-store' } });
}
