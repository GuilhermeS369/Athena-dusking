import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterRolloutActive } from '@/lib/twitter/feature';
import { isTwitterWorkerAuthorized } from '@/lib/twitter/worker-auth';

type ManifestItem={storagePath:string;mediaKind:'image'|'gif'|'video';position:number};
type Claim={item_id:string;attempt_id:string;organization_id:string;profile_id:string;connection_id:string;content:string;execute_at:string;dispatch_deadline_at:string;amount_micros:number;payload_snapshot:Record<string,unknown>;media_manifest:ManifestItem[];fencing_token:string};

export async function POST(request:Request){
  if(!isTwitterWorkerAuthorized(request,'publication'))return NextResponse.json({error:'Não autorizado.'},{status:401});
  if(!isTwitterRolloutActive()||process.env.TWITTER_PUBLICATION_WORKER_ENABLED!=='true')return NextResponse.json({workerId:null,items:[],disabled:true});
  const body=await request.json().catch(()=>({})) as {workerId?:unknown;limit?:unknown;plane?:unknown};
  const workerId=typeof body.workerId==='string'?body.workerId.slice(0,160):'twitter-worker';
  const limit=Math.min(50,Math.max(1,typeof body.limit==='number'?Math.trunc(body.limit):50));
  const plane=body.plane==='fallback'?'fallback':'vps';
  const admin=createSupabaseAdminClient();
  const fence=await admin.rpc('twitter_acquire_dispatch_fence',{p_plane:plane,p_worker_id:workerId,p_lease_seconds:30});
  if(fence.error)return NextResponse.json({error:'Falha ao adquirir fencing X.'},{status:500});
  const fenceValue=fence.data as {allowed?:boolean;fencingToken?:string;ownerPlane?:string;leaseUntil?:string;epoch?:number};
  if(fenceValue.allowed!==true||!fenceValue.fencingToken)return NextResponse.json({workerId,items:[],fenced:true,ownerPlane:fenceValue.ownerPlane,leaseUntil:fenceValue.leaseUntil});
  const expiration=await admin.rpc('twitter_expire_dispatch_deadlines',{p_limit:5000});
  if(expiration.error)return NextResponse.json({error:'Falha ao expirar janelas X.'},{status:500});
  const mode=process.env.TWITTER_PUBLICATION_MODE==='live'?'live':'shadow';
  if(mode==='shadow'){
    const preview=await admin.rpc('twitter_preview_publication_candidates_v2',{p_limit:limit});
    if(preview.error)return NextResponse.json({error:'Falha no preview shadow X V2.'},{status:500});
    const candidates=preview.data??[];
    return NextResponse.json({workerId,items:[],mode,fencingToken:fenceValue.fencingToken,expired:expiration.data,shadowCandidates:candidates,candidateCount:candidates.length});
  }
  const claim=await admin.rpc('twitter_claim_publication_items_v2',{p_worker_id:workerId,p_limit:limit,p_fencing_token:fenceValue.fencingToken});
  if(claim.error)return NextResponse.json({error:'Falha no claim X V2.'},{status:500});
  const rows=(claim.data??[]) as Claim[];
  if(!rows.length)return NextResponse.json({workerId,items:rows,mode,fencingToken:fenceValue.fencingToken,expired:expiration.data});

  const connectionIds=[...new Set(rows.map(item=>item.connection_id))];
  const secrets=await admin.from('twitter_connection_secrets').select('connection_id,encrypted_api_key').in('connection_id',connectionIds);
  if(secrets.error)return NextResponse.json({error:'Falha ao carregar credenciais X em lote.'},{status:500});
  const secretByConnection=new Map((secrets.data??[]).map(value=>[value.connection_id,value.encrypted_api_key]));
  const paths=[...new Set(rows.flatMap(item=>Array.isArray(item.media_manifest)?item.media_manifest.map(media=>media.storagePath):[]))];
  const signed=paths.length?await admin.storage.from('twitter-media').createSignedUrls(paths,3600):{data:[],error:null};
  if(signed.error)return NextResponse.json({error:'Não foi possível assinar mídias X em lote.'},{status:500});
  const signedByPath=new Map((signed.data??[]).map(value=>[value.path,value.signedUrl]));
  try{
    const items=rows.map(item=>{
      const encryptedApiKey=secretByConnection.get(item.connection_id);const accountId=item.payload_snapshot?.accountId;
      if(!encryptedApiKey||typeof accountId!=='string')throw new Error('Claim X preparado está incompleto.');
      const media=(item.media_manifest??[]).sort((a,b)=>a.position-b.position).map(asset=>{const url=signedByPath.get(asset.storagePath);if(!url)throw new Error('URL assinada X ausente.');return{type:asset.mediaKind,url};});
      return{...item,account_id:accountId,encrypted_api_key:encryptedApiKey,media};
    });
    return NextResponse.json({workerId,items,mode,fencingToken:fenceValue.fencingToken,expired:expiration.data});
  }catch{return NextResponse.json({error:'Claim X preparado está incompleto.'},{status:500});}
}
