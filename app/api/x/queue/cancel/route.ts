import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

export async function POST(request: Request) {
  const auth = await getTwitterRequestContext('operator'); if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => ({})) as { itemId?:unknown;programId?:unknown;profileId?:unknown;groupProfileIds?:unknown;reason?:unknown;idempotencyKey?:unknown };
  if (typeof body.reason !== 'string' || body.reason.trim().length < 4 || typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 8) return NextResponse.json({ error:'Cancelamento inválido.' },{ status:400 });
  const str=(value:unknown)=>typeof value==='string'?value:null;
  const group=Array.isArray(body.groupProfileIds)?body.groupProfileIds.filter((value):value is string=>typeof value==='string'):null;
  if(!str(body.itemId)&&!str(body.programId)&&!str(body.profileId)&&!group?.length)return NextResponse.json({error:'Informe item, programa, perfil ou grupo.'},{status:400});
  const {data,error}=await createSupabaseAdminClient().rpc('twitter_cancel_publication_scope',{p_organization_id:auth.context.activeOrganization.id,p_item_id:str(body.itemId),p_program_id:str(body.programId),p_profile_id:str(body.profileId),p_group_profile_ids:group,p_reason:body.reason.trim(),p_idempotency_key:body.idempotencyKey});
  if(error)return NextResponse.json({error:'Não foi possível cancelar a fila X.'},{status:409});return NextResponse.json(data);
}
