import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });

  const supabase = createSupabaseAdminClient();
  const { data: batch, error } = await supabase
    .from('zernio_sync_batches')
    .select('id')
    .eq('organization_id', context.activeOrganization.id)
    .eq('status', 'processing')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ batchId: batch?.id ?? null });
}
