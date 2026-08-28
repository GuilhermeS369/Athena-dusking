import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterWorkerAuthorized } from '@/lib/twitter/worker-auth';

export async function POST(request:Request){
  if(!isTwitterWorkerAuthorized(request,'publication'))return NextResponse.json({error:'Não autorizado.'},{status:401});
  const body=await request.json().catch(()=>({})) as {attemptId?:unknown;idempotencyKey?:unknown;fencingToken?:unknown};
  if(typeof body.attemptId!=='string'||typeof body.idempotencyKey!=='string'||typeof body.fencingToken!=='string')return NextResponse.json({error:'Início X V2 inválido.'},{status:400});
  const{data,error}=await createSupabaseAdminClient().rpc('twitter_start_external_attempt_v2',{p_attempt_id:body.attemptId,p_idempotency_key:body.idempotencyKey,p_fencing_token:body.fencingToken});
  return error?NextResponse.json({error:'Não foi possível marcar o início externo X.'},{status:409}):NextResponse.json(data);
}
