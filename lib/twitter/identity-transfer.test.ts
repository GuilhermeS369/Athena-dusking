import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('transferência X usa RPC v2 idempotente e autorização admin bilateral',async()=>{
  const[migration,route,page,client]=await Promise.all([
    readFile(new URL('../../supabase/migrations/243_twitter_identity_transfer_v2.sql',import.meta.url),'utf8'),
    readFile(new URL('../../app/api/x/integrations/zernio/identities/transfer/route.ts',import.meta.url),'utf8'),
    readFile(new URL('../../app/(painel)/x/zernio/page.tsx',import.meta.url),'utf8'),
    readFile(new URL('../../app/x/twitter-zernio-client.tsx',import.meta.url),'utf8'),
  ]);
  assert.match(migration,/idempotency_key/);
  assert.match(migration,/role='admin'[\s\S]*p_from_organization_id/);
  assert.match(migration,/role='admin'[\s\S]*p_to_organization_id/);
  assert.match(migration,/revoke execute on function public\.twitter_transfer_identity_organization\(/);
  assert.match(route,/getTwitterRequestContext\('admin'\)/);
  assert.match(route,/twitter_transfer_identity_organization_v2/);
  assert.match(route,/destination\.id===source\.id/);
  assert.match(page,/twitter_wallet_reservations/);
  assert.match(page,/twitter_identity_transfer_events/);
  assert.match(client,/TRANSFERIR/);
  assert.match(client,/Auditoria imutável/);
  assert.doesNotMatch(`${migration}\n${route}\n${page}\n${client}`,/instagram_profiles|public\.publication_items/);
});
