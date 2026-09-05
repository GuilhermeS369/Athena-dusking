'use client';

import { useMemo, useState } from 'react';

/**
 * O gráfico da dashboard.
 *
 * POR QUE ESCRITO À MÃO. Um gráfico de área com eixo, grade, curva suave e
 * tooltip cabe em ~150 linhas de SVG. Uma biblioteca traria 40–120 KB para o
 * navegador, um segundo modelo de layout e uma dependência a mais para manter —
 * caro para um gráfico só.
 *
 * COMO ELE É RESPONSIVO SEM DISTORCER. O SVG usa `viewBox` fixo com
 * `preserveAspectRatio="none"`, então ele estica na horizontal conforme a
 * largura do cartão. Isso deformaria traços e texto, e por isso:
 *   * toda linha usa `vector-effect="non-scaling-stroke"` (espessura constante);
 *   * nenhum texto vive dentro do SVG — rótulos, ponto e tooltip são HTML
 *     posicionado por porcentagem, com a MESMA fórmula que posiciona o SVG.
 *
 * A interação é a parte que faltava na tela antiga: passar o mouse não fazia
 * nada, então o gráfico só servia para ver a forma. Aqui a faixa inteira é
 * sensível ao mouse, o ponto mais próximo acende e o tooltip diz o número —
 * que é o que se quer de um gráfico numa operação.
 */

export type ChartSeries = {
  key: string;
  label: string;
  color: string;
  points: Array<{ date: string; value: number }>;
};

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 300;

function formatNumber(value: number) {
  return new Intl.NumberFormat('pt-BR').format(value);
}

function formatCompact(value: number) {
  return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatDayLabel(date: string) {
  const [year, month, day] = date.split('-');
  return year && month && day ? `${day}/${month}` : date;
}

/**
 * Curva suave que não inventa valores.
 *
 * O caminho passa por cada ponto e usa o ponto médio entre vizinhos como
 * âncora da curva quadrática. Splines mais elaboradas (Catmull-Rom, por
 * exemplo) ficam mais bonitas e ultrapassam o valor real entre dois pontos —
 * num gráfico de operação isso é o mesmo que mentir por meio pixel.
 */
function smoothPath(coordinates: Array<{ x: number; y: number }>) {
  if (coordinates.length === 0) return '';
  if (coordinates.length === 1) return `M ${coordinates[0].x} ${coordinates[0].y}`;

  let path = `M ${coordinates[0].x} ${coordinates[0].y}`;
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    const midpointX = (previous.x + current.x) / 2;
    const midpointY = (previous.y + current.y) / 2;
    path += ` Q ${previous.x} ${previous.y} ${midpointX} ${midpointY}`;
  }
  const last = coordinates[coordinates.length - 1];
  path += ` L ${last.x} ${last.y}`;
  return path;
}

