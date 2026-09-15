// Sonda manual da Graph API para um perfil. Uso: node scripts/workers/sonda-perfil.ts <username>
// Le o token do perfil, chama a Meta e imprime status + corpo. O token NUNCA e impresso.
import { createClient } from '@supabase/supabase-js';
import { decryptToken } from '../../lib/security/token-crypto.ts';

for (const f of ['.env.local', '.env.worker']) { try { process.loadEnvFile(f); } catch {} }

const username = process.argv[2];
if (!username) { console.error('informe o username'); process.exit(1); }
const V = process.env.META_GRAPH_API_VERSION ?? 'v26.0';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const { data, error } = await admin.from('instagram_profiles')
  .select('id, username, instagram_user_id, status, token_expires_at, encrypted_access_token, deleted_at, meta_app_id')
  .eq('username', username).is('deleted_at', null).limit(1);
if (error) throw error;
const p = data?.[0];
if (!p) { console.error('perfil nao encontrado'); process.exit(1); }
const token = decryptToken(p.encrypted_access_token);
console.log(`perfil @${p.username} ig=${p.instagram_user_id} status=${p.status} token_expira=${p.token_expires_at} token_len=${token.length}`);

const { data: ultimos } = await admin.from('publication_items').select('meta_media_id, published_at')
  .eq('profile_id', p.id).eq('status', 'published').order('published_at', { ascending: false }).limit(2);
const mediaId = ultimos?.[0]?.meta_media_id;

async function chamar(rotulo: string, host: string, path: string, params: Record<string, string> = {}) {
  const url = new URL(`https://${host}/${V}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);
  const ini = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const corpo = (await res.text()).replaceAll(token, '<token>');
    console.log(`\n[${rotulo}] GET ${host}/${V}/${path} -> HTTP ${res.status} em ${Date.now() - ini} ms`);
    console.log(`  x-app-usage=${res.headers.get('x-app-usage') ?? '-'} www-auth=${(res.headers.get('www-authenticate') ?? '-').slice(0, 160)}`);
    console.log(`  ${corpo.slice(0, 700)}`);
  } catch (e) {
    console.log(`\n[${rotulo}] ${path} -> EXCECAO ${(e as Error).message}`);
  }
}

await chamar('1 me', 'graph.instagram.com', 'me', { fields: 'id,username,account_type,media_count,followers_count' });
await chamar('2 media', 'graph.instagram.com', `${p.instagram_user_id}/media`, { fields: 'id,media_type,permalink,timestamp', limit: '3' });
await chamar('3 insights conta hoje', 'graph.instagram.com', `${p.instagram_user_id}/insights`, { metric: 'views,reach', period: 'day', metric_type: 'total_value' });
if (mediaId) {
  await chamar('4 ultimo post', 'graph.instagram.com', `${mediaId}`, { fields: 'id,media_type,permalink,timestamp,like_count' });
  await chamar('5 insights ultimo post', 'graph.instagram.com', `${mediaId}/insights`, { metric: 'views,reach' });
}
await chamar('6 cota de publicacao', 'graph.instagram.com', `${p.instagram_user_id}/content_publishing_limit`, { fields: 'quota_usage,config' });
await chamar('7 me via facebook', 'graph.facebook.com', 'me', { fields: 'id,username' });
console.log('\nultimos publicados:', JSON.stringify(ultimos));
