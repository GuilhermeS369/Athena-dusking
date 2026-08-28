import { decryptToken } from '@/lib/security/token-crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { provisionTwitterZernioConnection } from './zernio-connections';
import { forEachWithConcurrency, twitterZernioImportConcurrency } from './zernio-import-concurrency';

type Batch = { id:string;organization_id:string;created_by:string;status:string };
type Item = {
  id:string;line_number:number;label:string;encrypted_api_key:string;
  status:string;attempts:number;initial_grant_micros_snapshot:number|string;
  twitter_slot_limit_snapshot:number;twitter_connection_id:string|null;
};

export async function processTwitterZernioImportBatch(batchId:string,organizationName:string){
  const admin=createSupabaseAdminClient();
  const{data:batch,error:batchError}=await admin.from('twitter_connection_import_batches')
    .select('id,organization_id,created_by,status').eq('id',batchId).maybeSingle();
  if(batchError||!batch)throw new Error('Lote Zernio X não encontrado.');
  const{data:claimed,error:claimError}=await admin.rpc('twitter_claim_connection_import_batch',{p_batch_id:batchId});
  if(claimError)throw new Error('Não foi possível adquirir a fila de importação Zernio X.');
  if(!claimed)return{status:'waiting' as const};
  const typed=batch as Batch;
  await admin.from('twitter_connection_import_items').update({
    status:'failed',completed_at:new Date().toISOString(),
    last_error_message:'Processamento anterior expirou antes de concluir; a linha pode ser retomada.',
  }).eq('batch_id',batchId).eq('status','processing')
    .lt('processing_started_at',new Date(Date.now()-15*60_000).toISOString());
  const{data:items,error:itemsError}=await admin.from('twitter_connection_import_items')
    .select('id,line_number,label,encrypted_api_key,status,attempts,initial_grant_micros_snapshot,twitter_slot_limit_snapshot,twitter_connection_id')
    .eq('batch_id',batchId).in('status',['queued','failed']).order('line_number');
  if(itemsError)throw new Error('Não foi possível carregar as linhas do lote Zernio X.');

  await forEachWithConcurrency((items??[])as Item[],twitterZernioImportConcurrency(),async(item)=>{
    const{data:itemClaim}=await admin.from('twitter_connection_import_items').update({
      status:'processing',attempts:item.attempts+1,processing_started_at:new Date().toISOString(),
      completed_at:null,last_error_message:null,
    }).eq('id',item.id).in('status',['queued','failed']).select('id').maybeSingle();
    if(!itemClaim)return;
    try{
      const result=await provisionTwitterZernioConnection({
        organizationId:typed.organization_id,organizationName,actorUserId:typed.created_by,
        label:item.label,apiKey:decryptToken(item.encrypted_api_key),
        initialGrantMicros:Number(item.initial_grant_micros_snapshot),
        twitterSlotLimit:Number(item.twitter_slot_limit_snapshot),
        rejectExistingConnection:true,importItemId:item.id,
      });
      await admin.from('twitter_connection_import_items').update({
        status:'succeeded',twitter_connection_id:String(result.connection.connectionId),
        completed_at:new Date().toISOString(),last_error_message:null,
      }).eq('id',item.id);
    }catch(error){
      await admin.from('twitter_connection_import_items').update({
        status:'failed',completed_at:new Date().toISOString(),
        last_error_message:(error instanceof Error?error.message:'Falha ao cadastrar a conexão Zernio X.').slice(0,1000),
      }).eq('id',item.id);
    }
  });
  const{data:states}=await admin.from('twitter_connection_import_items').select('status').eq('batch_id',batchId);
  const hasFailures=(states??[]).some(item=>item.status==='failed');
  const status=hasFailures?'completed_with_errors':'completed';
  await admin.from('twitter_connection_import_batches').update({status,completed_at:new Date().toISOString()}).eq('id',batchId);
  const{data:next}=await admin.from('twitter_connection_import_batches').select('id')
    .eq('organization_id',typed.organization_id).eq('status','queued').neq('id',batchId).order('created_at').limit(1).maybeSingle();
  if(next?.id)await processTwitterZernioImportBatch(next.id,organizationName);
  return{status};
}
