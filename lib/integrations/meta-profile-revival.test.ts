import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Reconectar uma conta excluída pelo operador reativa a mesma linha
 * (migration 440). Até ali a reconexão falhava com 23505 para qualquer perfil
 * Meta excluído, porque a unicidade do id da Meta contava as linhas apagadas.
 *
 * Como em meta-profile-takeover.test.ts, estes testes leem o SQL: o que precisa
 * ficar garantido são invariantes da função e das duas remoções reemitidas, não
 * o retorno de uma chamada.
 */

const migration = readFileSync(
  new URL('../../supabase/migrations/440_meta_reconnect_revives_operator_removed_profile.sql', import.meta.url),
  'utf8',
);
const callback = readFileSync(
  new URL('../../app/api/integrations/meta/callback/route.ts', import.meta.url),
  'utf8',
);
const client = readFileSync(
  new URL('../../app/perfis/profiles-client.tsx', import.meta.url),
  'utf8',
);

function functionBody(name: string) {
  const start = migration.indexOf(`create or replace function public.${name}(`);
  assert.ok(start !== -1, `a 440 deveria reemitir ${name}`);
  const end = migration.indexOf('\n$$;', start);
  assert.ok(end > start);
  return migration.slice(start, end);
}

// Sem comentários: o cabeçalho explica o que saiu, e a busca no texto cru
// acusaria a explicação.
const code = (text: string) => text.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');

const connect = code(functionBody('connect_meta_instagram_profile'));
const operatorRemoval = code(functionBody('enqueue_instagram_profile_removal'));
const checkpointRemoval = code(functionBody('finalize_meta_profile_disconnection_for_profile'));

test('a unicidade do id da Meta vale só entre vivos, e a da Zernio continua inteira', () => {
  assert.match(migration, /drop constraint if exists instagram_profiles_organization_id_instagram_user_id_key/);
  assert.match(
    migration,
    /on public\.instagram_profiles \(organization_id, instagram_user_id\)\s+where deleted_at is null or instagram_user_id like 'zernio:%'/,
  );
});

test('só a exclusão pelo operador é reativada; o resto vira perfil novo', () => {
  assert.match(connect, /removed_row\.last_error_code = 'profile_removed_by_operator'/);
  assert.match(connect, /removed_row\.provider = 'meta_official'/);
  // A linha apagada é achada pelo id da Meta, nunca pelo @ (que pode ter sido
  // reaproveitado por outra conta).
  const deadLookup = connect.slice(connect.indexOf('select * into removed_row'), connect.indexOf('for update;', connect.indexOf('select * into removed_row')));
  assert.match(deadLookup, /dead\.instagram_user_id = p_instagram_user_id/);
  assert.match(deadLookup, /dead\.deleted_at is not null/);
  assert.doesNotMatch(deadLookup, /username/);
  // Continua existindo um único insert: o do perfil novo.
  assert.equal(connect.split('insert into public.instagram_profiles').length - 1, 1);
});

test('a linha apagada só é procurada quando não há perfil vivo', () => {
  const liveResolution = connect.indexOf('target := match_by_username;');
  const deadLookup = connect.indexOf('select * into removed_row');
  assert.ok(liveResolution !== -1 && deadLookup > liveResolution);
  assert.match(connect, /if target\.id is null then\s+select \* into removed_row/);
});

test('a reativação volta a mesma linha: update com deleted_at nulo e desfecho restored', () => {
  assert.match(connect, /when target\.deleted_at is not null then 'restored'/);
  const update = connect.slice(connect.indexOf('update public.instagram_profiles set'));
  assert.match(update, /deleted_at = null/);
  assert.match(update, /where id = target\.id;/);
});

test('a reativação não grava troca de app: o incidente já segura a vaga antiga', () => {
  const transferInsert = connect.indexOf('insert into public.meta_profile_app_transfers');
  const guard = connect.lastIndexOf("resolved_outcome <> 'restored'", transferInsert);
  assert.ok(transferInsert !== -1 && guard !== -1);
});

test('a volta encerra o incidente e libera a vaga só quando é o mesmo app', () => {
  const incidentUpdate = connect.slice(
    connect.indexOf('update public.meta_profile_disconnection_incidents incident set'),
    connect.indexOf('if target.id is null then\n    insert'),
  );
  assert.match(incidentUpdate, /reconnected_at = timezone\('utc', now\(\)\)/);
  assert.match(incidentUpdate, /incident\.meta_app_id = p_meta_app_id/);
  assert.match(incidentUpdate, /else incident\.slot_released_at/);
  assert.match(incidentUpdate, /incident\.reconnected_at is null/);
  // Roda antes do insert e do update, então vale para created e restored.
  assert.ok(connect.indexOf('update public.meta_profile_disconnection_incidents') < connect.indexOf('insert into public.instagram_profiles'));
});

test('as métricas voltam só a partir da exclusão, sem ressuscitar reparo antigo', () => {
  assert.match(connect, /snapshot\.deleted_at >= target\.deleted_at/);
  assert.match(connect, /follower\.deleted_at >= target\.deleted_at/);
});

test('as duas remoções apontam o on conflict para o incidente em aberto', () => {
  // Sem repetir a condição do índice parcial, o on conflict não o reconhece e
  // a remoção inteira falha com 42P10 assim que a constraint antiga sai.
  assert.match(migration, /on public\.meta_profile_disconnection_incidents \(organization_id, profile_id\)\s+where reconnected_at is null/);
  assert.match(migration, /drop constraint if exists meta_profile_disconnection_incid_organization_id_profile_id_key/);
  assert.match(operatorRemoval, /on conflict \(organization_id, profile_id\) where reconnected_at is null do nothing;/);
  assert.match(checkpointRemoval, /on conflict \(organization_id, profile_id\) where reconnected_at is null do update/);
  assert.doesNotMatch(checkpointRemoval, /on conflict \(organization_id, profile_id\) do /);
  // Na remoção pelo operador sobra um único on conflict sem a condição: o do
  // incidente da Zernio, outra tabela, que continua como estava.
  const bare = operatorRemoval.split('on conflict (organization_id, profile_id) do ').length - 1;
  assert.equal(bare, 1);
  const zernioInsert = operatorRemoval.indexOf('insert into public.zernio_profile_disconnection_incidents');
  const bareIndex = operatorRemoval.indexOf('on conflict (organization_id, profile_id) do ');
  assert.ok(zernioInsert !== -1 && bareIndex > zernioInsert);
  assert.ok(bareIndex < operatorRemoval.indexOf('insert into public.meta_profile_disconnection_incidents'));
});

test('o callback e a tela reconhecem a reativação', () => {
  assert.match(callback, /'created' \| 'updated' \| 'takeover' \| 'restored',/);
  assert.match(callback, /'created' \| 'updated' \| 'takeover' \| 'restored' \| 'conflict'/);
  assert.match(client, /connectionResult\.connected === 'restored'/);
  assert.match(client, /volta sem grupos/);
});
