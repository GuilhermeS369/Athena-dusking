import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExactDailySchedule,
  buildRepeatedPublicationSchedule,
  buildRecurringSchedule,
  captionExceedsMaximumLength,
  captionForIndex,
  captionsFromInput,
  distributeMediaBetweenProfiles,
  MAX_PUBLICATION_CAPTION_LENGTH,
  MAX_RECURRING_REPEAT_DAYS,
  mediaIsCompatible,
  normalizeDailyTimes,
  normalizeRecurringRepeatDays,
  normalizeSequenceRepeatCount,
  parseSaoPauloDateAndTime,
  recurringPublicationSlotCount,
  repeatMediaSequence,
  projectExactDailySequence,
  validateMediaForFormat,
} from './composer.ts';

test('preserva quebras de linha e emoji em uma legenda compartilhada', () => {
  const caption = 'VEJAM MEU STORYS 🚨\nTexto completo com acentuação: atenção.';
  const captions = captionsFromInput(caption, 'shared');

  assert.deepEqual(captions, [caption]);
  assert.equal(captionForIndex(captions, 0, 'shared'), caption);
  assert.equal(captionForIndex(captions, 12, 'shared'), caption);
});

test('separa uma legenda por linha somente no modo por postagem', () => {
  const captions = captionsFromInput('Primeira 🚨\nSegunda\nTerceira', 'per_post');

  assert.deepEqual(captions, ['Primeira 🚨', 'Segunda', 'Terceira']);
  assert.equal(captionForIndex(captions, 4, 'per_post'), 'Segunda');
});

test('aplica o limite de 2.200 unidades UTF-16 sem eliminar Unicode', () => {
  const withinLimit = `${'a'.repeat(MAX_PUBLICATION_CAPTION_LENGTH - 2)}🚨`;
  const aboveLimit = `${withinLimit}a`;

  assert.equal(withinLimit.length, MAX_PUBLICATION_CAPTION_LENGTH);
  assert.equal(captionExceedsMaximumLength(withinLimit), false);
  assert.equal(captionExceedsMaximumLength(aboveLimit), true);
});

test('agenda recorrente pula dias cujo bloco de dez minutos ja esta ocupado', () => {
  const now = new Date('2026-08-06T12:41:00.000Z'); // 09:41 em São Paulo.
  const occupied = [
    '2026-08-07T10:33:12.000Z', // 07:33 pertence ao horário-base 07:30.
    '2026-08-08T10:38:45.000Z',
    '2026-08-09T10:31:02.000Z',
  ];

  const schedule = buildRecurringSchedule(2, now, ['07:30'], occupied);

  assert.deepEqual(schedule, [
    '2026-08-10T10:30:00.000Z',
    '2026-08-11T10:30:00.000Z',
  ]);
});

test('agenda recorrente nao bloqueia outro horario-base do mesmo dia', () => {
  const now = new Date('2026-08-06T12:41:00.000Z');
  const occupied = ['2026-08-07T10:33:12.000Z'];

  const schedule = buildRecurringSchedule(2, now, ['07:30', '12:00'], occupied);

  assert.deepEqual(schedule, [
    '2026-08-06T15:00:00.000Z',
    '2026-08-07T15:00:00.000Z',
  ]);
});

test('repeticao distribui midias em ordem circular por horarios e dias', () => {
  const now = new Date('2026-08-12T09:00:00.000Z'); // 06:00 em São Paulo.
  const schedule = buildRepeatedPublicationSchedule(['midia 1', 'midia 2', 'midia 3'], now, ['08:00', '11:00', '13:00', '15:00'], 2);

  assert.deepEqual(schedule, [
    { media: 'midia 1', executeAt: '2026-08-12T11:00:00.000Z' },
    { media: 'midia 2', executeAt: '2026-08-12T14:00:00.000Z' },
    { media: 'midia 3', executeAt: '2026-08-12T16:00:00.000Z' },
    { media: 'midia 1', executeAt: '2026-08-12T18:00:00.000Z' },
    { media: 'midia 2', executeAt: '2026-08-13T11:00:00.000Z' },
    { media: 'midia 3', executeAt: '2026-08-13T14:00:00.000Z' },
    { media: 'midia 1', executeAt: '2026-08-13T16:00:00.000Z' },
    { media: 'midia 2', executeAt: '2026-08-13T18:00:00.000Z' },
  ]);
});

test('repeticao com uma midia repete a mesma postagem em todos os dias', () => {
  const now = new Date('2026-08-12T09:00:00.000Z');
  const schedule = buildRepeatedPublicationSchedule(['midia 1'], now, ['11:00'], 3);

  assert.deepEqual(schedule, [
    { media: 'midia 1', executeAt: '2026-08-12T14:00:00.000Z' },
    { media: 'midia 1', executeAt: '2026-08-13T14:00:00.000Z' },
    { media: 'midia 1', executeAt: '2026-08-14T14:00:00.000Z' },
  ]);
});

