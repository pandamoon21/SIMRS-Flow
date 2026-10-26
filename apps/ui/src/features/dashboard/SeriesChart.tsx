/**
 * Responsive bar / line / area chart. The SVG is drawn at the container's real
 * pixel width (ResizeObserver), so dots stay round and text never stretches;
 * axis labels thin out and per-bar values hide when bars get narrow, so the
 * chart reads the same on a phone, a 1366 office screen and a 4K monitor.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SeriesPoint } from './rekapData.js';

export type ChartType = 'bar' | 'line' | 'area';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0]?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** 1-2-5 "nice" step so gridlines land on round rupiah values. */
function niceMax(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 1, step: 0.25 };
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * pow >= raw) ?? 10) * pow;
  return { top: step * Math.ceil(max / step), step };
}

export interface SeriesChartProps {
  points: readonly SeriesPoint[];
  type?: ChartType;
  /** Short axis/value formatter (e.g. "Rp 1,2 jt"). */
  format: (n: number) => string;
  selectedKey?: string;
  /** Highlighted as "current" (e.g. today). */
  currentKey?: string;
  onSelect?: (key: string) => void;
  ariaLabel: string;
}

export function SeriesChart({ points, type = 'bar', format, selectedKey, currentKey, onSelect, ariaLabel }: SeriesChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(width, 260);
  const H = Math.round(Math.min(320, Math.max(190, W * 0.3)));
  const padL = W < 480 ? 44 : 58;
  const padR = 10;
  const padT = 22;
  const padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = points.length;
  const peak = Math.max(0, ...points.map((p) => p.value));
  const { top, step } = niceMax(peak);
  const y = (v: number) => padT + innerH - (v / top) * innerH;
  const slot = n ? innerW / n : innerW;
  const xMid = (i: number) => padL + slot * i + slot / 2;
  // Show every k-th x label so labels stay ≥ ~38px apart.
  const labelEvery = Math.max(1, Math.ceil(38 / Math.max(1, slot)));
  const showValues = type === 'bar' && slot >= 52;
  const barW = Math.max(2, Math.min(44, slot * 0.62));
  // No data: only the zero baseline — fractional rupiah ticks read as "1, 1, 0".
  const ticks: number[] = [0];
  if (peak > 0) for (let v = step; v <= top + step / 2; v += step) ticks.push(v);

  const press = (key: string) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(key); }
  };
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${xMid(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const area = n ? `${line} L${xMid(n - 1).toFixed(1)} ${y(0)} L${xMid(0).toFixed(1)} ${y(0)} Z` : '';

  return (
    <div ref={ref} className="series-chart">
      {width > 0 && n > 0 ? (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group" aria-label={ariaLabel}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="series-grid" x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} />
              <text className="series-axis" x={padL - 6} y={y(t)} dy="0.32em" textAnchor="end">{t === 0 ? '0' : format(t).replace(/^Rp\s?/, '')}</text>
            </g>
          ))}
          {type !== 'bar' ? (
            <>
              {type === 'area' ? <path className="series-area" d={area} /> : null}
              <path className="series-line" d={line} />
            </>
          ) : null}
          {points.map((p, i) => {
            const selected = selectedKey === p.key;
            const current = currentKey === p.key;
            const cls = `series-mark${selected ? ' is-selected' : ''}${current ? ' is-current' : ''}`;
            return (
              <g
                key={p.key}
                className={cls}
                role={onSelect ? 'button' : undefined}
                tabIndex={onSelect ? 0 : undefined}
                aria-pressed={onSelect ? selected : undefined}
                aria-label={p.title}
                onClick={onSelect ? () => onSelect(p.key) : undefined}
                onKeyDown={onSelect ? press(p.key) : undefined}
              >
                <title>{p.title}</title>
                {/* Full-height hit area: easy to click even for a zero bar. */}
                <rect className="series-hit" x={padL + slot * i} y={padT} width={slot} height={innerH} />
                {type === 'bar' ? (
                  <rect className="series-bar" x={xMid(i) - barW / 2} y={y(p.value)} width={barW} height={Math.max(0, y(0) - y(p.value))} rx={Math.min(3, barW / 4)} />
                ) : (
                  <circle className="series-dot" cx={xMid(i)} cy={y(p.value)} r={selected || current ? 4.5 : n > 60 ? 0 : 3} />
                )}
                {showValues && p.value > 0 ? <text className="series-value" x={xMid(i)} y={y(p.value) - 6} textAnchor="middle">{format(p.value).replace(/^Rp\s?/, '')}</text> : null}
                {i % labelEvery === 0 || selected || current ? (
                  <text className="series-axis series-x" x={xMid(i)} y={H - 8} textAnchor="middle">{p.label}</text>
                ) : null}
              </g>
            );
          })}
        </svg>
      ) : (
        <div className="series-empty">{n === 0 ? 'Tidak ada data pada periode ini.' : ''}</div>
      )}
    </div>
  );
}
