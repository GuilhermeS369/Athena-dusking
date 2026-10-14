'use client';

import { useEffect, useMemo, useState } from 'react';

import { accountFlowFallRate, accountFlowReasonCode, accountFlowReasonLabel, mergeAccountFlowReasons, mergeDayReasons } from '@/lib/dashboard/account-flow';
import { saoPauloDateKey } from '@/lib/dashboard/analytics-period';
import type { DashboardAccountFlow, DashboardAccountFlowReason } from '@/lib/dashboard/v2-types';

/**
 * Plugadas × caídas por dia, com o motivo de cada queda.
 *
 * Pedido em 14/10/2026, depois da onda de 13/10: a operação quer saber quanto
 * entra e quanto cai por dia na organização inteira — não precisam ser as
 * mesmas contas — e por quê cada uma caiu. Por isso o cartão tem período
 * próprio e ignora os filtros de perfil e grupo de cima: uma conta caída já
 * saiu do grupo, e o "quanto cai por dia" não muda com o perfil escolhido.
 *
 * Gráfico de barras pareadas em HTML, sem SVG: são duas barras por dia e um
 * tooltip, e cada barra já é um elemento que recebe o hover. O mesmo dado
 * aparece em tabela para quem quer o número exato de cada dia.
 */

const FLOW_PERIODS = [
  { days: 7, label: '7 dias' },
  { days: 15, label: '15 dias' },
  { days: 30, label: '30 dias' },
  { days: 90, label: '90 dias' },
];

const FLOW_COLORS = { connected: '#2dd4bf', fallen: '#fb7185' };

type FlowView = 'chart' | 'table';

