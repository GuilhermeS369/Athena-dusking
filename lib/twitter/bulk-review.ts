import { buildTwitterCombinations, getTwitterCombinationForSlot } from './bulk.ts';
import { getTwitterCreatePrice, validateTwitterContent } from './pricing.ts';

export type ReviewProfile = { id:string; connectionId:string; epochId:string; identityId:string; username:string; tier:'free'|'premium'|'unknown' };
export type ReviewWallet = { identityId:string; postedMicros:number; reservedMicros:number; version:number };
export type ReviewSchedule = { kind:'interval'; startsAt:string; intervalMinutes:number; durationMinutes:number } | { kind:'daily'; startDate:string; dailyTime:string; days:number };
export type ReviewMediaSet = { clientKey:string; mediaKind:'images'|'gif'|'video'; assetIds:string[] };

function scheduleSlots(schedule: ReviewSchedule) {
  if (schedule.kind === 'interval') {
    const start = Date.parse(schedule.startsAt);
    if (!Number.isFinite(start) || !Number.isInteger(schedule.intervalMinutes) || schedule.intervalMinutes < 1 || !Number.isInteger(schedule.durationMinutes) || schedule.durationMinutes < 0 || schedule.durationMinutes > 129600) throw new Error('Intervalo inválido.');
    const count = Math.floor(schedule.durationMinutes / schedule.intervalMinutes) + 1;
    return Array.from({length:count},(_,index)=>new Date(start+index*schedule.intervalMinutes*60000).toISOString());
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(schedule.startDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.dailyTime) || !Number.isInteger(schedule.days) || schedule.days < 1 || schedule.days > 90) throw new Error('Horário diário inválido.');
  const [year,month,day]=schedule.startDate.split('-').map(Number); const [hour,minute]=schedule.dailyTime.split(':').map(Number);
  return Array.from({length:schedule.days},(_,index)=>{ const calendar=new Date(Date.UTC(year,month-1,day+index)); return new Date(Date.UTC(calendar.getUTCFullYear(),calendar.getUTCMonth(),calendar.getUTCDate(),hour+3,minute)).toISOString(); });
}

export function buildTwitterBulkReview(input:{ profiles:ReviewProfile[]; wallets:ReviewWallet[]; texts:string[]; mediaSets:ReviewMediaSet[]; schedule:ReviewSchedule }) {
  const profiles=[...input.profiles].sort((a,b)=>a.id.localeCompare(b.id)); if(!profiles.length) throw new Error('Selecione perfis X.');
  const texts=input.texts.map((text)=>text.trim()).filter(Boolean); if(!texts.length || texts.length>50) throw new Error('Informe de 1 a 50 textos.');
  const textInfo=texts.map((content,textIndex)=>{ const validations=profiles.map((profile)=>validateTwitterContent(content,profile.tier)); if(validations.some((v)=>!v.valid)) throw new Error(`O texto ${textIndex+1} excede o limite de um perfil selecionado.`); const price=getTwitterCreatePrice(content); return {textIndex,content,weightedCharacters:Math.max(...validations.map(v=>v.weightedCharacters)),containsUrl:price.category==='post_create_url',...price}; });
  const slots=scheduleSlots(input.schedule); if(slots[0] && Date.parse(slots[0])<=Date.now()) throw new Error('O primeiro horário precisa estar no futuro.');
  const combinations=buildTwitterCombinations(texts.length,input.mediaSets.length); const wallets=new Map(input.wallets.map(w=>[w.identityId,w]));
  const items:Array<Record<string,unknown>>=[]; const fundedByProfile=new Map<string,number>();
  for(const identityId of [...new Set(profiles.map(p=>p.identityId))].sort()){
    const wallet=wallets.get(identityId); if(!wallet) throw new Error('Carteira X ausente.'); let balance=wallet.postedMicros-wallet.reservedMicros;
    const identityProfiles=profiles.filter(p=>p.identityId===identityId); const cursor=new Map(identityProfiles.map(p=>[p.id,0]));
    const minimum=Math.min(...textInfo.map(t=>t.amountMicros));
    while(balance>=minimum){ let any=false;
      for(const profile of identityProfiles){ let index=cursor.get(profile.id)??0; while(index<slots.length){ const combo=getTwitterCombinationForSlot(combinations,profiles.findIndex(p=>p.id===profile.id),index); const text=textInfo[combo.textIndex]; index+=1; cursor.set(profile.id,index); if(text.amountMicros>balance) continue; items.push({profile_id:profile.id,connection_id:profile.connectionId,connection_epoch_id:profile.epochId,identity_id:profile.identityId,slot_index:index-1,execute_at:slots[index-1],content:text.content,weighted_characters:text.weightedCharacters,media_set_client_key:combo.mediaSetIndex===null?null:input.mediaSets[combo.mediaSetIndex]?.clientKey,category:text.category,amount_micros:text.amountMicros}); balance-=text.amountMicros; fundedByProfile.set(profile.id,(fundedByProfile.get(profile.id)??0)+1); any=true; break; } }
      if(!any) break;
    }
  }
  const totalRequested=profiles.length*slots.length; const shortfalls=profiles.map(profile=>{ const funded=fundedByProfile.get(profile.id)??0; return {profile_id:profile.id,requested_count:slots.length,funded_count:funded,unfunded_count:slots.length-funded,first_unfunded_at:funded<slots.length?slots[0]:null,last_unfunded_at:funded<slots.length?slots.at(-1):null,interval_minutes:input.schedule.kind==='interval'?input.schedule.intervalMinutes:null}; });
  const reservedMicros=items.reduce((sum,item)=>sum+Number(item.amount_micros),0);
  return { items,texts:textInfo,shortfalls,totalRequested,fundedCount:items.length,unfundedCount:totalRequested-items.length,reservedMicros,slots, walletSnapshots:input.wallets.map(w=>({identityId:w.identityId,walletVersion:w.version,availableMicros:w.postedMicros-w.reservedMicros})) };
}
