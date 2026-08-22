import { buildTwitterCombinations, getTwitterCombinationForSlot } from './bulk.ts';
import { getTwitterCreatePrice, validateTwitterContent } from './pricing.ts';

export type ReviewProfile = { id:string; connectionId:string; epochId:string; identityId:string; username:string; tier:'free'|'premium'|'unknown' };
export type ReviewWallet = { identityId:string; postedMicros:number; reservedMicros:number; version:number };
export type ReviewSchedule = { kind:'interval'; startsAt:string; intervalMinutes:number; durationMinutes:number } | { kind:'daily'; startDate:string; dailyTime:string; days:number };
export type ReviewMediaSet = { clientKey:string; mediaKind:'images'|'gif'|'video'; assetIds:string[] };

function scheduleDescriptor(schedule: ReviewSchedule) {
  if (schedule.kind === 'interval') {
    const start = Date.parse(schedule.startsAt);
    if (!Number.isFinite(start) || !Number.isInteger(schedule.intervalMinutes) || schedule.intervalMinutes < 1 || !Number.isInteger(schedule.durationMinutes) || schedule.durationMinutes < 0 || schedule.durationMinutes > 129600) throw new Error('Intervalo inválido.');
    const count = Math.floor(schedule.durationMinutes / schedule.intervalMinutes) + 1;
    const at=(index:number)=>new Date(start+index*schedule.intervalMinutes*60000).toISOString();
    return {count,first:at(0),last:at(count-1),at};
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(schedule.startDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.dailyTime) || !Number.isInteger(schedule.days) || schedule.days < 1 || schedule.days > 90) throw new Error('Horário diário inválido.');
  const [year,month,day]=schedule.startDate.split('-').map(Number); const [hour,minute]=schedule.dailyTime.split(':').map(Number);
  const at=(index:number)=>{ const calendar=new Date(Date.UTC(year,month-1,day+index)); return new Date(Date.UTC(calendar.getUTCFullYear(),calendar.getUTCMonth(),calendar.getUTCDate(),hour+3,minute)).toISOString(); };
  return {count:schedule.days,first:at(0),last:at(schedule.days-1),at};
}

export function buildTwitterBulkReview(input:{ profiles:ReviewProfile[]; wallets:ReviewWallet[]; texts:string[]; mediaSets:ReviewMediaSet[]; schedule:ReviewSchedule }) {
  const profiles=[...input.profiles].sort((a,b)=>a.id.localeCompare(b.id)); if(!profiles.length) throw new Error('Selecione perfis X.');
  const texts=input.texts.map((text)=>text.trim()).filter(Boolean); if(!texts.length || texts.length>50) throw new Error('Informe de 1 a 50 textos.');
  const textInfo=texts.map((content,textIndex)=>{ const validations=profiles.map((profile)=>validateTwitterContent(content,profile.tier)); if(validations.some((v)=>!v.valid)) throw new Error(`O texto ${textIndex+1} excede o limite de um perfil selecionado.`); const price=getTwitterCreatePrice(content); return {textIndex,content,weightedCharacters:Math.max(...validations.map(v=>v.weightedCharacters)),containsUrl:price.category==='post_create_url',...price}; });
  const schedule=scheduleDescriptor(input.schedule); if(Date.parse(schedule.first)<=Date.now()) throw new Error('O primeiro horário precisa estar no futuro.');
  const combinations=buildTwitterCombinations(texts.length,input.mediaSets.length); const wallets=new Map(input.wallets.map(w=>[w.identityId,w]));
  const items:Array<Record<string,unknown>>=[]; const fundedSlotsByProfile=new Map<string,number[]>();
  for(const identityId of [...new Set(profiles.map(p=>p.identityId))].sort()){
    const wallet=wallets.get(identityId); if(!wallet) throw new Error('Carteira X ausente.'); let balance=wallet.postedMicros-wallet.reservedMicros;
    const identityProfiles=profiles.filter(p=>p.identityId===identityId); const cursor=new Map(identityProfiles.map(p=>[p.id,0]));
    const minimum=Math.min(...textInfo.map(t=>t.amountMicros));
    while(balance>=minimum){ let any=false;
      for(const profile of identityProfiles){ let index=cursor.get(profile.id)??0; const searchLimit=Math.min(schedule.count,index+combinations.length); while(index<searchLimit){ const slotIndex=index; const combo=getTwitterCombinationForSlot(combinations,profiles.findIndex(p=>p.id===profile.id),slotIndex); const text=textInfo[combo.textIndex]; index+=1; cursor.set(profile.id,index); if(text.amountMicros>balance) continue; items.push({profile_id:profile.id,connection_id:profile.connectionId,connection_epoch_id:profile.epochId,identity_id:profile.identityId,slot_index:slotIndex,execute_at:schedule.at(slotIndex),content:text.content,weighted_characters:text.weightedCharacters,media_set_client_key:combo.mediaSetIndex===null?null:input.mediaSets[combo.mediaSetIndex]?.clientKey,category:text.category,amount_micros:text.amountMicros}); balance-=text.amountMicros; const funded=fundedSlotsByProfile.get(profile.id)??[]; funded.push(slotIndex); fundedSlotsByProfile.set(profile.id,funded); any=true; break; } }
      if(!any) break;
    }
  }
  const totalRequested=profiles.length*schedule.count; if(!Number.isSafeInteger(totalRequested))throw new Error('Programação X grande demais.'); const shortfalls=profiles.map(profile=>{ const fundedSlots=(fundedSlotsByProfile.get(profile.id)??[]).sort((a,b)=>a-b); const fundedSet=new Set(fundedSlots); let firstUnfunded:number|null=null; for(let index=0;index<schedule.count;index+=1){if(!fundedSet.has(index)){firstUnfunded=index;break;}} let lastUnfunded:number|null=null; for(let index=schedule.count-1;index>=0;index-=1){if(!fundedSet.has(index)){lastUnfunded=index;break;}} const funded=fundedSlots.length; return {profile_id:profile.id,requested_count:schedule.count,funded_count:funded,unfunded_count:schedule.count-funded,first_unfunded_at:firstUnfunded===null?null:schedule.at(firstUnfunded),last_unfunded_at:lastUnfunded===null?null:schedule.at(lastUnfunded),interval_minutes:input.schedule.kind==='interval'?input.schedule.intervalMinutes:null}; });
  const reservedMicros=items.reduce((sum,item)=>sum+Number(item.amount_micros),0);
  const reservedByIdentity=new Map<string,number>(); for(const item of items){const identityId=String(item.identity_id);reservedByIdentity.set(identityId,(reservedByIdentity.get(identityId)??0)+Number(item.amount_micros));}
  const costBreakdown=(['post_dm_create','post_create_url'] as const).map(category=>{const categoryItems=items.filter(item=>item.category===category);return{category,count:categoryItems.length,totalMicros:categoryItems.reduce((sum,item)=>sum+Number(item.amount_micros),0)};});
  return { items,texts:textInfo,shortfalls,totalRequested,fundedCount:items.length,unfundedCount:totalRequested-items.length,reservedMicros,costBreakdown,schedule:{count:schedule.count,first:schedule.first,last:schedule.last},walletSnapshots:input.wallets.map(w=>{const availableMicros=w.postedMicros-w.reservedMicros;const programReservationMicros=reservedByIdentity.get(w.identityId)??0;return{identityId:w.identityId,walletVersion:w.version,postedMicros:w.postedMicros,reservedMicros:w.reservedMicros,availableMicros,programReservationMicros,projectedAvailableMicros:availableMicros-programReservationMicros};}) };
}
