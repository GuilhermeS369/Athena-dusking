import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTwitterBulkReview,nextTwitterDailySlot } from './bulk-review.ts';

const profile={id:'p1',connectionId:'c1',epochId:'e1',identityId:'w1',username:'a',tier:'free' as const};
const now='2026-08-23T12:00:00.000Z';

test('um dia a cada 60 minutos gera 24 slots e inicia em base mais intervalo',()=>{const result=buildTwitterBulkReview({name:'Programa',profiles:[profile],wallets:[{identityId:'w1',postedMicros:12_000_000,reservedMicros:0,version:1}],texts:['barato'],mediaSets:[],schedule:{kind:'interval',intervalMinutes:60,durationDays:1},now});assert.equal(result.schedule.count,24);assert.equal(result.schedule.first,'2026-08-23T13:00:00.000Z');assert.equal(result.schedule.last,'2026-08-24T12:00:00.000Z');});

test('intervalo acumula depois da cauda existente',()=>{const result=buildTwitterBulkReview({name:'Programa',profiles:[profile],wallets:[{identityId:'w1',postedMicros:12_000_000,reservedMicros:0,version:1}],texts:['barato'],mediaSets:[],schedule:{kind:'interval',intervalMinutes:60,durationDays:1},queueStates:[{profileId:'p1',queueTailAt:'2026-08-24T10:00:00.000Z',blockingCount:0}],now});assert.equal(result.schedule.first,'2026-08-24T11:00:00.000Z');});

test('review financia parcialmente sem materializar excedente',()=>{const result=buildTwitterBulkReview({name:'Programa',profiles:[profile],wallets:[{identityId:'w1',postedMicros:30000,reservedMicros:0,version:1}],texts:['barato','https://exemplo.com caro'],mediaSets:[],schedule:{kind:'interval',intervalMinutes:1,durationDays:1},now});assert.equal(result.fundedCount,2);assert.equal(result.unfundedCount,1438);assert.equal(result.items.length,2);assert.equal(result.reservedMicros,30000);assert.deepEqual(result.costBreakdown.map(value=>value.totalMicros),[30000,0]);});

test('review de 90 dias limita materialização ao saldo',()=>{const result=buildTwitterBulkReview({name:'Programa',profiles:[profile],wallets:[{identityId:'w1',postedMicros:12000000,reservedMicros:0,version:1}],texts:['barato'],mediaSets:[],schedule:{kind:'interval',intervalMinutes:1,durationDays:90},now});assert.equal(result.schedule.count,129600);assert.equal(result.fundedCount,800);assert.equal(result.items.length,800);assert.equal(result.unfundedCount,128800);assert.equal(result.shortfalls[0].first_unfunded_at,'2026-08-24T01:21:00.000Z');});

test('perfil com envio ativo não entra em nova revisão',()=>{assert.throws(()=>buildTwitterBulkReview({name:'Programa',profiles:[profile],wallets:[{identityId:'w1',postedMicros:12000000,reservedMicros:0,version:1}],texts:['barato'],mediaSets:[],schedule:{kind:'interval',intervalMinutes:60,durationDays:1},queueStates:[{profileId:'p1',queueTailAt:null,blockingCount:1}],now}),/resultado incerto|processamento/);});

test('horário diário usa a próxima ocorrência em São Paulo',()=>{assert.equal(nextTwitterDailySlot('2026-08-23T10:00:00.000Z','09:00'),'2026-08-23T12:00:00.000Z');assert.equal(nextTwitterDailySlot('2026-08-23T13:00:00.000Z','09:00'),'2026-08-24T12:00:00.000Z');});

test('horário diário atravessa mês e ano sem abandonar America/Sao_Paulo',()=>{assert.equal(nextTwitterDailySlot('2026-12-31T13:00:00.000Z','09:00'),'2027-01-01T12:00:00.000Z');assert.equal(nextTwitterDailySlot('2027-01-31T13:00:00.000Z','09:00'),'2027-02-01T12:00:00.000Z');});

test('carteira compartilhada não duplica saldo e distribui financiamento entre perfis',()=>{const second={...profile,id:'p2',connectionId:'c2',epochId:'e2',username:'b'};const result=buildTwitterBulkReview({name:'Compartilhado',profiles:[profile,second],wallets:[{identityId:'w1',postedMicros:45000,reservedMicros:0,version:1}],texts:['barato'],mediaSets:[],schedule:{kind:'interval',intervalMinutes:60,durationDays:1},now});assert.equal(result.reservedMicros,45000);assert.equal(result.fundedCount,3);assert.deepEqual(result.shortfalls.map(value=>value.funded_count),[2,1]);});

test('revisão classifica texto, imagens, GIF e vídeo nos itens financiados',()=>{const result=buildTwitterBulkReview({name:'Tipos',profiles:[profile],wallets:[{identityId:'w1',postedMicros:180000,reservedMicros:0,version:1}],texts:['um','dois'],mediaSets:[{clientKey:'images',mediaKind:'images',assetIds:['a']},{clientKey:'gif',mediaKind:'gif',assetIds:['b']},{clientKey:'video',mediaKind:'video',assetIds:['c']}],schedule:{kind:'interval',intervalMinutes:60,durationDays:1},now});assert.deepEqual(result.typeBreakdown.map(value=>value.count),[0,4,4,4]);});

test('revisão aceita mídia sem texto e mantém o custo de post sem URL',()=>{const result=buildTwitterBulkReview({name:'Somente mídia',profiles:[profile],wallets:[{identityId:'w1',postedMicros:30000,reservedMicros:0,version:1}],texts:[],mediaSets:[{clientKey:'video',mediaKind:'video',assetIds:['a']}],schedule:{kind:'interval',intervalMinutes:60,durationDays:1},now});assert.equal(result.fundedCount,2);assert.equal(result.items[0].content,'');assert.equal(result.items[0].weighted_characters,0);assert.equal(result.items[0].amount_micros,15000);assert.deepEqual(result.typeBreakdown.map(value=>value.count),[0,0,0,2]);});

test('revisão continua rejeitando programa sem texto e sem mídia',()=>{assert.throws(()=>buildTwitterBulkReview({name:'Vazio',profiles:[profile],wallets:[{identityId:'w1',postedMicros:30000,reservedMicros:0,version:1}],texts:[],mediaSets:[],schedule:{kind:'interval',intervalMinutes:60,durationDays:1},now}),/texto ou selecione mídia/);});
