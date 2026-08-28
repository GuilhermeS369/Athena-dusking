import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const auth = await getTwitterRequestContext();
  if ('response' in auth) return auth.response;
  const url=new URL(request.url);const programId = url.searchParams.get('programId');
  if (!programId) {
    const { data, error } = await createSupabaseAdminClient().rpc('twitter_queue_operational_summary', { p_organization_id: auth.context.activeOrganization.id });
    return error ? NextResponse.json({ error: 'Falha ao atualizar o resumo da fila X.' }, { status: 500 }) : NextResponse.json({ summary: data }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }
  if (!uuid.test(programId)) return NextResponse.json({ error:'Programa X inválido.' }, { status:400 });
  let query=createSupabaseAdminClient().from('twitter_publication_items')
    .select('id,program_id,profile_id,execute_at,content,category,amount_micros,status,attempt_count,next_attempt_at')
    .eq('organization_id', auth.context.activeOrganization.id).eq('program_id', programId).order('execute_at').order('id').limit(201);
  const cursor=url.searchParams.get('cursor');if(cursor){try{const value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'))as{executeAt:string;id:string};if(!value.executeAt||!uuid.test(value.id))throw new Error();query=query.or(`execute_at.gt.${value.executeAt},and(execute_at.eq.${value.executeAt},id.gt.${value.id})`);}catch{return NextResponse.json({error:'Cursor de fila inválido.'},{status:400});}}
  const { data, error } = await query;
  if (error) return NextResponse.json({ error:'Falha ao carregar fila X.' }, { status:500 });
  const rows=data??[];const items=rows.slice(0,200);const last=items.at(-1);return NextResponse.json({items,hasMore:rows.length>200,nextCursor:rows.length>200&&last?Buffer.from(JSON.stringify({executeAt:last.execute_at,id:last.id})).toString('base64url'):null});
}
