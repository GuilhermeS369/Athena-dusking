import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  const { batchId } = await params;
  const supabase = createSupabaseAdminClient();
  const { data: batch, error } = await supabase
    .from('zernio_sync_batches')
    .select('id, status, total_connections, synced_count, conflict_count, failure_count, created_at, completed_at, zernio_sync_batch_items(status)')
    .eq('id', batchId)
    .eq('organization_id', context.activeOrganization.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!batch) return NextResponse.json({ error: 'Lote não encontrado.' }, { status: 404 });
  const items = (batch.zernio_sync_batch_items ?? []) as Array<{ status: string }>;
  return NextResponse.json({
    batch: {
      id: batch.id,
      status: batch.status,
      totalConnections: batch.total_connections,
      synced: batch.synced_count,
      conflicts: batch.conflict_count,
      failures: batch.failure_count,
      processedConnections: items.filter((item) => ['completed', 'failed'].includes(item.status)).length,
      processingConnections: items.filter((item) => item.status === 'processing').length,
      createdAt: batch.created_at,
      completedAt: batch.completed_at,
    },
  });
}
