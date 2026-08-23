import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterModuleEnabled } from '@/lib/twitter/feature';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request:Request){
  const auth=await getTwitterRequestContext('admin');if('response'in auth)return auth.response;
  const body=await request.json().catch(()=>({})) as {identityId?:unknown;destinationOrganizationId?:unknown;reason?:unknown;idempotencyKey?:unknown};
  if(typeof body.identityId!=='string'||!uuid.test(body.identityId)||typeof body.destinationOrganizationId!=='string'||!uuid.test(body.destinationOrganizationId)||typeof body.reason!=='string'||body.reason.trim().length<5||body.reason.trim().length>1000||typeof body.idempotencyKey!=='string'||body.idempotencyKey.length<8||body.idempotencyKey.length>255)return NextResponse.json({error:'Transferência inválida.'},{status:400});
  const source=auth.context.activeOrganization;
  const destination=auth.context.organizations.find((organization)=>organization.id===body.destinationOrganizationId&&organization.role==='admin');
  if(!destination||destination.id===source.id||!isTwitterModuleEnabled(destination.id))return NextResponse.json({error:'Organização de destino indisponível para o módulo X.'},{status:403});
  const admin=createSupabaseAdminClient();
  const{data:identity,error:identityError}=await admin.from('twitter_global_identities').select('id').eq('id',body.identityId).eq('current_organization_id',source.id).maybeSingle();
  if(identityError||!identity)return NextResponse.json({error:'Identidade X indisponível para transferência.'},{status:404});
  const{data,error}=await admin.rpc('twitter_transfer_identity_organization_v2',{p_identity_id:identity.id,p_from_organization_id:source.id,p_to_organization_id:destination.id,p_reason:body.reason.trim(),p_actor_user_id:auth.context.user.id,p_actor_email:auth.context.user.email??'admin-sem-email@athena.local',p_idempotency_key:body.idempotencyKey});
  if(error){const message=error.message.includes('reservas')?'Resolva todas as reservas antes da transferência.':error.message.includes('conexão ativa')?'Remova a conexão X antes da transferência.':'Não foi possível transferir a identidade X.';return NextResponse.json({error:message},{status:409});}
  return NextResponse.json(data);
}
