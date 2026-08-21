import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

type RouteContext = { params: Promise<{ jobId: string }> };

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: RouteContext) {
  const { jobId } = await params;
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });

  const supabase = await createSupabaseServerClient();
  const { data: job, error } = await supabase
    .from('profile_analytics_refresh_jobs')
    .select('id, trigger, status, total_count, processed_count, synced_count, partial_count, no_data_count, skipped_count, failed_count, retry_pending_count, dead_letter_count, last_error_message, created_at, started_at, finished_at, updated_at')
    .eq('id', jobId)
    .eq('organization_id', context.activeOrganization.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: 'Não foi possível carregar o status da atualização.' }, { status: 500 });
  if (!job) return NextResponse.json({ error: 'Atualização de métricas não encontrada.' }, { status: 404 });
  return NextResponse.json({ job }, { headers: { 'Cache-Control': 'no-store' } });
}
