import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterCreatePrice, validateTwitterContent } from '@/lib/twitter/pricing';
import { isTwitterRolloutActive } from '@/lib/twitter/feature';
import { isTwitterWorkerAuthorized } from '@/lib/twitter/worker-auth';

type Claim = {
  item_id:string;organization_id:string;program_id:string;profile_id:string;connection_id:string;connection_epoch_id:string;
  content:string;weighted_characters:number;media_set_client_key:string|null;category:string;amount_micros:number;
  execute_at:string;dispatch_deadline_at:string;preparation_version:number;
};

async function inChunks<T>(values:T[],size:number,action:(value:T)=>Promise<void>){
  for(let index=0;index<values.length;index+=size)await Promise.all(values.slice(index,index+size).map(action));
}

export async function POST(request:Request){
  if(!isTwitterWorkerAuthorized(request,'preparation'))return NextResponse.json({error:'Não autorizado.'},{status:401});
  if(!isTwitterRolloutActive()||process.env.TWITTER_PREPARATION_WORKER_ENABLED!=='true')return NextResponse.json({disabled:true,claimed:0,ready:0,blocked:0});
  const body=await request.json().catch(()=>({})) as {workerId?:unknown;limit?:unknown};
  const workerId=typeof body.workerId==='string'?body.workerId.slice(0,160):'twitter-preparation';
  const limit=Math.min(500,Math.max(1,typeof body.limit==='number'?Math.trunc(body.limit):500));
  const admin=createSupabaseAdminClient();
  const expiration=await admin.rpc('twitter_expire_dispatch_deadlines',{p_limit:5000});
  if(expiration.error)return NextResponse.json({error:'Falha ao expirar janelas X.'},{status:500});
  const claimed=await admin.rpc('twitter_claim_preparation_items',{p_worker_id:workerId,p_limit:limit});
  if(claimed.error)return NextResponse.json({error:'Falha no claim de preparação X.'},{status:500});
  const items=(claimed.data??[]) as Claim[];
  if(!items.length)return NextResponse.json({claimed:0,ready:0,blocked:0,expired:expiration.data});

  const programIds=[...new Set(items.map(item=>item.program_id))];
  const epochIds=[...new Set(items.map(item=>item.connection_epoch_id))];
  const profileIds=[...new Set(items.map(item=>item.profile_id))];
  const [setsResult,epochsResult,profilesResult]=await Promise.all([
    admin.from('twitter_program_media_sets').select('id,program_id,client_key,media_kind').in('program_id',programIds),
    admin.from('twitter_profile_connection_epochs').select('id,profile_id,connection_id,zernio_account_id,ended_at').in('id',epochIds),
    admin.from('twitter_profiles').select('id,status,can_post,account_tier,current_epoch_id').in('id',profileIds).is('deleted_at',null),
  ]);
  if(setsResult.error||epochsResult.error||profilesResult.error)return NextResponse.json({error:'Falha ao materializar preparação X.'},{status:500});
  const sets=setsResult.data??[];const setIds=sets.map(set=>set.id);
  const linksResult=setIds.length?await admin.from('twitter_program_media_set_assets').select('media_set_id,asset_id,position').in('media_set_id',setIds).order('position'):{data:[],error:null};
  if(linksResult.error)return NextResponse.json({error:'Falha ao carregar vínculos de mídia X.'},{status:500});
  const links=linksResult.data??[];const assetIds=[...new Set(links.map(link=>link.asset_id))];
  const assetsResult=assetIds.length?await admin.from('twitter_media_assets').select('id,organization_id,storage_path,media_kind,status,sha256,deleted_at').in('id',assetIds):{data:[],error:null};
  if(assetsResult.error)return NextResponse.json({error:'Falha ao validar mídias X.'},{status:500});
  const epochById=new Map((epochsResult.data??[]).map(epoch=>[epoch.id,epoch]));
  const profileById=new Map((profilesResult.data??[]).map(profile=>[profile.id,profile]));
  const assetById=new Map((assetsResult.data??[]).map(asset=>[asset.id,asset]));
  let ready=0,blocked=0;
  await inChunks(items,20,async item=>{
    try{
      const epoch=epochById.get(item.connection_epoch_id),profile=profileById.get(item.profile_id);
      if(!epoch||epoch.ended_at||epoch.connection_id!==item.connection_id||!epoch.zernio_account_id)throw new Error('Epoch ou conta Zernio X inválida.');
      if(!profile||profile.status!=='active'||profile.can_post!==true||profile.current_epoch_id!==item.connection_epoch_id)throw new Error('Perfil X não está publicável.');
      const validation=validateTwitterContent(item.content,profile.account_tier);
      if(item.content&&(!validation.valid||validation.weightedCharacters!==Number(item.weighted_characters)))throw new Error('Snapshot de texto X inválido.');
      const price=getTwitterCreatePrice(item.content);
      if(price.category!==item.category||price.amountMicros!==Number(item.amount_micros))throw new Error('Snapshot financeiro X divergente.');
      const set=item.media_set_client_key?sets.find(value=>value.program_id===item.program_id&&value.client_key===item.media_set_client_key):null;
      if(item.media_set_client_key&&!set)throw new Error('Conjunto de mídia X ausente.');
      const manifest=(set?links.filter(link=>link.media_set_id===set.id):[]).map(link=>{
        const asset=assetById.get(link.asset_id);
        if(!asset||asset.organization_id!==item.organization_id||asset.status!=='ready'||asset.deleted_at||!/^[a-f0-9]{64}$/.test(asset.sha256??''))throw new Error('Mídia X indisponível ou sem checksum.');
        return{assetId:asset.id,storagePath:asset.storage_path,mediaKind:asset.media_kind,sha256:asset.sha256,position:link.position};
      });
      const payload={version:item.preparation_version,content:item.content,accountId:epoch.zernio_account_id,profileId:item.profile_id,connectionId:item.connection_id,connectionEpochId:item.connection_epoch_id,category:item.category,amountMicros:Number(item.amount_micros),executeAt:item.execute_at,dispatchDeadlineAt:item.dispatch_deadline_at,mediaKind:set?.media_kind??null};
      const completion=await admin.rpc('twitter_complete_preparation_item',{p_item_id:item.item_id,p_worker_id:workerId,p_ready:true,p_payload_snapshot:payload,p_media_manifest:manifest,p_error:null});
      if(completion.error)throw completion.error;ready+=1;
    }catch(error){
      blocked+=1;await admin.rpc('twitter_complete_preparation_item',{p_item_id:item.item_id,p_worker_id:workerId,p_ready:false,p_payload_snapshot:null,p_media_manifest:[],p_error:error instanceof Error?error.message:'Falha na preparação X.'});
    }
  });
  return NextResponse.json({claimed:items.length,ready,blocked,expired:expiration.data});
}
