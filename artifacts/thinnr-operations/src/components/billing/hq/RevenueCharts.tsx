/**
 * Payments charts for the HQ overview.
 *
 * Pure SVG, matching the dashboard's Sparkline convention: no chart library,
 * so the verify scripts can render these under react-test-renderer without a
 * DOM or ResizeObserver. Each chart exposes a spoken summary (role="img" +
 * aria-label) and a hover/focus readout for sighted users.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatCents } from '@/lib/billing-format';
import type { HourPoint, SeriesPoint } from '@/lib/billing-types';

export type Money = 'money' | 'count';

export interface ChartSeries {
  key: string;
  label: string;
  /** CSS color for the stroke and the (translucent) fill. */
  color: string;
  values: number[];
  /** Comparison series: dashed stroke, no fill, hollow legend dot (the previous period behind the current one). */
  dashed?: boolean;
}

/** Width used before the container has been measured (and under test renderers with no DOM). */
const FALLBACK_W = 640;
const PAD = { top: 16, right: 16, bottom: 26, left: 52 };

/**
 * Measured pixel width of the chart's container. The SVG is drawn in real
 * pixels (viewBox == rendered size) so type and strokes keep their size on
 * any screen instead of being scaled up with the card.
 */
function useMeasuredWidth<T extends HTMLElement>(fallback: number): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const apply = () => {
      const next = Math.round(node.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function fmt(value: number, unit: Money): string {
  return unit === 'money' ? formatCents(value) : value.toLocaleString('en-US');
}
/** Short axis label: "$1.2k" / "$850" / "12". */
function axis(value: number, unit: Money): string {
  if (unit === 'count') return value.toLocaleString('en-US');
  const sign = value < 0 ? '-' : '';
  const dollars = Math.abs(value) / 100;
  if (dollars >= 1000) return `${sign}$${(dollars / 1000).toFixed(dollars >= 10_000 ? 0 : 1)}k`;
  return `${sign}$${Math.round(dollars)}`;
}
/** "Sep 3" — short, timezone-free label for a YYYY-MM-DD key. */
export function shortDay(key: string): string {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const step = max / magnitude;
  const nice = step <= 1 ? 1 : step <= 2 ? 2 : step <= 2.5 ? 2.5 : step <= 5 ? 5 : 10;
  return nice * magnitude;
}
/** "12 AM", "1 PM" for an hour key "0".."23". */
export function hourLabel(key: string): string {
  const hour = Number(key);
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${hour < 12 ? 'AM' : 'PM'}`;
}
export function chartSummary(title: string, dates: string[], series: ChartSeries[], unit: Money, label: (key: string) => string = shortDay, running = false): string {
  if (dates.length === 0) return `${title}: no data.`;
  const parts = series.map((s) => {
    if (running) {
      // Running totals: the last point IS the total; summing the points would multiply it.
      return `${s.label} ${fmt(s.values[s.values.length - 1] ?? 0, unit)} so far`;
    }
    const total = s.values.reduce((sum, v) => sum + v, 0);
    const peakIndex = s.values.reduce((best, v, i) => (v > s.values[best] ? i : best), 0);
    return `${s.label} ${fmt(total, unit)} in total, peaking at ${fmt(s.values[peakIndex] ?? 0, unit)} at ${label(dates[peakIndex])}`;
  });
  return `${title}, ${label(dates[0])} to ${label(dates[dates.length - 1])}: ${parts.join('; ')}.`;
}

interface AreaChartProps {
  title: string;
  dates: string[];
  series: ChartSeries[];
  unit: Money;
  height?: number;
  /** Compact mode drops the legend and most axis labels (small cards). */
  compact?: boolean;
  /** Formats an x key ("2026-09-14" or "13") for axis labels and the readout. Defaults to short day. */
  formatLabel?: (key: string) => string;
  /** Longer label for the readout card header (defaults to formatLabel). */
  formatLabelLong?: (key: string) => string;
  /** Shown when every value is zero. */
  emptyLabel?: string;
  /** Roughly how many x-axis labels to show. */
  labelCount?: number;
  /** Values are running totals (cumulative): the spoken summary reads the last point as the total. */
  running?: boolean;
  testId?: string;
}

export function AreaChart({
  title, dates, series, unit, height = 220, compact = false, formatLabel = shortDay, formatLabelLong, emptyLabel = 'No activity in this range yet', labelCount, running = false, testId,
}: AreaChartProps) {
  const gradientId = useId().replace(/:/g, '');
  const [hover, setHover] = useState<number | null>(null);
  const [frameRef, width] = useMeasuredWidth<HTMLDivElement>(FALLBACK_W);
  const n = dates.length;
  const pad = compact ? { top: 8, right: 8, bottom: 18, left: 8 } : PAD;
  const innerW = Math.max(1, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const max = useMemo(() => niceMax(Math.max(0, ...series.flatMap((s) => s.values))), [series]);
  // Signed domain: a running net can dip below zero (a refund of an older
  // order before today's first sale), and that must plot below the baseline
  // rather than being clamped to $0 while the readout says otherwise.
  const min = useMemo(() => {
    const lowest = Math.min(0, ...series.flatMap((s) => s.values));
    return lowest < 0 ? -niceMax(-lowest) : 0;
  }, [series]);
  const span = max - min;
  const x = (i: number) => pad.left + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2);
  const y = (v: number) => pad.top + innerH - ((v - min) / span) * innerH;
  const summary = chartSummary(title, dates, series, unit, formatLabel, running);
  if (n === 0 || series.every((s) => s.values.every((v) => v === 0))) {
    return (
      <div className="grid place-items-center rounded-md border border-dashed border-border text-xs text-muted-foreground" style={{ height }} role="img" aria-label={summary} data-testid={testId}>
        {emptyLabel}
      </div>
    );
  }
  const ticks = compact
    ? (min < 0 ? [min, 0, max] : [0, max])
    : [...(min < 0 ? [min, min / 2] : []), 0, max / 4, max / 2, (max * 3) / 4, max];
  // Axis labels: never closer than ~64px (compact: ~56px) so neighbours cannot collide.
  const fitLabels = Math.max(2, Math.floor(innerW / (compact ? 56 : 64)));
  const labelEvery = Math.max(1, Math.ceil((n - 1) / Math.max(1, Math.min(labelCount ?? (compact ? 3 : 8), fitLabels) - 1)));
  const lastLabelIndex = n - 1;
  const showLabel = (i: number) => {
    if (i === lastLabelIndex) return true;
    if (i % labelEvery !== 0) return false;
    // Drop the label just before the end when it would crowd the final one.
    return x(lastLabelIndex) - x(i) >= (compact ? 40 : 48);
  };
  // The crosshair + readout appear only while the pointer or keyboard is on
  // the chart; at rest the plot stands alone (no card pinned to the last slot).
  const engaged = hover !== null;
  const active = hover ?? n - 1;
  const readout = series.map((s) => `${s.label} ${fmt(s.values[active] ?? 0, unit)}`).join(' · ');
  const longLabel = (formatLabelLong ?? formatLabel)(dates[active]);
  // Readout card: anchored to the active point, flipped at the edges so it
  // never leaves the chart, and dropped below the point when the point is
  // near the top of the plot.
  const activeX = x(active);
  const activeTop = Math.min(...series.map((s) => y(s.values[active] ?? 0)));
  const frac = n > 1 ? active / (n - 1) : 0.5;
  const cardHeight = 34 + series.length * 18;
  // Narrow charts (phones) get the readout as a row under the plot instead of a card over it.
  const floating = width >= 480;
  const cardStyle: React.CSSProperties =
    activeTop - 14 - cardHeight >= 0
      ? {
          // Room above the point: centred on it, flipped inward at the edges.
          left: activeX,
          bottom: height - activeTop + 14,
          transform: frac < 0.2 ? 'translateX(-12px)' : frac > 0.8 ? 'translateX(calc(-100% + 12px))' : 'translateX(-50%)',
        }
      : frac >= 0.5
        ? { right: width - activeX + 14, top: pad.top }
        : { left: activeX + 14, top: pad.top };
  const pick = (clientX: number, target: SVGSVGElement) => {
    const box = target.getBoundingClientRect();
    if (box.width === 0) return;
    const rel = clientX - box.left;
    const index = Math.round(((rel - pad.left) / innerW) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, index)));
  };
  return (
    <figure className="m-0" data-testid={testId}>
      <div className="relative" ref={frameRef}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="block max-w-full select-none"
          role="img"
          aria-label={summary}
          tabIndex={0}
          onMouseMove={(e) => pick(e.clientX, e.currentTarget)}
          onMouseLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); setHover(Math.max(0, active - 1)); }
            if (e.key === 'ArrowRight') { e.preventDefault(); setHover(Math.min(n - 1, active + 1)); }
          }}
        >
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`${gradientId}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="hsl(var(--border))" strokeDasharray={t === 0 ? undefined : '3 4'} />
              {!compact && (
                <text x={pad.left - 8} y={y(t) + 3} textAnchor="end" fontSize={11} fill="hsl(var(--muted-foreground))">
                  {axis(t, unit)}
                </text>
              )}
            </g>
          ))}
          {dates.map((d, i) =>
            showLabel(i) ? (
              <text key={d} x={x(i)} y={height - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fontSize={11} fill="hsl(var(--muted-foreground))">
                {formatLabel(d)}
              </text>
            ) : null,
          )}
          {series.map((s) => {
            const line = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
            const area = `${line} L${x(n - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
            return (
              <g key={s.key}>
                {!s.dashed && <path d={area} fill={`url(#${gradientId}-${s.key})`} />}
                <path d={line} fill="none" stroke={s.color} strokeWidth={s.dashed ? 1.5 : 2} strokeDasharray={s.dashed ? '5 4' : undefined} strokeOpacity={s.dashed ? 0.7 : 1} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
          {engaged && (
            <>
              <line x1={x(active)} x2={x(active)} y1={pad.top} y2={pad.top + innerH} stroke="hsl(var(--navy))" strokeOpacity={0.45} />
              {series.map((s) => (
                <circle key={s.key} cx={x(active)} cy={y(s.values[active] ?? 0)} r={3.5} fill="#fff" stroke={s.color} strokeWidth={2} />
              ))}
            </>
          )}
        </svg>
        <p className="sr-only" aria-live="polite">
          {engaged ? `${longLabel}: ${readout}` : ''}
        </p>
        {engaged && !compact && floating && (
          <div
            aria-hidden
            data-testid={testId ? `${testId}-readout` : undefined}
            className="pointer-events-none absolute z-10 rounded-md border border-border bg-card/95 px-3 py-2 text-[11px] shadow-soft backdrop-blur-sm"
            style={cardStyle}
          >
            <p className="mb-1 whitespace-nowrap font-semibold text-navy">{longLabel}</p>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
              {series.map((s) => (
                <div key={s.key} className="contents">
                  <dt className="inline-flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
                    <span aria-hidden className="h-2 w-2 rounded-full" style={s.dashed ? { border: `1.5px dashed ${s.color}` } : { background: s.color }} />
                    {s.label}
                  </dt>
                  <dd className="m-0 text-right font-semibold tabular-nums text-navy">{fmt(s.values[active] ?? 0, unit)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
      {engaged && !compact && !floating && (
        <div aria-hidden data-testid={testId ? `${testId}-readout` : undefined} className="mt-2 rounded-md border border-border bg-background/60 px-3 py-2 text-[11px]">
          <p className="mb-1 font-semibold text-navy">{longLabel}</p>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
            {series.map((s) => (
              <div key={s.key} className="contents">
                <dt className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <span aria-hidden className="h-2 w-2 rounded-full" style={s.dashed ? { border: `1.5px dashed ${s.color}` } : { background: s.color }} />
                  {s.label}
                </dt>
                <dd className="m-0 text-right font-semibold tabular-nums text-navy">{fmt(s.values[active] ?? 0, unit)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {!compact && floating && (
        <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="h-2 w-2 rounded-full" style={s.dashed ? { border: `1.5px dashed ${s.color}` } : { background: s.color }} />
              {s.label}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

/** Small stat card with a headline figure and a compact area chart below. */
export function ChartCard({
  label,
  value,
  detail,
  dates,
  values,
  unit,
  color,
  running,
  testId,
}: {
  label: string;
  value: string;
  detail?: string;
  dates: string[];
  values: number[];
  unit: Money;
  color: string;
  /** Values are a running total (see AreaChart). */
  running?: boolean;
  testId?: string;
}) {
  return (
    <div className="rounded-lg border border-card-border bg-card p-4 shadow-soft" data-testid={testId}>
      <p className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">{label}</p>
      <p className="mt-2 font-serif text-[22px] font-bold leading-none tracking-[-.01em] text-navy">{value}</p>
      {detail && <p className="mt-1.5 text-[11px] text-muted-foreground">{detail}</p>}
      <div className="mt-3">
        <AreaChart title={label} dates={dates} series={[{ key: 'v', label, color, values }]} unit={unit} height={90} compact running={running} />
      </div>
    </div>
  );
}

export function cumulative(values: number[]): number[] {
  let running = 0;
  return values.map((v) => (running += v));
}

export const CHART_COLORS = {
  gross: 'hsl(var(--chart-1))',
  net: 'hsl(var(--chart-3))',
  fees: '#b65c22',
  profit: '#2f7d4f',
  refunds: 'hsl(var(--destructive))',
  count: 'hsl(var(--chart-2))',
};

/**
 * Today's points through the current hour, keyed "0".."23", as RUNNING TOTALS:
 * each hour is everything collected since midnight, so the lines only ever
 * climb (a quiet hour is flat, never a drop back to zero).
 */
export function hourlySeriesFrom(points: HourPoint[], currentHour: number) {
  const shown = points.filter((p) => p.hour <= currentHour);
  return {
    hours: shown.map((p) => String(p.hour)),
    gross: cumulative(shown.map((p) => p.collected_cents)),
    net: cumulative(shown.map((p) => p.net_cents)),
    fees: cumulative(shown.map((p) => p.fee_cents)),
    profit: cumulative(shown.map((p) => p.profit_cents)),
  };
}
/** Readout header for a running-total hour: "Through 3 PM", or "So far today" on the current hour. */
export function runningHourLabel(key: string, currentHourKey: string): string {
  if (key === currentHourKey) return 'So far today';
  return `Through ${hourLabel(String((Number(key) + 1) % 24))}`;
}
export function seriesFrom(series: SeriesPoint[]) {
  return {
    dates: series.map((p) => p.date),
    gross: series.map((p) => p.collected_cents),
    net: series.map((p) => p.collected_cents - p.refunded_cents),
    officeNet: series.map((p) => p.net_cents),
    fees: series.map((p) => p.fee_cents),
    refunds: series.map((p) => p.refunded_cents),
    orders: series.map((p) => p.orders),
  };
}
