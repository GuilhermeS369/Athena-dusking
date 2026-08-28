import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { classifyTwitterProviderResponse,normalizeTwitterProviderResponseBody,terminalTwitterDisconnectionSignal } from '../../scripts/workers/twitter-provider-classification.mjs';

const migrationUrl=new URL('../../supabase/migrations/267_twitter_publication_scale_and_safety.sql',import.meta.url);

test('resposta URL ou texto nunca é confundida com sucesso X',()=>{
  const url=normalizeTwitterProviderResponseBody('https://zernio.example/error/123');
  assert.equal(url.responseKind,'url');
  assert.equal(classifyTwitterProviderResponse({ok:true,status:200,payload:url.payload}).resolution,'outcome_unknown');
  const text=normalizeTwitterProviderResponseBody('upstream respondeu sem JSON');
  assert.equal(text.responseKind,'text');
  assert.equal(classifyTwitterProviderResponse({ok:false,status:400,payload:text.payload}).resolution,'confirmed_failure');
});

test('somente os dois sinais homologados retiram perfil X',()=>{
  assert.equal(terminalTwitterDisconnectionSignal({code:'account_disconnected'}),'account_disconnected');
  assert.equal(terminalTwitterDisconnectionSignal({code:'auth_expired'}),'auth_expired');
  assert.equal(terminalTwitterDisconnectionSignal({message:'auth expired'}),null);
  assert.equal(terminalTwitterDisconnectionSignal({code:'unauthorized',message:'token inválido'}),null);
  assert.equal(terminalTwitterDisconnectionSignal({code:'oauth_error',message:'reconecte'}),null);
});

test('migração fixa 15 minutos, preparação 24h e missed individual sem ignored em cascata',async()=>{
  const source=await readFile(migrationUrl,'utf8');
  assert.match(source,/execute_at\+interval '15 minutes'/);
  assert.match(source,/interval '24 hours'/);
  assert.match(source,/status='missed'/);
  assert.match(source,/twitter_release_item_hold/);
  assert.doesNotMatch(source,/p_grace_seconds|status='ignored'|set status='ignored'/);
});

test('dispatcher usa fencing, skip locked, lote cinquenta e limite distribuído por conexão',async()=>{
  const[source,worker,claimRoute]=await Promise.all([
    readFile(migrationUrl,'utf8'),
    readFile(new URL('../../scripts/workers/twitter-worker.mjs',import.meta.url),'utf8'),
    readFile(new URL('../../app/api/internal/twitter-publication-claims/route.ts',import.meta.url),'utf8'),
  ]);
  assert.match(source,/for update of i skip locked limit least\(greatest\(p_limit,1\),50\)/);
  assert.match(source,/twitter_dispatch_fences/);
  assert.match(source,/current_limit smallint not null default 8/);
  assert.match(source,/status in\('claimed','processing','outcome_unknown'\)/);
  assert.match(worker,/TWITTER_PUBLICATION_WORKER_CONCURRENCY\?\?'32'/);
  assert.match(claimRoute,/createSignedUrls/);
  assert.doesNotMatch(claimRoute,/createSignedUrl\(/);
});

test('backfill preserva terminais e quarentena vencidos sem alterar execute_at',async()=>{
  const source=await readFile(migrationUrl,'utf8');
  const start=source.indexOf('twitter_backfill_publication_scale');
  const end=source.indexOf('twitter_expire_dispatch_deadlines');
  const backfill=source.slice(start,end);
  assert.match(backfill,/status in\('ready','retry','claimed'\)/);
  assert.match(backfill,/migration_deadline_elapsed/);
  assert.doesNotMatch(backfill,/set execute_at=/);
  assert.doesNotMatch(backfill,/published.*set|cancelled.*set|outcome_unknown.*set/);
});

test('Agenda e compositor paginam sem limites funcionais antigos',async()=>{
  const[agenda,composer,page]=await Promise.all([
    readFile(new URL('../../app/api/x/agenda/route.ts',import.meta.url),'utf8'),
    readFile(new URL('../../app/x/twitter-bulk-client.tsx',import.meta.url),'utf8'),
    readFile(new URL('../../app/(painel)/x/postagem/page.tsx',import.meta.url),'utf8'),
  ]);
  assert.match(agenda,/nextCursor/);assert.match(agenda,/limit\+1/);
  assert.match(composer,/loadMoreMedia/);assert.match(composer,/api\/x\/media/);
  assert.doesNotMatch(page,/limit\(200\)/);
});
