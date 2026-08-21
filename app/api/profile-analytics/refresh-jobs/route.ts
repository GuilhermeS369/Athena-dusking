import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

type CreatedRefreshJob = { job_id: string; status: string; total_count: number; reused: boolean; reason: string };

function normalizeTrigger(value: unknown) {
  return value === 'page_view' || value === 'manual' ? value : 'page_view';
}

function staleMinutesForTrigger(trigger: string) {
  return trigger === 'manual' ? 5 : 60;
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });

  const body = await request.json().catch(() => ({})) as { trigger?: unknown; profileIds?: unknown; force?: unknown };
  const trigger = normalizeTrigger(body.trigger);
  if (trigger === 'manual' && !['admin', 'operator'].includes(context.activeOrganization.role)) {
    return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });
  }

  const profileIds = Array.isArray(body.profileIds)
    ? body.profileIds.filter((value): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)).slice(0, 500)
    : null;
  const forceSelectedProfiles = body.force === true && trigger === 'manual' && Boolean(profileIds?.length);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('create_profile_analytics_refresh_job', {
    p_organization_id: context.activeOrganization.id,
    p_trigger: trigger,
    p_profile_ids: profileIds,
    p_stale_after_minutes: forceSelectedProfiles ? 5 : staleMinutesForTrigger(trigger),
    p_manual_cooldown_seconds: forceSelectedProfiles ? 30 : 300,
    // Proteção server-side: force nunca é aceito sem uma seleção explícita.
    // Isso impede clientes antigos ou requests manuais de criarem um refresh
    // forçado de todos os perfis da organização.
    p_force: forceSelectedProfiles,
  });

  if (error) return NextResponse.json({ error: 'Não foi possível agendar a atualização de métricas.' }, { status: 500 });
  const job = ((data ?? []) as CreatedRefreshJob[])[0] ?? null;
  return NextResponse.json({ job }, { headers: { 'Cache-Control': 'no-store' } });
}