export function DashboardAreaChart({
  series,
  baseline = 'zero',
  empty = 'Sem dados no período selecionado',
  height = 240,
}: {
  series: ChartSeries[];
  /** `zero` para contagens (barra cheia é verdade); `auto` para seguidores. */
  baseline?: 'zero' | 'auto';
  empty?: string;
  height?: number;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const axis = useMemo(() => {
    const dates = [...new Set(series.flatMap((entry) => entry.points.map((point) => point.date)))].sort();
    const byDate = series.map((entry) => new Map(entry.points.map((point) => [point.date, point.value])));
    const values = series.flatMap((entry) => entry.points.map((point) => point.value));
    const maxValue = values.length ? Math.max(...values) : 0;
    const minValue = values.length ? Math.min(...values) : 0;
    const top = baseline === 'auto' && minValue > 0 ? maxValue + (maxValue - minValue) * 0.15 || maxValue * 1.1 : maxValue * 1.1;
    const bottom = baseline === 'auto' && minValue > 0 ? Math.max(0, minValue - (maxValue - minValue) * 0.15) : 0;
    return { dates, byDate, top: top || 1, bottom, maxValue, minValue };
  }, [series, baseline]);

  if (axis.dates.length === 0 || axis.maxValue === 0) {
    return <div className="dash-chart-empty" style={{ height }}>{empty}</div>;
  }

  const spread = Math.max(axis.top - axis.bottom, 1);
  const xFor = (index: number) => axis.dates.length === 1 ? VIEW_WIDTH / 2 : (index / (axis.dates.length - 1)) * VIEW_WIDTH;
  const yFor = (value: number) => VIEW_HEIGHT - ((value - axis.bottom) / spread) * VIEW_HEIGHT;
  const percentX = (index: number) => axis.dates.length === 1 ? 50 : (index / (axis.dates.length - 1)) * 100;
  const percentY = (value: number) => 100 - ((value - axis.bottom) / spread) * 100;

  const drawn = series.map((entry, seriesIndex) => {
    const coordinates = axis.dates.map((date, index) => ({
      x: xFor(index),
      y: yFor(axis.byDate[seriesIndex].get(date) ?? 0),
    }));
    return { entry, coordinates, line: smoothPath(coordinates) };
  });

  // Rótulos do eixo horizontal: no máximo seis, senão viram um borrão em
  // janelas de 30 ou 90 dias.
  const labelStep = Math.max(1, Math.ceil(axis.dates.length / 6));
  const gridValues = [axis.top, axis.bottom + spread / 2, axis.bottom];

  return (
    <div className="dash-chart" style={{ height }}>
      <div className="dash-chart-grid-labels" aria-hidden="true">
        {gridValues.map((value, index) => (
          <span key={index} style={{ top: `${percentY(value)}%` }}>{formatCompact(Math.round(value))}</span>
        ))}
      </div>

      <div className="dash-chart-plot">
        <svg viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={series.map((entry) => entry.label).join(' e ')}>
          <defs>
            {drawn.map(({ entry }) => (
              <linearGradient key={entry.key} id={`dash-fill-${entry.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={entry.color} stopOpacity="0.34" />
                <stop offset="100%" stopColor={entry.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {gridValues.map((value, index) => (
            <line
              key={index}
              x1="0"
              x2={VIEW_WIDTH}
              y1={yFor(value)}
              y2={yFor(value)}
              stroke="rgba(255,255,255,.07)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {drawn.map(({ entry, line, coordinates }) => (
            <g key={entry.key}>
              <path
                d={`${line} L ${coordinates[coordinates.length - 1].x} ${VIEW_HEIGHT} L ${coordinates[0].x} ${VIEW_HEIGHT} Z`}
                fill={`url(#dash-fill-${entry.key})`}
              />
              <path d={line} fill="none" stroke={entry.color} strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </g>
          ))}

          {hovered !== null && (
            <line
              x1={xFor(hovered)}
              x2={xFor(hovered)}
              y1="0"
              y2={VIEW_HEIGHT}
              stroke="rgba(255,255,255,.24)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {hovered !== null && drawn.map(({ entry }, seriesIndex) => (
          <span
            key={entry.key}
            className="dash-chart-dot"
            style={{
              left: `${percentX(hovered)}%`,
              top: `${percentY(axis.byDate[seriesIndex].get(axis.dates[hovered]) ?? 0)}%`,
              background: entry.color,
            }}
          />
        ))}

        {hovered !== null && (
          <div
            className="dash-chart-tooltip"
            style={{ left: `${percentX(hovered)}%`, transform: `translateX(${percentX(hovered) > 70 ? '-100%' : percentX(hovered) < 30 ? '0' : '-50%'})` }}
          >
            <strong>{formatDayLabel(axis.dates[hovered])}</strong>
            {drawn.map(({ entry }, seriesIndex) => (
              <span key={entry.key}>
                <i style={{ background: entry.color }} />
                {entry.label}
                <b>{formatNumber(axis.byDate[seriesIndex].get(axis.dates[hovered]) ?? 0)}</b>
              </span>
            ))}
          </div>
        )}

        {/* A faixa sensível cobre o gráfico inteiro: exigir mira no ponto exato
            é o tipo de detalhe que faz o usuário concluir que "não tem
            interação nenhuma". */}
        <div
          className="dash-chart-hit"
          onMouseLeave={() => setHovered(null)}
          onMouseMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - bounds.left) / Math.max(bounds.width, 1);
            setHovered(Math.min(axis.dates.length - 1, Math.max(0, Math.round(ratio * (axis.dates.length - 1)))));
          }}
        />
      </div>

      <div className="dash-chart-axis" aria-hidden="true">
        {axis.dates.map((date, index) => (
          index % labelStep === 0 || index === axis.dates.length - 1
            ? <span key={date} style={{ left: `${percentX(index)}%` }}>{formatDayLabel(date)}</span>
            : null
        ))}
      </div>
    </div>
  );
}
