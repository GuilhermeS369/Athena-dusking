import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const auth = await getTwitterRequestContext();
  if ('response' in auth) return auth.response;
  const programId = new URL(request.url).searchParams.get('programId');
  if (!programId || !uuid.test(programId)) return NextResponse.json({ error:'Programa X inválido.' }, { status:400 });
  const { data, error } = await createSupabaseAdminClient().from('twitter_publication_items')
    .select('id,program_id,profile_id,execute_at,content,category,amount_micros,status,attempt_count,next_attempt_at')
    .eq('organization_id', auth.context.activeOrganization.id).eq('program_id', programId).order('execute_at').limit(500);
  if (error) return NextResponse.json({ error:'Falha ao carregar fila X.' }, { status:500 });
  return NextResponse.json({ items:data ?? [], limit:500 });
}
