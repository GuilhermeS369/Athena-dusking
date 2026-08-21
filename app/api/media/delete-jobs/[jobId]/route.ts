import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

type RouteContext = { params: Promise<{ jobId: string }> };

type DeletionJobItemDetail = {
  media_asset_id: string;
  status: 'deleted' | 'failed';
  error_message: string | null;
  processed_at: string | null;
  media_assets: { original_name: string | null }[] | { original_name: string | null } | null;
};

function mediaName(row: DeletionJobItemDetail) {
  const media = Array.isArray(row.media_assets) ? row.media_assets[0] : row.media_assets;
  return media?.original_name ?? null;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { jobId } = await params;
  const context = await getOrganizationContext();

  if (!context.user || !context.activeOrganization) {
    return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: job, error } = await supabase
    .from('media_deletion_jobs')
    .select('id, status, total_count, processed_count, deleted_count, affected_item_count, failed_count, last_error_message, created_at, started_at, finished_at, updated_at')
    .eq('id', jobId)
    .eq('organization_id', context.activeOrganization.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: 'Não foi possível carregar o status da exclusão.' }, { status: 500 });
  if (!job) return NextResponse.json({ error: 'Fila de exclusão não encontrada.' }, { status: 404 });

  const { data: detailRows, error: detailError } = await supabase
    .from('media_deletion_job_items')
    .select('media_asset_id, status, error_message, processed_at, media_assets(original_name)')
    .eq('job_id', job.id)
    .eq('organization_id', context.activeOrganization.id)
    .in('status', ['failed', 'deleted'])
    .not('error_message', 'is', null)
    .order('processed_at', { ascending: false, nullsFirst: false })
    .limit(12);

  if (detailError) {
    return NextResponse.json({ error: 'Não foi possível carregar os detalhes das falhas da exclusão.' }, { status: 500 });
  }

  const details = ((detailRows ?? []) as DeletionJobItemDetail[]).map((row) => ({
    mediaAssetId: row.media_asset_id,
    originalName: mediaName(row),
    status: row.status,
    message: row.error_message ?? 'Falha sem detalhe registrada.',
    processedAt: row.processed_at,
  }));

  return NextResponse.json({
    job: {
      ...job,
      failure_details: details.filter((row) => row.status === 'failed'),
      warning_details: details.filter((row) => row.status === 'deleted'),
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}