test('repeticao respeita horarios ocupados antes de continuar a fila circular', () => {
  const now = new Date('2026-08-12T09:00:00.000Z');
  const occupied = ['2026-08-12T11:04:00.000Z'];
  const schedule = buildRepeatedPublicationSchedule(['midia 1', 'midia 2'], now, ['08:00', '11:00'], 2, occupied);

  assert.deepEqual(schedule, [
    { media: 'midia 1', executeAt: '2026-08-12T14:00:00.000Z' },
    { media: 'midia 2', executeAt: '2026-08-13T11:00:00.000Z' },
    { media: 'midia 1', executeAt: '2026-08-13T14:00:00.000Z' },
    { media: 'midia 2', executeAt: '2026-08-14T11:00:00.000Z' },
  ]);
});

test('normaliza horarios recorrentes removendo duplicados, invalidos e ordenando o dia', () => {
  assert.deepEqual(
    normalizeDailyTimes(['18:00', '07:30', '18:00', '07:31', '24:00', '12:00']),
    ['07:30', '12:00', '18:00'],
  );
});

test('normaliza a repeticao atual entre um e 365 dias', () => {
  assert.equal(normalizeRecurringRepeatDays(0), 1);
  assert.equal(normalizeRecurringRepeatDays('3'), 3);
  assert.equal(normalizeRecurringRepeatDays(3.9), 3);
  assert.equal(normalizeRecurringRepeatDays(999), MAX_RECURRING_REPEAT_DAYS);
  assert.equal(normalizeRecurringRepeatDays('invalido'), 1);
});

test('calcula a quantidade do agendamento recorrente atual por horarios vezes dias', () => {
  assert.equal(recurringPublicationSlotCount(['07:30', '12:00', '18:00'], 3), 9);
  assert.equal(recurringPublicationSlotCount(['12:00', '12:00', '12:01'], 2), 2);
});

test('agenda somente horarios futuros e continua no dia seguinte', () => {
  const now = new Date('2026-08-12T17:30:00.000Z'); // 14:30 em São Paulo.

  assert.deepEqual(buildRecurringSchedule(3, now, ['08:00', '15:00']), [
    '2026-08-12T18:00:00.000Z',
    '2026-08-13T11:00:00.000Z',
    '2026-08-13T18:00:00.000Z',
  ]);
});

test('nao cria agendamento recorrente sem quantidade ou horario valido', () => {
  const now = new Date('2026-08-12T09:00:00.000Z');

  assert.deepEqual(buildRecurringSchedule(0, now, ['12:00']), []);
  assert.deepEqual(buildRecurringSchedule(2, now, ['12:01', 'invalido']), []);
  assert.deepEqual(buildRepeatedPublicationSchedule([], now, ['12:00'], 2), []);
});

test('converte data e horario de Sao Paulo para o instante UTC esperado', () => {
  assert.equal(parseSaoPauloDateAndTime('2026-08-12', '15:30'), '2026-08-12T18:30:00.000Z');
  assert.equal(parseSaoPauloDateAndTime('2026-02-30', '15:30'), null);
  assert.equal(parseSaoPauloDateAndTime('2026-08-12', '25:00'), null);
});

test('preserva a distribuicao sequencial atual entre perfis', () => {
  const distribution = distributeMediaBetweenProfiles(
    ['midia 1', 'midia 2', 'midia 3', 'midia 4', 'midia 5'],
    ['perfil 1', 'perfil 2'],
    'sequential',
  );

  assert.deepEqual([...distribution.entries()], [
    ['perfil 1', ['midia 1', 'midia 3', 'midia 5']],
    ['perfil 2', ['midia 2', 'midia 4']],
  ]);
});

test('preserva a distribuicao aleatoria atual com fonte de aleatoriedade controlada', () => {
  const randomValues = [0.5, 0, 0.75];
  const distribution = distributeMediaBetweenProfiles(
    ['midia 1', 'midia 2', 'midia 3', 'midia 4'],
    ['perfil 1', 'perfil 2'],
    'random',
    () => randomValues.shift() ?? 0,
  );

  assert.deepEqual([...distribution.entries()], [
    ['perfil 1', ['midia 4', 'midia 1']],
    ['perfil 2', ['midia 2', 'midia 3']],
  ]);
});

test('distribuicao repetir entrega a lista inteira e independente para cada perfil', () => {
  const distribution = distributeMediaBetweenProfiles(
    ['midia 1', 'midia 2', 'midia 3'],
    ['perfil 1', 'perfil 2'],
    'repeat',
  );

  assert.deepEqual([...distribution.entries()], [
    ['perfil 1', ['midia 1', 'midia 2', 'midia 3']],
    ['perfil 2', ['midia 1', 'midia 2', 'midia 3']],
  ]);
  distribution.get('perfil 1')?.push('alteração local');
  assert.deepEqual(distribution.get('perfil 2'), ['midia 1', 'midia 2', 'midia 3']);
});

