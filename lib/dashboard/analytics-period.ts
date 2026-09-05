export type DashboardDailyMetric = {
  profile_id: string;
  date: string;
  posts: number;
  impressions: number;
  reach: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  interactions: number;
};

export type DashboardMetric = 'likes' | 'comments' | 'views' | 'reach' | 'shares' | 'saves' | 'interactions';

export type DashboardPeriodRange = {
  startDate: string;
  endDate: string;
  startIso: string;
  endIso: string;
};

const SAO_PAULO_TIME_ZONE = 'America/Sao_Paulo';

export function saoPauloDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SAO_PAULO_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * O período aceita duas formas, e a distinção é a razão de existir deste
 * comentário: número é JANELA ("3" = os últimos três dias, terminando hoje) e
 * palavra é DIA ISOLADO ("ontem" = só ontem).
 *
 * Antes disto, "2" e "3" significavam ontem e anteontem — números com
 * comportamento de palavra. Funcionou enquanto a tela só oferecia esses dois,
 * e quebrou no dia em que uma pílula "3 dias" foi adicionada: ela mostraria
 * anteontem sozinho, silenciosamente, porque o valor era o mesmo.
 */
export function dashboardPeriodRange(period: string, now = new Date()): DashboardPeriodRange {
  const today = saoPauloDateKey(now);
  const daysAgo = period === 'ontem' ? 1 : period === 'anteontem' ? 2 : 0;
  const calendarDays = daysAgo > 0 ? 1 : Math.max(1, Number(period) || 1);
  const endDate = shiftDateKey(today, -daysAgo);
  const startDate = shiftDateKey(endDate, -(calendarDays - 1));

  return {
    startDate,
    endDate,
    // As métricas diárias são indexadas por data civil de São Paulo. Estes
    // limites são mantidos somente para os registros que usam timestamptz.
    startIso: `${startDate}T00:00:00-03:00`,
    endIso: `${endDate}T23:59:59.999-03:00`,
  };
}

/**
 * A janela imediatamente anterior, do mesmo tamanho.
 *
 * É o que dá sentido à variação exibida ao lado de cada número: "-29%" só
 * significa alguma coisa contra um período comparável. Hoje compara com ontem;
 * 7 dias comparam com os 7 anteriores.
 */
export function previousPeriodRange(range: DashboardPeriodRange): DashboardPeriodRange {
  const days = Math.max(1, Math.round(
    (Date.parse(`${range.endDate}T12:00:00Z`) - Date.parse(`${range.startDate}T12:00:00Z`)) / 86_400_000,
  ) + 1);
  const endDate = shiftDateKey(range.startDate, -1);
  const startDate = shiftDateKey(endDate, -(days - 1));
  return {
    startDate,
    endDate,
    startIso: `${startDate}T00:00:00-03:00`,
    endIso: `${endDate}T23:59:59.999-03:00`,
  };
}

function shiftDateKey(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function filterDailyMetricsForPeriod(rows: DashboardDailyMetric[], profileIds: Set<string>, range: DashboardPeriodRange) {
  return rows.filter((row) => profileIds.has(row.profile_id) && row.date >= range.startDate && row.date <= range.endDate);
}

export function dailyMetricValue(row: DashboardDailyMetric, metric: DashboardMetric) {
  return row[metric];
}

export function sumDailyMetrics(rows: DashboardDailyMetric[]) {
  return rows.reduce((totals, row) => ({
    posts: totals.posts + row.posts,
    impressions: totals.impressions + row.impressions,
    reach: totals.reach + row.reach,
    views: totals.views + row.views,
    likes: totals.likes + row.likes,
    comments: totals.comments + row.comments,
    shares: totals.shares + row.shares,
    saves: totals.saves + row.saves,
    interactions: totals.interactions + row.interactions,
  }), { posts: 0, impressions: 0, reach: 0, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, interactions: 0 });
}

export function dailyMetricRanking(rows: DashboardDailyMetric[], profileIds: string[], metric: DashboardMetric) {
  const totals = new Map<string, number>(profileIds.map((profileId) => [profileId, 0]));
  rows.forEach((row) => totals.set(row.profile_id, (totals.get(row.profile_id) ?? 0) + dailyMetricValue(row, metric)));
  return totals;
}

export function buildDailyMetricTimeSeries(rows: DashboardDailyMetric[], metric: DashboardMetric) {
  const grouped = new Map<string, number>();
  rows.forEach((row) => grouped.set(row.date, (grouped.get(row.date) ?? 0) + dailyMetricValue(row, metric)));
  return Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b)).slice(-30).map(([label, value]) => ({ label: label.slice(5), value }));
}
