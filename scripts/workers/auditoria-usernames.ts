// Auditoria de leitura: para cada perfil online (meta_official, nao apagado) chama GET /me?fields=id,username
// e compara com o username gravado. Saida JSONL em /tmp/auditoria-usernames.jsonl. Token nunca e impresso.
// Uso (na VPS): node scripts/workers/auditoria-usernames.ts
import { createClient } from '@supabase/supabase-js';
import { appendFileSync, writeFileSync } from 'node:fs';
import { decryptToken } from '../../lib/security/token-crypto.ts';

for (const f of ['.env.local', '.env.worker']) { try { process.loadEnvFile(f); } catch {} }
const V = process.env.META_GRAPH_API_VERSION ?? 'v26.0';
const OUT = '/tmp/auditoria-usernames.jsonl';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

// Paginado por `id` (chave primaria): ordem total, exigida pelo row-limit-guard.
const perfis: any[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await admin.from('instagram_profiles')
    .select('id, username, display_name, instagram_user_id, status, encrypted_access_token')
    .eq('provider', 'meta_official').is('deleted_at', null).in('status', ['online', 'reauthorization_required'])
    .order('id', { ascending: true }).range(from, from + 999);
  if (error) throw error;
  perfis.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}
console.log(`perfis a sondar: ${perfis.length}`);
writeFileSync(OUT, '');

let feitos = 0, renomeados = 0, erros = 0;
async function sondar(p: any) {
  const linha: any = { id: p.id, ig: p.instagram_user_id, status_db: p.status, username_db: p.username };
  try {
    const token = decryptToken(p.encrypted_access_token);
    const url = new URL(`https://graph.instagram.com/${V}/me`);
    url.searchParams.set('fields', 'id,username,name');
    url.searchParams.set('access_token', token);
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const corpo: any = await res.json().catch(() => ({}));
    linha.http = res.status;
    if (res.ok) {
      linha.username_meta = corpo.username; linha.name_meta = corpo.name; linha.name_db = p.display_name; linha.ig_meta = corpo.id;
      if (corpo.username !== p.username) renomeados++;
    } else {
      erros++;
      linha.code = corpo?.error?.code; linha.subcode = corpo?.error?.error_subcode;
      linha.message = String(corpo?.error?.message ?? '').replaceAll(token, '<token>').slice(0, 200);
    }
  } catch (e) { erros++; linha.excecao = (e as Error).message.slice(0, 200); }
  appendFileSync(OUT, JSON.stringify(linha) + '\n');
  feitos++;
  if (feitos % 200 === 0) console.log(`${feitos}/${perfis.length} renomeados=${renomeados} erros=${erros}`);
}
const fila = [...perfis];
await Promise.all(Array.from({ length: 4 }, async () => { while (fila.length) { await sondar(fila.shift()); await new Promise(r => setTimeout(r, 150)); } }));
console.log(`fim: ${feitos} sondados, ${renomeados} renomeados, ${erros} com erro -> ${OUT}`);
