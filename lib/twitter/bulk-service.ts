import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { fetchAllRowsByIds } from '@/lib/supabase/chunk';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { buildTwitterBulkReview, type ReviewMediaSet, type ReviewSchedule } from './bulk-review';
import { signTwitterReviewToken, twitterReviewDigest, verifyTwitterReviewToken } from './review-token';
import type { BulkRotationOrderMode } from '../publications/bulk-rotation';

export type TwitterBulkRequest = { scheduleVersion:2; name:string; profileIds:string[]; texts:string[]; mediaSets:ReviewMediaSet[]; orderMode:BulkRotationOrderMode; rotationSeed:string; schedule:ReviewSchedule };

export async function prepareTwitterBulkReview(organizationId:string,input:TwitterBulkRequest,reviewedAt?:string){
  const admin=createSupabaseAdminClient(); const profileIds=[...new Set(input.profileIds)].sort();
  if(input.scheduleVersion!==2)throw new Error('Atualize a página para usar a agenda X V2.');
  if(!['same_order','diversified'].includes(input.orderMode)||!input.rotationSeed?.trim())throw new Error('Configuração de rotação X inválida.');
  const [{data:profiles,error:profileError},{data:assets,error:assetError},{data:rateCard,error:rateError},{data:queueSummary,error:queueError}]=await Promise.all([
    // Todas estas leituras escalam com a seleção ou com a frota: sem blocos e
    // paginação o PostgREST devolveria 1.000 linhas e a guarda de comprimento
    // abaixo recusaria a postagem culpando os perfis.
    fetchAllRowsByIds(profileIds,(chunk,from,to)=>admin.from('twitter_profiles').select('id,username,account_tier,current_connection_id,current_epoch_id').eq('organization_id',organizationId).in('id',chunk).is('deleted_at',null).eq('status','active').eq('can_post',true).order('id',{ascending:true}).range(from,to)),
    fetchAllRowsByIds(input.mediaSets.flatMap(set=>set.assetIds),(chunk,from,to)=>admin.from('twitter_media_assets').select('id,media_kind,status').eq('organization_id',organizationId).in('id',chunk).is('deleted_at',null).order('id',{ascending:true}).range(from,to)),
    admin.from('twitter_rate_cards').select('id,version').eq('active',true).single(),
    fetchAllRows<{profile_id:string;last_execute_at:string|null;blocking_count:number|string}>((from,to)=>admin.rpc('twitter_bulk_profile_queue_summary',{p_organization_id:organizationId}).order('profile_id').range(from,to)),
  ]);
  if(profileError||assetError||rateError||queueError||!rateCard) throw new Error('Não foi possível carregar o snapshot de revisão X.');
  if(profiles.length!==profileIds.length) throw new Error('Um ou mais perfis X estão indisponíveis para postagem.');
  const assetMap=new Map(assets.map(a=>[a.id,a]));
  for(const set of input.mediaSets){ if(set.mediaKind==='images'&&(set.assetIds.length<1||set.assetIds.length>4)) throw new Error('Conjuntos de imagens exigem de 1 a 4 arquivos.'); if(set.mediaKind!=='images'&&set.assetIds.length!==1) throw new Error('GIF ou vídeo exige exatamente um arquivo.'); for(const id of set.assetIds){const asset=assetMap.get(id); const expected=set.mediaKind==='images'?'image':set.mediaKind; if(!asset||asset.status!=='ready'||asset.media_kind!==expected) throw new Error('Conjunto de mídia X inválido.');}}
  const connectionIds=[...new Set(profiles.map(profile=>profile.current_connection_id).filter((value):value is string=>Boolean(value)))];
  const {data:connections,error:connectionError}=await fetchAllRowsByIds(connectionIds,(chunk,from,to)=>admin.from('twitter_connections').select('id,identity_id').eq('organization_id',organizationId).in('id',chunk).is('deleted_at',null).order('id',{ascending:true}).range(from,to));
  if(connectionError||connections.length!==connectionIds.length) throw new Error('Uma conexão X mudou durante a revisão.');
  const identityByConnection=new Map(connections.map(connection=>[connection.id,connection.identity_id])); const identityIds=[...new Set(connections.map(connection=>connection.identity_id))];
  const {data:wallets,error:walletError}=await fetchAllRowsByIds(identityIds,(chunk,from,to)=>admin.from('twitter_wallets').select('identity_id,posted_balance_micros,reserved_micros,version').eq('organization_id',organizationId).in('identity_id',chunk).order('identity_id',{ascending:true}).range(from,to)); if(walletError) throw new Error('Não foi possível carregar as carteiras X.');
  const normalized={scheduleVersion:2,name:input.name.trim(),profileIds,texts:input.texts,mediaSets:input.mediaSets,orderMode:input.orderMode,rotationSeed:input.rotationSeed.trim(),schedule:input.schedule}; const requestDigest=twitterReviewDigest(normalized);
  const review=buildTwitterBulkReview({name:input.name,profiles:profiles.map(profile=>({id:profile.id,username:profile.username,connectionId:profile.current_connection_id!,epochId:profile.current_epoch_id!,identityId:identityByConnection.get(profile.current_connection_id!)!,tier:profile.account_tier})),wallets:wallets.map(w=>({identityId:w.identity_id,postedMicros:Number(w.posted_balance_micros),reservedMicros:Number(w.reserved_micros),version:Number(w.version)})),texts:input.texts,mediaSets:input.mediaSets,orderMode:input.orderMode,rotationSeed:input.rotationSeed,schedule:input.schedule,queueStates:queueSummary.map(row=>({profileId:row.profile_id,queueTailAt:row.last_execute_at,blockingCount:Number(row.blocking_count)})),now:reviewedAt});
  const reviewDigest=twitterReviewDigest({requestDigest,rateCardVersion:rateCard.version,walletSnapshots:review.walletSnapshots,items:review.items});
  const reviewToken=signTwitterReviewToken({organizationId,scheduleVersion:2,reviewedAt:review.schedule.reviewedAt,requestDigest,reviewDigest,rateCardVersion:rateCard.version,walletSnapshots:review.walletSnapshots,scheduleSnapshot:review.schedule.profiles,expiresAt:Date.now()+10*60_000});
  return {...review,reviewToken,reviewDigest,rateCardVersion:rateCard.version,normalized};
}

