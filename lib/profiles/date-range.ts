// Intervalo de datas do filtro "Adicionadas em".
//
// Tudo aqui trabalha com o dia como string YYYY-MM-DD, nunca com Date local. A
// aritmética é feita em UTC ao meio-dia: somar 1 dia num Date local atravessa
// horário de verão e devolve o mesmo dia (ou pula um) duas vezes por ano. Como
// o que interessa é o dia do calendário, UTC é a aritmética correta e não uma
// aproximação.
//
// A organização é fuso único — organizations.timezone tem CHECK fixando
// America/Sao_Paulo, e ORGANIZATION_TIME_ZONE em lib/publications/composer.ts
// repete a constante. "Hoje" tem de ser o de lá: depois das 21h em São Paulo o
// UTC já virou amanhã, e o seletor ofereceria um dia que ainda não existe para
// quem está usando o painel.

export const ORGANIZATION_TIME_ZONE = 'America/Sao_Paulo';

export type DateRange = { from: string | null; to: string | null };

export const EMPTY_DATE_RANGE: DateRange = { from: null, to: null };

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const MONTH_NAMES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

/** Iniciais dos dias, de domingo a sábado — a ordem em que a grade é montada. */
export const WEEKDAY_INITIALS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

/**
 * Aceita apenas YYYY-MM-DD que exista de fato. O regex sozinho deixaria passar
 * 2026-02-30, e o Postgres recusaria com erro de sintaxe no meio da consulta.
 */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && toIso(parsed) === value;
}

function toIso(date: Date) {
  return date.toISOString().slice(0, 10);
}

function atUtcNoon(iso: string) {
  return new Date(`${iso}T12:00:00Z`);
}

export function todayInOrganizationTimeZone(now: Date = new Date()) {
  // 'en-CA' formata como YYYY-MM-DD, que é exatamente o formato transportado.
  return new Intl.DateTimeFormat('en-CA', { timeZone: ORGANIZATION_TIME_ZONE }).format(now);
}

export function addDays(iso: string, days: number) {
  const date = atUtcNoon(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date);
}

export function addMonths(iso: string, months: number) {
  const date = atUtcNoon(iso);
  const targetMonth = date.getUTCMonth() + months;
  const anchor = new Date(Date.UTC(date.getUTCFullYear(), targetMonth, 1, 12));
  // 31/01 + 1 mês não pode virar 03/03: prende ao último dia do mês alvo.
  const lastDay = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0, 12)).getUTCDate();
  anchor.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return toIso(anchor);
}

export function startOfMonth(iso: string) {
  return `${iso.slice(0, 7)}-01`;
}

export function monthLabel(iso: string) {
  const date = atUtcNoon(iso);
  return `${MONTH_NAMES[date.getUTCMonth()]} de ${date.getUTCFullYear()}`;
}

export type CalendarCell = { iso: string; day: number; inMonth: boolean };

/**
 * Seis semanas fixas de domingo a sábado. Altura constante evita o calendário
 * pular de tamanho ao trocar de mês, que é o tipo de sobressalto que faz a
 * pessoa errar o clique.
 */
export function buildMonthGrid(anchorIso: string): CalendarCell[] {
  const first = atUtcNoon(startOfMonth(anchorIso));
  const month = first.getUTCMonth();
  const start = addDays(toIso(first), -first.getUTCDay());
  return Array.from({ length: 42 }, (_, index) => {
    const iso = addDays(start, index);
    const date = atUtcNoon(iso);
    return { iso, day: date.getUTCDate(), inMonth: date.getUTCMonth() === month };
  });
}

export function normalizeRange(a: string, b: string): DateRange {
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

export function isRangeComplete(range: DateRange): range is { from: string; to: string } {
  return Boolean(range.from && range.to);
}

export function isDayInRange(iso: string, range: DateRange) {
  if (!range.from) return false;
  const to = range.to ?? range.from;
  return iso >= range.from && iso <= to;
}

/** Dia que fecharia o intervalo se a pessoa clicasse onde o ponteiro está. */
export function previewRange(anchor: string | null, hovered: string | null): DateRange {
  if (!anchor || !hovered) return EMPTY_DATE_RANGE;
  return normalizeRange(anchor, hovered);
}

function formatDay(iso: string, withYear: boolean) {
  const [year, month, day] = iso.split('-');
  return withYear ? `${day}/${month}/${year}` : `${day}/${month}`;
}

export function describeRange(range: DateRange) {
  if (!range.from && !range.to) return 'Qualquer data';
  if (range.from && range.to && range.from !== range.to) {
    // O ano só aparece nos dois lados quando eles diferem; repetir "2026" duas
    // vezes num intervalo do mesmo ano só rouba largura do botão.
    const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
    return `${formatDay(range.from, !sameYear)} – ${formatDay(range.to, true)}`;
  }
  return formatDay((range.from ?? range.to)!, true);
}

export type DateRangePreset = { id: string; label: string; range: DateRange };

export function buildPresets(today: string): DateRangePreset[] {
  return [
    { id: 'today', label: 'Hoje', range: { from: today, to: today } },
    { id: 'yesterday', label: 'Ontem', range: { from: addDays(today, -1), to: addDays(today, -1) } },
    { id: 'last7', label: '7 dias', range: { from: addDays(today, -6), to: today } },
    { id: 'month', label: 'Este mês', range: { from: startOfMonth(today), to: today } },
  ];
}

export function rangesAreEqual(a: DateRange, b: DateRange) {
  return a.from === b.from && a.to === b.to;
}

/** Só um intervalo com as duas pontas válidas vira filtro. */
export function normalizeDateRange(input: Partial<DateRange> | null | undefined): DateRange {
  const from = isCalendarDay(input?.from) ? input!.from as string : null;
  const to = isCalendarDay(input?.to) ? input!.to as string : null;
  if (from && to) return normalizeRange(from, to);
  return { from, to };
}
