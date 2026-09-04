import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * A recuperação diagnostica QUEDA DE DESEMPENHO. Ela só faz sentido para quem
 * publica: um perfil impedido não caiu, está bloqueado — e o conserto é
 * reconectar, não trocar a estratégia de postagem dele.
 *
 * Sem este filtro, a primeira execução do cron das 09:20 depois da transição
 * para a API da Meta (migration 374) acusaria os 3.190 perfis parados de uma
 * vez, com um diagnóstico tecnicamente correto e operacionalmente inútil.
 */

const compute = readFileSync(
  new URL('../../supabase/migrations/378_recovery_judges_only_publishable_profiles.sql', import.meta.url),
  'utf8',
);
const original = readFileSync(
  new URL('../../supabase/migrations/348_recovery_compute.sql', import.meta.url),
  'utf8',
);

test('o pool de candidatos exige perfil que consegue publicar', () => {
  const pool = compute.slice(compute.indexOf('candidate_pool as ('), compute.indexOf('daily as ('));

  assert.match(pool, /and p\.status = 'online'/);
  assert.match(pool, /from public\.profile_group_members gm/);
});

test('a 348 original não tinha o filtro — é isto que a 378 corrige', () => {
  const pool = original.slice(original.indexOf('candidate_pool as ('), original.indexOf('daily as ('));

  assert.doesNotMatch(pool, /p\.status/);
});

test('a 378 recria a mesma função, sem trocar de nome nem de assinatura', () => {
  // Recriar com outro nome deixaria a versão antiga viva e ainda chamada pelo
  // dispatcher — o filtro existiria e não valeria para nada.
  const nome = 'create or replace function public.compute_recovery_analysis_group(';
  assert.ok(compute.includes(nome));

  const assinatura = (texto: string) => {
    const desde = texto.slice(texto.indexOf(nome));
    return desde.slice(0, desde.indexOf('returns')).replace(/\s+/g, ' ').trim();
  };

  assert.equal(assinatura(compute), assinatura(original));
});

test('nada além do filtro mudou em relação à 348', () => {
  // O corpo foi extraído por script justamente para não haver transcrição
  // manual de 318 linhas de SQL quente.
  const semComentarios = (texto: string) => texto
    .split('\n')
    .filter((linha) => !linha.trimStart().startsWith('--'))
    .filter((linha) => !/p\.status = 'online'/.test(linha))
    .map((linha) => linha.trimEnd())
    .filter(Boolean);

  const corpoNovo = semComentarios(
    compute.slice(compute.indexOf('create or replace function public.compute_recovery_analysis_group(')),
  );
  const corpoAntigo = semComentarios(
    original.slice(original.indexOf('create or replace function public.compute_recovery_analysis_group(')),
  );

  // A 348 continua depois desta função (há outras definições no arquivo), então
  // a comparação é do prefixo — o que importa é não haver divergência dentro.
  assert.deepEqual(corpoNovo.slice(0, corpoNovo.length - 1), corpoAntigo.slice(0, corpoNovo.length - 1));
});