export async function confirmTwitterBulkReview(input:{organizationId:string;actorUserId:string;request:TwitterBulkRequest;reviewToken:string;idempotencyKey:string}){
  const token=verifyTwitterReviewToken(input.reviewToken); if(token.organizationId!==input.organizationId) throw new Error('A revisão não corresponde à organização ativa.');
  const review=await prepareTwitterBulkReview(input.organizationId,input.request,typeof token.reviewedAt==='string'?token.reviewedAt:undefined);
  const reviewDrift = {
    request: token.requestDigest!==twitterReviewDigest(review.normalized),
    review: token.reviewDigest!==review.reviewDigest,
    rateCard: token.rateCardVersion!==review.rateCardVersion,
    wallet: twitterReviewDigest(token.walletSnapshots)!==twitterReviewDigest(review.walletSnapshots),
  };
  if(Object.values(reviewDrift).some(Boolean)){
    const fields=Object.entries(reviewDrift).filter(([,changed])=>changed).map(([field])=>field).join(',');
    const error=new Error(`Saldo, perfis ou preços mudaram. Revise novamente. [review_drift:${fields}]`) as Error&{status?:number;code?:string};
    error.status=409; error.code='TWITTER_REVIEW_DRIFT'; throw error;
  }
  const program={scheduleVersion:2,name:input.request.name.trim(),orderMode:input.request.orderMode,rotationSeed:input.request.rotationSeed.trim(),scheduleKind:input.request.schedule.kind,startsAt:review.schedule.first,endsAt:review.schedule.last,intervalMinutes:input.request.schedule.kind==='interval'?input.request.schedule.intervalMinutes:null,dailyTime:input.request.schedule.kind==='daily'?input.request.schedule.dailyTime:null,totalRequested:review.totalRequested,unfundedCount:review.unfundedCount};
  const admin=createSupabaseAdminClient(); const {data,error}=await admin.rpc('twitter_confirm_bulk_program_v2',{p_organization_id:input.organizationId,p_actor_user_id:input.actorUserId,p_idempotency_key:input.idempotencyKey,p_review_digest:review.reviewDigest,p_rate_card_version:review.rateCardVersion,p_wallet_snapshots:review.walletSnapshots,p_program:program,p_texts:review.texts.filter(t=>t.content.length>0).map(t=>({text_index:t.textIndex,content:t.content,weighted_characters:t.weightedCharacters,contains_url:t.containsUrl})),p_media_sets:input.request.mediaSets.map((set,index)=>({clientKey:set.clientKey,setIndex:index,mediaKind:set.mediaKind,assetIds:set.assetIds})),p_items:review.items,p_shortfalls:review.shortfalls,p_schedule_snapshot:review.schedule.profiles});
  if(error){
    const conflicts:Record<string,string>={
      'Tabela de preços mudou; revise novamente.':'rate_card_changed',
      'Saldo ou reservas mudaram; revise novamente.':'wallet_changed',
      'Perfil ou conexão mudou; revise novamente.':'profile_connection_changed',
      'A fila X mudou; revise novamente.':'queue_changed',
      'Perfil possui envio em processamento; revise após a reconciliação.':'profile_blocked',
      'Saldo insuficiente após concorrência; revise novamente.':'insufficient_after_concurrency',
    };
    const conflictCode=conflicts[error.message];
    const wrapped=new Error(conflictCode?`Saldo, perfis ou preços mudaram. Revise novamente. [database_conflict:${conflictCode}]`:'Não foi possível confirmar o programa X.') as Error&{status?:number;code?:string};
    if(error.code==='40001')wrapped.status=409;
    if(conflictCode)wrapped.code='TWITTER_CONFIRM_CONFLICT';
    throw wrapped;
  } return {...(data as Record<string,unknown>),dispatchPolicy:{version:1,windowMinutes:15},executeAt:review.schedule.first,dispatchDeadlineAt:review.schedule.firstDispatchDeadlineAt};
}
