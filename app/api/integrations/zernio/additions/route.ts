import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) return NextResponse.json({ error: 'Sem permissão.' }, { status: 403 });

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from('zernio_connection_attempts')
    .select('id, correlation_id, status, worker_status, worker_attempt_count, worker_error_code, worker_error_stage, last_error_message, synced_count, diagnostic, created_at, callback_received_at, worker_completed_at, zernio_connection_id, zernio_connections(label)')
    .eq('organization_id', context.activeOrganization.id)
    .order('created_at', { ascending: false }).limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ additions: (data ?? []).map((row) => ({
    id: row.id,
    correlationId: row.correlation_id,
    status: row.worker_status,
    attemptStatus: row.status,
    attemptCount: row.worker_attempt_count,
    connectionId: row.zernio_connection_id,
    connectionLabel: Array.isArray(row.zernio_connections) ? row.zernio_connections[0]?.label ?? null : (row.zernio_connections as { label?: string } | null)?.label ?? null,
    syncedCount: row.synced_count,
    errorCode: row.worker_error_code,
    errorStage: row.worker_error_stage,
    errorMessage: row.last_error_message,
    results: Array.isArray((row.diagnostic as Record<string, unknown> | null)?.additionResults)
      ? (row.diagnostic as Record<string, unknown>).additionResults : [],
    createdAt: row.created_at,
    callbackReceivedAt: row.callback_received_at,
    completedAt: row.worker_completed_at,
  })) });
}