test('repete sequencia completa preservando sua ordem em cada ciclo', () => {
  assert.deepEqual(repeatMediaSequence(['midia 1', 'midia 2'], 3), [
    'midia 1', 'midia 2', 'midia 1', 'midia 2', 'midia 1', 'midia 2',
  ]);
  assert.equal(normalizeSequenceRepeatCount(0), 1);
  assert.equal(normalizeSequenceRepeatCount('10'), 10);
});

test('agenda exata diaria preserva 09:00 e pula somente o dia ocupado', () => {
  const now = new Date('2026-08-12T10:00:00.000Z'); // 07:00 em São Paulo.
  const schedule = buildExactDailySchedule(3, now, '09:00', ['2026-08-13T12:00:00.000Z']);

  assert.deepEqual(schedule, [
    '2026-08-12T12:00:00.000Z',
    '2026-08-14T12:00:00.000Z',
    '2026-08-15T12:00:00.000Z',
  ]);
});

test('agenda exata inicia no proximo dia quando o horario de hoje ja passou', () => {
  const now = new Date('2026-08-12T13:01:00.000Z'); // 10:01 em São Paulo.
  assert.deepEqual(buildExactDailySchedule(1, now, '09:00'), ['2026-08-13T12:00:00.000Z']);
});

test('projecao de sequencia exata centraliza ordem, horarios e faixa', () => {
  const projection = projectExactDailySequence({
    media: ['mídia 1', 'mídia 2'],
    repeatCount: 3,
    now: new Date('2026-08-12T10:00:00.000Z'),
    time: '09:00',
  });

  assert.deepEqual(projection.media, ['mídia 1', 'mídia 2', 'mídia 1', 'mídia 2', 'mídia 1', 'mídia 2']);
  assert.equal(projection.executeAts.length, 6);
  assert.equal(projection.firstExecuteAt, '2026-08-12T12:00:00.000Z');
  assert.equal(projection.lastExecuteAt, '2026-08-17T12:00:00.000Z');
});

test('projecao suporta 10 midias por 10 ciclos sem perder a ordem', () => {
  const media = Array.from({ length: 10 }, (_, index) => `mídia ${index + 1}`);
  const projection = projectExactDailySequence({
    media,
    repeatCount: 10,
    now: new Date('2026-08-12T10:00:00.000Z'),
    time: '09:00',
  });

  assert.equal(projection.media.length, 100);
  assert.deepEqual(projection.media.slice(0, 10), media);
  assert.deepEqual(projection.media.slice(90), media);
  assert.equal(projection.executeAts.length, 100);
});

test('cenario de escala aprovado preserva 100 publicacoes por perfil em 55 destinos', () => {
  const media = Array.from({ length: 10 }, (_, index) => `mídia ${index + 1}`);
  const profiles = Array.from({ length: 55 }, (_, index) => `perfil ${index + 1}`);
  const distribution = distributeMediaBetweenProfiles(media, profiles, 'repeat');
  const publicationsPerProfile = repeatMediaSequence(distribution.get('perfil 55') ?? [], 10);

  assert.equal(distribution.size, 55);
  assert.equal(publicationsPerProfile.length, 100);
  assert.deepEqual(publicationsPerProfile.slice(0, 10), media);
  assert.deepEqual(publicationsPerProfile.slice(-10), media);
  assert.equal(publicationsPerProfile.length * profiles.length, 5_500);
});

test('mantem as regras atuais de compatibilidade entre formato e tipo de midia', () => {
  assert.equal(mediaIsCompatible('image', 'image'), true);
  assert.equal(mediaIsCompatible('image', 'video'), false);
  assert.equal(mediaIsCompatible('reel', 'video'), true);
  assert.equal(mediaIsCompatible('reel', 'image'), false);
  assert.equal(mediaIsCompatible('story', 'image'), true);
  assert.equal(mediaIsCompatible('story', 'video'), true);
});

test('valida a quantidade e o tipo de midia dos formatos atuais', () => {
  const image = { id: 'imagem', kind: 'image' as const };
  const video = { id: 'video', kind: 'video' as const };

  assert.equal(validateMediaForFormat('image', [image]), null);
  assert.equal(validateMediaForFormat('reel', [video]), null);
  assert.equal(validateMediaForFormat('story', [image]), null);
  assert.equal(validateMediaForFormat('carousel', [image, video]), null);
  assert.equal(validateMediaForFormat('image', []), 'Adicione pelo menos uma mídia.');
  assert.equal(validateMediaForFormat('reel', [image]), 'Reel aceita somente arquivos de vídeo.');
  assert.equal(validateMediaForFormat('carousel', [image]), 'Carrossel exige de 2 a 10 mídias.');
  assert.equal(validateMediaForFormat('story', [image, video]), 'Imagem, Reel e Story usam exatamente uma mídia por publicação.');
});
