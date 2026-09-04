import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * A tomada do perfil pela Meta é a operação mais perigosa desta migração: ela
 * troca o provedor, a credencial e o identificador de uma linha que carrega
 * meses de métricas, os grupos e a fila. Um erro aqui não aparece como erro —
 * aparece como um perfil novo, vazio, do lado de um perfil velho, morto.
 *
 * Estes testes leem o SQL porque o que precisa ser garantido são invariantes da
 * função, não o retorno de uma chamada: a ordem de resolução, o lock, o caminho
 * de recusa e — o mais importante — o fato de o id da linha NÃO mudar.
 */

// A 375 substitui a funcao da 373. Os invariantes valem para a versao vigente.
const takeover = readFileSync(
  new URL('../../supabase/migrations/375_meta_takeover_resolution_without_coalesce.sql', import.meta.url),
  'utf8',
);
const transition = readFileSync(
  new URL('../../supabase/migrations/374_zernio_profiles_enter_meta_transition.sql', import.meta.url),
  'utf8',
);
const callback = readFileSync(
  new URL('../../app/api/integrations/meta/callback/route.ts', import.meta.url),
  'utf8',
);

test('o histórico sobrevive porque a tomada faz UPDATE, nunca insere linha nova', () => {
  // Se isto virar um insert, métricas, grupos e posts ficam para trás na linha
  // antiga e o perfil "reconectado" nasce zerado.
  const updateIndex = takeover.indexOf('update public.instagram_profiles set');
  const whereIndex = takeover.indexOf('where id = target.id;', updateIndex);

  assert.ok(updateIndex !== -1 && whereIndex > updateIndex);
  // O único insert é o do caso em que não existe perfil algum.
  assert.equal(takeover.split('insert into public.instagram_profiles').length - 1, 1);
});

test('resolve primeiro pelo id da Meta e só depois pelo @', () => {
  // A ordem importa: o id da Meta é identidade forte; o @ é o único elo com um
  // perfil Zernio, cujo instagram_user_id é o sintético `zernio:<accountId>`.
  const byUserId = takeover.indexOf('and instagram_user_id = p_instagram_user_id');
  const byUsername = takeover.indexOf("= normalized_username");

  assert.ok(byUserId !== -1 && byUsername !== -1);
  assert.ok(byUserId < byUsername);
});

test('a comparação do @ usa a mesma normalização da guarda de identidade', () => {
  // Divergir daqui faria os dois lados discordarem sobre o que é a mesma conta.
  // A guarda (migrations 113/155/158/318) usa exatamente esta expressao.
  assert.ok(takeover.includes("lower(nullif(trim(regexp_replace(p_username, '^@', '')), ''))"));
  assert.ok(takeover.includes("lower(trim(regexp_replace(username, '^@', ''))) = normalized_username"));
});

test('conexões concorrentes da mesma conta são serializadas', () => {
  // Dois celulares autorizando o mesmo @ ao mesmo tempo passariam os dois pela
  // busca e criariam duas linhas antes de qualquer índice reclamar.
  assert.match(takeover, /pg_advisory_xact_lock\(/);
  assert.match(takeover, /'meta_connect:' \|\| p_organization_id::text \|\| ':' \|\| normalized_username/);
  assert.equal(takeover.split('for update').length - 1, 2);
});

test('a escolha do alvo é explícita, sem coalesce sobre %rowtype', () => {
  // `select into` que não acha nada deixa a variável com todos os campos nulos,
  // e um composto assim pode passar por não-nulo num coalesce. Se passar, o
  // alvo encontrado pelo @ é descartado e a reconexão cria perfil novo — o
  // oposto exato do objetivo desta função.
  // Sem os comentários: o cabeçalho da migration cita o coalesce antigo para
  // explicar por que ele saiu, e uma busca no texto cru acusaria a explicação.
  const code = takeover.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /target := coalesce\(/);
  assert.ok(takeover.includes('if match_by_user_id.id is not null then'));
  assert.ok(takeover.includes('target := match_by_user_id;'));
  assert.ok(takeover.includes('elsif match_by_username.id is not null then'));
  assert.ok(takeover.includes('target := match_by_username;'));
});

test('@ repetido é recusado em vez de sorteado', () => {
  // `select into` com várias linhas não falha: pega uma qualquer.
  assert.match(takeover, /select count\(\*\) into username_match_count/);
  assert.match(takeover, /if username_match_count > 1 then/);
});

test('duas linhas disputando a mesma conta são recusadas, não fundidas', () => {
  assert.match(takeover, /'conflict'::text/);
  assert.match(takeover, /match_by_user_id\.id is distinct from match_by_username\.id/);
  // E a rota precisa parar nesse caso, em vez de seguir com um id nulo.
  assert.match(callback, /connectResult\.outcome === 'conflict'/);
  assert.match(callback, /'meta_profile_conflict'/);
});

test('a tomada limpa os vínculos da Zernio, como a restrição exige', () => {
  // instagram_profiles_provider_credentials_check proíbe meta_official com
  // zernio_account_id preenchido: sem limpar, todo UPDATE falharia.
  assert.match(takeover, /zernio_account_id = null/);
  assert.match(takeover, /zernio_profile_id = null/);
  assert.match(takeover, /zernio_connection_id = null/);
});

test('a identidade antiga é preservada em metadata antes de ser apagada', () => {
  for (const field of [
    'previous_provider',
    'previous_instagram_user_id',
    'previous_zernio_account_id',
    'previous_zernio_connection_id',
    'migrated_to_meta_at',
  ]) {
    assert.ok(takeover.includes(field), `metadata deveria guardar ${field}`);
  }
});

test('a tomada devolve o perfil para online e apaga o erro da transição', () => {
  // É isto que tira o perfil de /perfis "com erro" e o devolve para /postagem.
  assert.match(takeover, /status = 'online'/);
  assert.match(takeover, /last_error_code = null/);
  assert.match(takeover, /last_error_message = null/);
});

test('a marcação de transição só toca perfis Zernio ativos e é reversível', () => {
  assert.match(transition, /where provider = 'zernio'/);
  assert.match(transition, /and deleted_at is null/);
  // Nada de delete: é mudança de situação, não remoção.
  assert.doesNotMatch(transition, /delete from/i);
  // O código do erro é o que permite desfazer em massa depois.
  assert.match(transition, /last_error_code = 'zernio_provider_suspended'/);
});

test('a rota usa a RPC e não volta a gravar o perfil por conta própria', () => {
  assert.match(callback, /admin\.rpc\('connect_meta_instagram_profile'/);
  // O upsert antigo casava por instagram_user_id e por isso duplicava o perfil
  // Zernio, cujo valor nesse campo é sintético.
  assert.doesNotMatch(callback, /onConflict: 'organization_id,instagram_user_id'/);
});

test('a tela distingue tomada de conexão nova', () => {
  const client = readFileSync(
    new URL('../../app/perfis/profiles-client.tsx', import.meta.url),
    'utf8',
  );

  assert.match(client, /connectionResult\.connected === 'takeover'/);
  assert.match(client, /hist[oó]rico de views/i);
});
