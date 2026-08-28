import { createHash } from 'node:crypto';
import { loadEnvConfig } from '@next/env';

import { createSupabaseAdminClient } from '../../lib/supabase/admin';

loadEnvConfig(process.cwd());

type Item = { id:string;status:string;execute_at:string;dispatch_deadline_at:string|null;preparation_status:string;amount_micros:number|string };

async function readAllItems() {
  const admin=createSupabaseAdminClient(),rows:Item[]=[],pageSize=1000;
  for(let from=0;;from+=pageSize){const {data,error}=await admin.from('twitter_publication_items').select('id,status,execute_at,dispatch_deadline_at,preparation_status,amount_micros').order('id').range(from,from+pageSize-1);if(error)throw error;rows.push(...((data??[])as Item[]));if((data?.length??0)<pageSize)return rows;}
}

async function main(){
  const admin=createSupabaseAdminClient(),items=await readAllItems(),now=Date.now(),byStatus:Record<string,number>={};
  const byPreparation:Record<string,number>={};
  for(const item of items)byStatus[item.status]=(byStatus[item.status]??0)+1;
  for(const item of items.filter(row=>['ready','retry'].includes(row.status)))byPreparation[item.preparation_status]=(byPreparation[item.preparation_status]??0)+1;
  const [{data:holds,error:holdsError},{data:attempts,error:attemptsError},{count:attemptCount,error:attemptCountError}]=await Promise.all([
    admin.from('twitter_item_holds').select('status,amount_micros'),
    admin.from('twitter_publication_attempts').select('item_id,external_started_at,status').in('status',['claimed','external_started','outcome_unknown']),
    admin.from('twitter_publication_attempts').select('*',{count:'exact',head:true}),
  ]);
  if(holdsError||attemptsError||attemptCountError)throw holdsError??attemptsError??attemptCountError;
  const externallyStarted=new Set((attempts??[]).filter(row=>row.external_started_at).map(row=>row.item_id));
  const digest=createHash('sha256').update(items.map(item=>`${item.id}:${item.execute_at}:${item.status}`).join('|')).digest('hex');
  const sum=(statuses:string[])=>(holds??[]).filter(row=>statuses.includes(row.status)).reduce((total,row)=>total+BigInt(String(row.amount_micros)),BigInt(0)).toString();
  const databaseAudit=await admin.rpc('twitter_publication_scale_audit');if(databaseAudit.error)throw databaseAudit.error;
  const future=items.filter(item=>['ready','retry'].includes(item.status)&&Date.parse(item.execute_at)>now).sort((a,b)=>Date.parse(a.execute_at)-Date.parse(b.execute_at));
  console.log(JSON.stringify({capturedAt:new Date().toISOString(),total:items.length,publicationAttempts:attemptCount??0,byStatus,byPreparation,digest,pastDueUnstarted:items.filter(item=>['ready','retry','claimed'].includes(item.status)&&Date.parse(item.execute_at)+15*60_000<=now&&!externallyStarted.has(item.id)).length,futureUnstarted:future.length,nextExecuteAt:future[0]?.execute_at??null,readyWithoutDeadline:future.filter(item=>!item.dispatch_deadline_at).length,processingOrUnknown:items.filter(item=>['processing','outcome_unknown'].includes(item.status)).length,reservedHoldMicros:sum(['reserved']),activeOrUnknownHoldMicros:sum(['active','outcome_unknown']),databaseAudit:databaseAudit.data},null,2));
}

main().catch(error=>{console.error(error instanceof Error?error.message:'Falha no dry-run X.');process.exitCode=1;});
