import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatNumber, percent } from '../format';
import { IconChart, IconTable } from './icons';

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(240, entries[0].contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function niceMax(value: number): { max: number; step: number } {
  if (value <= 0) return { max: 4, step: 1 };
  const rough = value / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude;
  return { max: Math.ceil(value / step) * step, step: Math.max(step, 1) };
}

/** Column with a 4px rounded data-end and a square baseline. */
function columnPath(x: number, y: number, width: number, height: number): string {
  if (height <= 0) return '';
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

export interface Series {
  key: string;
  label: string;
  color: string;
}

function ViewToggle({ table, onChange }: { table: boolean; onChange: (table: boolean) => void }) {
  return (
    <button type="button" className="btn ghost sm" onClick={() => onChange(!table)} aria-label={table ? 'Show chart' : 'Show table'}>
      {table ? <IconChart size={15} /> : <IconTable size={15} />}
      {table ? 'Chart' : 'Table'}
    </button>
  );
}

/**
 * Grouped column chart over ordered categories (days, hours). One y-axis, hairline grid, legend
 * whenever there are two or more series, a per-category tooltip listing every series, and a table
 * view carrying the same numbers.
 */
export function ColumnChart<T extends Record<string, number | string>>({
  data,
  categoryKey,
  series,
  formatCategory,
  height = 220,
  toolbar,
}: {
  data: T[];
  categoryKey: keyof T & string;
  series: Series[];
  formatCategory: (value: string, long?: boolean) => string;
  height?: number;
  toolbar?: ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const margin = { top: 12, right: 8, bottom: 26, left: 40 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const maxValue = Math.max(0, ...data.flatMap(d => series.map(s => Number(d[s.key]) || 0)));
  const { max, step } = niceMax(maxValue);
  const band = data.length ? plotW / data.length : plotW;
  const gap = 2;
  const barW = Math.max(2, Math.min(24, (band * 0.7 - gap * (series.length - 1)) / series.length));
  const groupW = barW * series.length + gap * (series.length - 1);
  const y = (v: number) => margin.top + plotH - (v / max) * plotH;
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);
  const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(plotW / 56)));

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row between wrap">
        {series.length > 1 ? (
          <div className="legend">
            {series.map(s => (
              <span key={s.key}>
                <span className="swatch" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        ) : (
          <span />
        )}
        <div className="row">
          {toolbar}
          <ViewToggle table={table} onChange={setTable} />
        </div>
      </div>
      {table ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                {series.map(s => (
                  <th key={s.key} className="num">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map(d => (
                <tr key={String(d[categoryKey])}>
                  <td>{formatCategory(String(d[categoryKey]), true)}</td>
                  {series.map(s => (
                    <td key={s.key} className="num">
                      {formatNumber(Number(d[s.key]))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="viz" ref={ref} onMouseLeave={() => setHover(null)}>
          <svg height={height} role="img" aria-label={`${series.map(s => s.label).join(' and ')} by ${categoryKey}`}>
            {ticks.map(t => (
              <g key={t}>
                <line className={t === 0 ? 'baseline' : 'gridline'} x1={margin.left} x2={width - margin.right} y1={y(t)} y2={y(t)} />
                <text className="tick" x={margin.left - 8} y={y(t) + 4} textAnchor="end">
                  {formatNumber(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const x0 = margin.left + i * band + (band - groupW) / 2;
              return (
                <g key={String(d[categoryKey])}>
                  {series.map((s, k) => {
                    const value = Number(d[s.key]) || 0;
                    const top = y(value);
                    return (
                      <path
                        key={s.key}
                        className={`bar ${hover === i ? 'hover' : ''}`}
                        d={columnPath(x0 + k * (barW + gap), top, barW, margin.top + plotH - top)}
                        fill={s.color}
                      />
                    );
                  })}
                  {i % labelEvery === 0 && (
                    <text className="tick" x={margin.left + i * band + band / 2} y={height - 8} textAnchor="middle">
                      {formatCategory(String(d[categoryKey]))}
                    </text>
                  )}
                  <rect
                    className="hit"
                    x={margin.left + i * band}
                    y={margin.top}
                    width={band}
                    height={plotH}
                    tabIndex={0}
                    aria-label={`${formatCategory(String(d[categoryKey]), true)}: ${series.map(s => `${s.label} ${d[s.key]}`).join(', ')}`}
                    onMouseEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                  />
                </g>
              );
            })}
          </svg>
          {hover !== null && data[hover] && (
            <div
              className="viz-tooltip"
              style={{ left: Math.min(Math.max(margin.left + hover * band + band / 2, 80), width - 80), top: margin.top + 4, transform: 'translate(-50%, 0)' }}
            >
              <div className="t-title">{formatCategory(String(data[hover][categoryKey]), true)}</div>
              {series.map(s => (
                <div className="t-row" key={s.key}>
                  <span className="key-line" style={{ background: s.color }} />
                  <strong>{formatNumber(Number(data[hover][s.key]))}</strong>
                  <span className="secondary">{s.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Ordered funnel stages as horizontal bars on a validated one-hue ordinal ramp. */
export function Funnel({ stages }: { stages: Array<{ label: string; value: number; hint?: string }> }) {
  const [table, setTable] = useState(false);
  const base = stages[0]?.value ?? 0;
  const max = Math.max(1, ...stages.map(s => s.value));
  const colors = ['var(--viz-funnel-1)', 'var(--viz-funnel-2)', 'var(--viz-funnel-3)', 'var(--viz-funnel-4)', 'var(--viz-funnel-5)'];
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row between">
        <span className="small muted">Share of messages sent</span>
        <ViewToggle table={table} onChange={setTable} />
      </div>
      {table ? (
        <table className="table">
          <thead>
            <tr>
              <th>Stage</th>
              <th className="num">Count</th>
              <th className="num">Of sent</th>
            </tr>
          </thead>
          <tbody>
            {stages.map(s => (
              <tr key={s.label}>
                <td>{s.label}</td>
                <td className="num">{formatNumber(s.value)}</td>
                <td className="num">{percent(s.value, base, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {stages.map((s, i) => (
            <div className="funnel-row" key={s.label} title={s.hint}>
              <span className="secondary">{s.label}</span>
              <div className="funnel-track">
                <div className="funnel-bar" style={{ width: `${(s.value / max) * 100}%`, background: colors[i % colors.length] }} />
              </div>
              <span className="funnel-value">
                <strong>{formatNumber(s.value)}</strong>
                {i > 0 && <span className="pct">{percent(s.value, base)}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
