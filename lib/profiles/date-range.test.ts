import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_DATE_RANGE,
  addDays,
  addMonths,
  buildMonthGrid,
  buildPresets,
  describeRange,
  isCalendarDay,
  isDayInRange,
  isRangeComplete,
  normalizeDateRange,
  normalizeRange,
  previewRange,
  monthLabel,
  startOfMonth,
  todayInOrganizationTimeZone,
} from './date-range.ts';

test('dia só é válido se existir no calendário', () => {
  assert.equal(isCalendarDay('2026-08-27'), true);
  assert.equal(isCalendarDay('2024-02-29'), true);

  // 2026 não é bissexto, então 29/02 é tão inexistente quanto 30/02. O regex
  // sozinho deixaria os dois passarem até o Postgres recusar.
  assert.equal(isCalendarDay('2026-02-29'), false);
  assert.equal(isCalendarDay('2026-02-30'), false);
  assert.equal(isCalendarDay('2026-13-01'), false);
  assert.equal(isCalendarDay('27/08/2026'), false);
  assert.equal(isCalendarDay('2026-8-7'), false);
  assert.equal(isCalendarDay(null), false);
  assert.equal(isCalendarDay(20260827), false);
});

test('somar dias atravessa mês, ano e horário de verão sem escorregar', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');

  // Datas em que o Brasil já virou o relógio. Com Date local, um destes saltos
  // devolveria o mesmo dia ou pularia um.
  assert.equal(addDays('2018-11-03', 1), '2018-11-04');
  assert.equal(addDays('2019-02-16', 1), '2019-02-17');
});

test('somar meses prende ao último dia quando o mês alvo é mais curto', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2026-08-15', 1), '2026-09-15');
  assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
});

test('a grade tem seis semanas fixas e começa no domingo', () => {
  const grade = buildMonthGrid('2026-08-14');
  assert.equal(grade.length, 42);
  assert.equal(grade[0].iso, '2026-07-26');
  assert.equal(grade[0].inMonth, false);
  assert.equal(grade.at(-1)!.iso, '2026-09-05');

  const doMes = grade.filter((cell) => cell.inMonth);
  assert.equal(doMes.length, 31);
  assert.equal(doMes[0].iso, '2026-08-01');
  assert.equal(doMes.at(-1)!.iso, '2026-08-31');

  // Altura constante: fevereiro comum também ocupa seis semanas.
  assert.equal(buildMonthGrid('2026-02-10').length, 42);
});

test('intervalo se ordena sozinho quando a segunda ponta vem antes', () => {
  assert.deepEqual(normalizeRange('2026-08-29', '2026-08-26'), { from: '2026-08-26', to: '2026-08-29' });
  assert.deepEqual(normalizeRange('2026-08-26', '2026-08-29'), { from: '2026-08-26', to: '2026-08-29' });
  assert.deepEqual(normalizeRange('2026-08-26', '2026-08-26'), { from: '2026-08-26', to: '2026-08-26' });
});

test('pertencimento cobre as duas pontas e trata intervalo pela metade', () => {
  const intervalo = { from: '2026-08-26', to: '2026-08-29' };
  assert.equal(isDayInRange('2026-08-26', intervalo), true);
  assert.equal(isDayInRange('2026-08-29', intervalo), true);
  assert.equal(isDayInRange('2026-08-27', intervalo), true);
  assert.equal(isDayInRange('2026-08-25', intervalo), false);
  assert.equal(isDayInRange('2026-08-30', intervalo), false);

  // Só a primeira ponta escolhida: vale como dia único, não como tudo em diante.
  const meio = { from: '2026-08-26', to: null };
  assert.equal(isDayInRange('2026-08-26', meio), true);
  assert.equal(isDayInRange('2026-08-27', meio), false);
  assert.equal(isDayInRange('2026-08-26', EMPTY_DATE_RANGE), false);
});

test('a prévia acompanha o ponteiro nos dois sentidos', () => {
  assert.deepEqual(previewRange('2026-08-26', '2026-08-29'), { from: '2026-08-26', to: '2026-08-29' });
  assert.deepEqual(previewRange('2026-08-29', '2026-08-26'), { from: '2026-08-26', to: '2026-08-29' });
  assert.deepEqual(previewRange(null, '2026-08-26'), EMPTY_DATE_RANGE);
  assert.deepEqual(previewRange('2026-08-26', null), EMPTY_DATE_RANGE);
});

test('o rótulo só repete o ano quando os dois lados diferem', () => {
  assert.equal(describeRange(EMPTY_DATE_RANGE), 'Qualquer data');
  assert.equal(describeRange({ from: '2026-08-29', to: '2026-08-29' }), '29/08/2026');
  assert.equal(describeRange({ from: '2026-08-29', to: null }), '29/08/2026');
  assert.equal(describeRange({ from: '2026-08-26', to: '2026-08-29' }), '26/08 – 29/08/2026');
  assert.equal(describeRange({ from: '2025-12-30', to: '2026-01-02' }), '30/12/2025 – 02/01/2026');
});

test('atalhos partem do hoje da organização', () => {
  const atalhos = buildPresets('2026-08-31');
  assert.deepEqual(atalhos.map((p) => p.id), ['today', 'yesterday', 'last7', 'month']);
  assert.deepEqual(atalhos[0].range, { from: '2026-08-31', to: '2026-08-31' });
  assert.deepEqual(atalhos[1].range, { from: '2026-08-30', to: '2026-08-30' });

  // Sete dias contando o de hoje, não oito.
  assert.deepEqual(atalhos[2].range, { from: '2026-08-25', to: '2026-08-31' });
  assert.deepEqual(atalhos[3].range, { from: '2026-08-01', to: '2026-08-31' });
});

test('hoje sai no fuso da organização, não no do servidor', () => {
  // 01/09 às 01h UTC ainda é 31/08 em São Paulo.
  assert.equal(todayInOrganizationTimeZone(new Date('2026-09-01T01:00:00Z')), '2026-08-31');
  assert.equal(todayInOrganizationTimeZone(new Date('2026-09-01T04:00:00Z')), '2026-09-01');
});

test('intervalo inválido não vira filtro pela metade errada', () => {
  assert.deepEqual(normalizeDateRange({ from: '2026-02-30', to: '2026-08-29' }), { from: null, to: '2026-08-29' });
  assert.deepEqual(normalizeDateRange({ from: '2026-08-29', to: '2026-08-26' }), { from: '2026-08-26', to: '2026-08-29' });
  assert.deepEqual(normalizeDateRange(null), EMPTY_DATE_RANGE);
  assert.deepEqual(normalizeDateRange({}), EMPTY_DATE_RANGE);
  assert.equal(isRangeComplete({ from: '2026-08-26', to: null }), false);
  assert.equal(isRangeComplete({ from: '2026-08-26', to: '2026-08-29' }), true);
});

test('rótulo do mês e início do mês em português', () => {
  assert.equal(monthLabel('2026-08-14'), 'agosto de 2026');
  assert.equal(monthLabel('2026-03-01'), 'março de 2026');
  assert.equal(startOfMonth('2026-08-14'), '2026-08-01');
});