export function DashboardAccountFlowSection({ organizationId }: { organizationId: string }) {
  const [days, setDays] = useState(15);
  const [view, setView] = useState<FlowView>('chart');
  const [flow, setFlow] = useState<DashboardAccountFlow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const end = saoPauloDateKey();
    const params = new URLSearchParams({ start: shiftDay(end, -(days - 1)), end });
    setLoading(true);
    setError('');
    fetch(`/api/dashboard/account-flow?${params}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { flow?: DashboardAccountFlow; error?: string };
        if (!response.ok || !payload.flow) throw new Error(payload.error ?? 'Plugadas e quedas indisponíveis.');
        setFlow(payload.flow);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Plugadas e quedas indisponíveis.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [days, organizationId]);

  const merged = useMemo(() => mergeAccountFlowReasons(flow?.reasons ?? []), [flow]);
  const reasonsByKey = useMemo(() => new Map(merged.reasons.map((reason) => [reason.key, reason])), [merged]);
  const totals = flow?.totals ?? { connected: 0, fallen: 0, removed: 0 };
  const balance = totals.connected - totals.fallen;
  const rate = accountFlowFallRate(totals.connected, totals.fallen);
  const today = flow?.days[flow.days.length - 1];

  return <section className="dash-flow" aria-label="Contas plugadas e caídas" aria-busy={loading}>
    <header className="dash-flow-head">
      <div>
        <h2>Contas plugadas × caídas {loading && <span className="analytics-header-spinner" role="status" aria-label="Carregando" />}</h2>
        <p>Organização inteira · dia de Brasília · as contas que caem não precisam ser as que entraram</p>
      </div>
      <div className="dash-flow-controls">
        <div className="dash-pills" role="group" aria-label="Período do cartão">
          {FLOW_PERIODS.map((period) => <button
            key={period.days}
            type="button"
            className={period.days === days ? 'dash-pill dash-pill-active' : 'dash-pill'}
            aria-pressed={period.days === days}
            onClick={() => setDays(period.days)}
          >{period.label}</button>)}
        </div>
        <div className="dash-pills" role="group" aria-label="Formato">
          <button type="button" className={view === 'chart' ? 'dash-pill dash-pill-active' : 'dash-pill'} aria-pressed={view === 'chart'} onClick={() => setView('chart')}>Gráfico</button>
          <button type="button" className={view === 'table' ? 'dash-pill dash-pill-active' : 'dash-pill'} aria-pressed={view === 'table'} onClick={() => setView('table')}>Tabela</button>
        </div>
      </div>
    </header>

    {error && !flow
      ? <p className="dash-flow-error" role="alert">{error}</p>
      : <>
        <div className="dash-flow-kpis">
          <FlowKpi label="Plugadas" value={formatNumber(totals.connected)} detail={today ? `hoje ${formatNumber(today.connected)}` : undefined} tone="connected" />
          <FlowKpi label="Caídas" value={formatNumber(totals.fallen)} detail={today ? `hoje ${formatNumber(today.fallen)}` : undefined} tone="fallen" />
          <FlowKpi label="Saldo" value={`${balance > 0 ? '+' : ''}${formatNumber(balance)}`} detail="plugadas − caídas" tone={balance >= 0 ? 'connected' : 'fallen'} />
          <FlowKpi label="Caem a cada 100 plugadas" value={rate === null ? '—' : formatNumber(Math.round(rate))} detail={rate === null ? 'nenhuma plugada no período' : `${formatNumber(totals.fallen)} ÷ ${formatNumber(totals.connected)}`} />
          <FlowKpi label="Ativas agora" value={flow ? formatNumber(flow.online_now) : '—'} detail={totals.removed ? `${formatNumber(totals.removed)} removidas pelo operador no período` : 'online na organização'} />
        </div>

        <div className="dash-flow-body">
          <div className="dash-flow-main">
            {view === 'chart'
              ? <FlowChart days={flow?.days ?? []} reasonsByKey={reasonsByKey} groupOf={merged.groupOf} />
              : <FlowTable days={flow?.days ?? []} reasonsByKey={reasonsByKey} groupOf={merged.groupOf} />}
          </div>
          <FlowReasons reasons={merged.reasons} />
        </div>
      </>}
  </section>;
}

function FlowKpi({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: 'connected' | 'fallen' }) {
  return <div className={tone ? `dash-flow-kpi dash-flow-kpi-${tone}` : 'dash-flow-kpi'}>
    <span>{label}</span>
    <strong>{value}</strong>
    {detail && <small>{detail}</small>}
  </div>;
}

type FlowDay = DashboardAccountFlow['days'][number];

function FlowChart({ days, reasonsByKey, groupOf }: { days: FlowDay[]; reasonsByKey: Map<string, DashboardAccountFlowReason>; groupOf: Map<string, string> }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((day) => Math.max(day.connected, day.fallen)));
  // Rótulo de data em no máximo ~10 colunas: com 90 dias, um por coluna vira
  // uma faixa ilegível.
  const labelEvery = Math.max(1, Math.ceil(days.length / 10));

  if (!days.some((day) => day.connected > 0 || day.fallen > 0)) {
    return <div className="dash-flow-chart dash-chart-empty">Nenhuma conta plugada ou caída neste período</div>;
  }

  const active = hovered === null ? null : days[hovered];

  return <div className="dash-flow-chart" onMouseLeave={() => setHovered(null)}>
    <div className="dash-flow-scale" aria-hidden="true"><span>{formatNumber(max)}</span><span>{formatNumber(Math.round(max / 2))}</span><span>0</span></div>
    <div className="dash-flow-columns" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
      {days.map((day, index) => <div
        key={day.date}
        className={hovered === index ? 'dash-flow-col dash-flow-col-active' : 'dash-flow-col'}
        onMouseEnter={() => setHovered(index)}
        onFocus={() => setHovered(index)}
        tabIndex={0}
        aria-label={`${formatDay(day.date)}: ${day.connected} plugadas, ${day.fallen} caídas`}
      >
        <div className="dash-flow-bars">
          <i style={{ height: `${(day.connected / max) * 100}%`, background: FLOW_COLORS.connected }} />
          <i style={{ height: `${(day.fallen / max) * 100}%`, background: FLOW_COLORS.fallen }} />
        </div>
        <small>{index % labelEvery === 0 || index === days.length - 1 ? formatDay(day.date) : ''}</small>
      </div>)}
    </div>
    {active && hovered !== null && <div
      className="dash-flow-tooltip"
      // A área das colunas começa depois dos 38px da escala. Na metade da
      // direita o balão abre para a esquerda, para não sair do cartão.
      style={hovered >= days.length / 2
        ? { right: `calc((100% - 38px) * ${(days.length - hovered) / days.length} + 6px)` }
        : { left: `calc(38px + (100% - 38px) * ${(hovered + 1) / days.length} + 6px)` }}
    >
      <strong>{formatDay(active.date, true)}</strong>
      <span><i style={{ background: FLOW_COLORS.connected }} />Plugadas<b>{formatNumber(active.connected)}</b></span>
      <span><i style={{ background: FLOW_COLORS.fallen }} />Caídas<b>{formatNumber(active.fallen)}</b></span>
      <span>Saldo<b>{signed(active.connected - active.fallen)}</b></span>
      {mergeDayReasons(active.by_reason, groupOf).map(([key, total]) => {
        const reason = reasonsByKey.get(key);
        return <em key={key}>{reason ? accountFlowReasonLabel(reason) : key}<b>{formatNumber(total)}</b></em>;
      })}
    </div>}
    <div className="dash-legend dash-flow-legend">
      <span><i style={{ background: FLOW_COLORS.connected }} />Plugadas</span>
      <span><i style={{ background: FLOW_COLORS.fallen }} />Caídas</span>
    </div>
  </div>;
}

function FlowTable({ days, reasonsByKey, groupOf }: { days: FlowDay[]; reasonsByKey: Map<string, DashboardAccountFlowReason>; groupOf: Map<string, string> }) {
  // Mais recente em cima: quem abre a tabela quer ver hoje e ontem primeiro.
  const rows = [...days].reverse();
  return <div className="dash-flow-table-wrap">
    <table className="dash-flow-table">
      <thead><tr><th>Dia</th><th>Plugadas</th><th>Caídas</th><th>Saldo</th><th>Caem a cada 100</th><th>Motivos</th></tr></thead>
      <tbody>{rows.map((day) => {
        const rate = accountFlowFallRate(day.connected, day.fallen);
        const reasons = mergeDayReasons(day.by_reason, groupOf);
        return <tr key={day.date}>
          <td>{formatDay(day.date, true)}</td>
          <td className="dash-flow-num dash-flow-num-connected">{formatNumber(day.connected)}</td>
          <td className="dash-flow-num dash-flow-num-fallen">{formatNumber(day.fallen)}</td>
          <td className={day.connected - day.fallen >= 0 ? 'dash-flow-num dash-flow-num-connected' : 'dash-flow-num dash-flow-num-fallen'}>{signed(day.connected - day.fallen)}</td>
          <td className="dash-flow-num">{rate === null ? '—' : formatNumber(Math.round(rate))}</td>
          <td className="dash-flow-reasons-cell">{reasons.length
            ? reasons.map(([key, total]) => {
              const reason = reasonsByKey.get(key);
              return <span key={key}>{reason ? accountFlowReasonLabel(reason) : key} <b>{formatNumber(total)}</b></span>;
            })
            : '—'}</td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

function FlowReasons({ reasons }: { reasons: DashboardAccountFlowReason[] }) {
  const falls = reasons.filter((reason) => reason.is_fall);
  const removals = reasons.filter((reason) => !reason.is_fall);
  const totalFalls = falls.reduce((sum, reason) => sum + reason.total, 0);
  const max = Math.max(1, ...falls.map((reason) => reason.total));
  return <aside className="dash-flow-reasons" aria-label="Motivos das quedas">
    <h3>Por que caíram</h3>
    {falls.length === 0
      ? <p className="dash-card-empty">Nenhuma queda no período</p>
      : <div className="dash-bars">{falls.map((reason) => {
        const code = accountFlowReasonCode(reason);
        return <div key={reason.key} title={reason.sample_message ?? undefined}>
          <span>{accountFlowReasonLabel(reason)}{code && <i className="dash-flow-code">{code}</i>}</span>
          <strong>{formatNumber(reason.total)}</strong>
          <small>{sharePercent(reason.total, totalFalls)}</small>
          <em><i style={{ width: `${Math.max(2, (reason.total / max) * 100)}%`, background: FLOW_COLORS.fallen }} /></em>
        </div>;
      })}</div>}
    {removals.length > 0 && <div className="dash-card-foot">
      {removals.map((reason) => <span key={reason.key}>{accountFlowReasonLabel(reason)} <b>{formatNumber(reason.total)}</b></span>)}
    </div>}
    <small className="dash-flow-hint">Passe o mouse num motivo para ver a mensagem da Meta.</small>
  </aside>;
}

function shiftDay(date: string, days: number) {
  const moment = new Date(`${date}T12:00:00Z`);
  moment.setUTCDate(moment.getUTCDate() + days);
  return moment.toISOString().slice(0, 10);
}

function formatDay(date: string, withWeekday = false) {
  const [year, month, day] = date.split('-');
  if (!withWeekday || !year) return `${day}/${month}`;
  const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'UTC' }).replace('.', '');
  return `${weekday} ${day}/${month}`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('pt-BR').format(value);
}

/** "0%" para uma queda em duas mil diria que ela não aconteceu. */
function sharePercent(part: number, total: number) {
  if (total <= 0) return '—';
  const percent = (part / total) * 100;
  return part > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`;
}

function signed(value: number) {
  return `${value > 0 ? '+' : ''}${formatNumber(value)}`;
}
