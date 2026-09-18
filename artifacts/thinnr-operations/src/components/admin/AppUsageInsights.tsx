/**
 * HQ App usage — Insights section.
 *
 * One dataset at a time (chips): the daily series with the same-length
 * previous period dashed behind it, a weekday × local-hour heatmap with a
 * hover / keyboard readout, four summary tiles, and the rule-based "What
 * changed" list. Every figure arrives pre-computed from the shared rule
 * engine (live API or demo seed) — this file only draws it. Readouts show
 * only while the pointer or keyboard is on a chart; nothing is pinned at
 * rest.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import type { AppUsageInsights, AppUsageInsightsCell } from '@workspace/api-client-react';
import {
  INSIGHTS_DATASETS,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  formatHour,
  formatHourWindow,
  formatWindowLabel,
  heatmapTooltip,
  type InsightsDataset,
} from '@workspace/app-usage-insights';
import { INPUT_CLASS, SectionCard } from '@/components/patient/heritage';
import { MetricTile } from '@/components/admin/primitives';
import { AreaChart, CHART_COLORS, shortDay } from '@/components/billing/hq/RevenueCharts';

const fmt = (value: number) => value.toLocaleString('en-US');

export interface InsightsOfficeOption {
  id: string;
  name: string;
}

export type InsightsViewState = 'loading' | 'error' | 'ready';

interface AppUsageInsightsSectionProps {
  state: InsightsViewState;
  data: AppUsageInsights | undefined;
  dataset: InsightsDataset;
  onDataset: (dataset: InsightsDataset) => void;
  offices: InsightsOfficeOption[];
  office: string | null;
  onOffice: (office: string | null) => void;
  rangeLabel: string;
  onRetry?: () => void;
}

/** "Sep 14, 2026" for a YYYY-MM-DD key, timezone-free. */
function longDay(key: string): string {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function AppUsageInsightsSection({ state, data, dataset, onDataset, offices, office, onOffice, rangeLabel, onRetry }: AppUsageInsightsSectionProps) {
  const loading = state === 'loading';
  const failed = state === 'error';
  const meta = INSIGHTS_DATASETS.find((d) => d.key === dataset) ?? INSIGHTS_DATASETS[0];
  const officeName = office ? offices.find((o) => o.id === office)?.name ?? null : null;

  const chart = useMemo(() => {
    if (!data) return null;
    const dates = data.current.map((point) => point.date);
    return {
      dates,
      current: data.current.map((point) => point.count),
      previous: dates.map((_, index) => data.previous[index]?.count ?? 0),
    };
  }, [data]);

  const tileValue = (value: string | null | undefined) => (loading ? '—' : failed ? 'Error' : value ?? '—');
  const tileDetail = (readyText: string | null) => (loading ? 'Loading insights…' : failed ? 'Failed to load' : readyText ?? `No ${meta.plural} in this range`);
  // Hour-based tiles can be empty while the totals are not: the range predates hour-of-day tracking for this dataset.
  const noHourly = data ? data.totals.current > 0 && data.heatmap.every((cell) => cell.count === 0) : false;
  const hourlyDetail = (readyText: string | null) => (noHourly && readyText === null ? tileDetail('No hour-of-day data in this range yet') : tileDetail(readyText));
  const tiles = data?.tiles;
  const peakWindow = tiles?.peakWindow ?? null;
  const bestDay = tiles?.bestDay ?? null;
  const busiestHour = tiles?.busiestHour ?? null;

  return (
    <div className="mt-8" data-testid="section-app-usage-insights">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground">Insights</p>
          <h2 className="font-serif text-xl font-bold leading-tight tracking-[.01em] text-navy">When patients use the app</h2>
          <p className="mt-1 max-w-[70ch] text-xs text-muted-foreground">
            Pick what to look at. Times are each patient's local time; the previous period is the same number of days immediately before {rangeLabel}.
          </p>
        </div>
        <label className="block min-w-[200px]">
          <span className="text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">Practice</span>
          <select
            data-testid="select-insights-office"
            className={`${INPUT_CLASS} mt-1 h-9 w-full`}
            value={office ?? ''}
            onChange={(event) => onOffice(event.target.value === '' ? null : event.target.value)}
          >
            <option value="">All practices</option>
            {offices.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Dataset" data-testid="group-insights-datasets">
        {INSIGHTS_DATASETS.map((option) => {
          const selected = option.key === dataset;
          return (
            <button
              key={option.key}
              type="button"
              aria-pressed={selected}
              data-testid={`chip-insights-${option.key}`}
              onClick={() => onDataset(option.key)}
              className={`rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors ${
                selected ? 'border-navy bg-navy text-white' : 'border-border bg-card text-navy hover:bg-secondary'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label={`${meta.label} summary`}>
        <MetricTile
          label="Peak window"
          value={tileValue(peakWindow ? formatWindowLabel(peakWindow) : null)}
          detail={hourlyDetail(peakWindow ? `${fmt(peakWindow.count)} ${meta.plural} in the busiest 3 hours` : null)}
          testId="text-insights-peak-window"
        />
        <MetricTile
          label="Best day"
          value={tileValue(bestDay ? WEEKDAY_LONG[bestDay.weekday] : null)}
          detail={tileDetail(bestDay ? `${bestDay.sharePct}% of ${meta.plural} · ${fmt(bestDay.count)}` : null)}
          testId="text-insights-best-day"
        />
        <MetricTile
          label="Busiest hour"
          value={tileValue(busiestHour ? formatHourWindow(busiestHour.hour, busiestHour.hour) : null)}
          detail={hourlyDetail(busiestHour ? `${busiestHour.sharePct}% of timed ${meta.plural} · ${fmt(busiestHour.count)}` : null)}
          testId="text-insights-busiest-hour"
        />
        <MetricTile
          label="Weekend share"
          value={tileValue(tiles && tiles.weekendSharePct !== null ? `${tiles.weekendSharePct}%` : null)}
          detail={tileDetail(tiles && tiles.weekendSharePct !== null ? `of ${meta.plural} land on Saturday or Sunday` : null)}
          testId="text-insights-weekend-share"
        />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <SectionCard
          title={`${meta.label} over time`}
          sub={
            data
              ? `${fmt(data.totals.current)} in ${rangeLabel}${officeName ? ` at ${officeName}` : ''} · previous period ${shortDay(data.previousRange.start)} – ${shortDay(data.previousRange.end)} dashed. Hover a day for both figures.`
              : `Daily ${meta.plural} for ${rangeLabel} with the previous period dashed behind.`
          }
        >
          <div className="px-5 py-4">
            {loading ? (
              <p className="py-8 text-center text-xs text-muted-foreground" data-testid="text-insights-chart-loading">Loading insights…</p>
            ) : failed || !chart || !data ? (
              <InsightsError testId="text-insights-chart-error" onRetry={onRetry} />
            ) : (
              <AreaChart
                title={`${meta.label} per day`}
                dates={chart.dates}
                series={[
                  { key: 'current', label: 'This period', color: CHART_COLORS.count, values: chart.current },
                  { key: 'previous', label: `Previous period (${shortDay(data.previousRange.start)} – ${shortDay(data.previousRange.end)})`, color: CHART_COLORS.gross, values: chart.previous, dashed: true },
                ]}
                unit="count"
                height={220}
                emptyLabel={`No ${meta.plural} in this range yet`}
                testId="chart-insights-trend"
              />
            )}
          </div>
        </SectionCard>

        <SectionCard title="What changed" sub="Read from the numbers above — no commentary, just the rules.">
          <div className="px-5 py-4">
            {loading ? (
              <p className="py-4 text-center text-xs text-muted-foreground" data-testid="text-insights-changes-loading">Loading insights…</p>
            ) : failed || !data ? (
              <InsightsError testId="text-insights-changes-error" onRetry={onRetry} />
            ) : (
              <ul className="m-0 list-none space-y-2.5 p-0" data-testid="list-insights-changes">
                {data.changes.map((change, index) => (
                  <li key={`${change.kind}-${index}`} className="flex gap-2.5 text-xs leading-relaxed text-navy" data-testid={`text-insights-change-${change.kind}`}>
                    <span aria-hidden className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${change.kind === 'tracking' ? 'bg-muted-foreground/60' : 'bg-navy'}`} />
                    <span>{change.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SectionCard>
      </div>

      <div className="mt-5">
        <SectionCard
          title={`${meta.label} by weekday and hour`}
          sub={`Darker means more ${meta.plural}, in each patient's local time. Hover or use the arrow keys for the exact count.`}
        >
          <div className="px-5 py-4">
            {loading ? (
              <p className="py-8 text-center text-xs text-muted-foreground" data-testid="text-insights-heatmap-loading">Loading insights…</p>
            ) : failed || !data ? (
              <InsightsError testId="text-insights-heatmap-error" onRetry={onRetry} />
            ) : (
              <>
                {!data.hourly.complete && (
                  <p className="mb-3 rounded-md border border-border bg-secondary px-3 py-2 text-[11px] text-muted-foreground" data-testid="text-insights-tracked-since">
                    {data.hourly.since
                      ? `Time of day tracked since ${longDay(data.hourly.since)} — ${data.hourly.days} of 7 days so far. Earlier ${meta.plural} count in the totals above but have no hour.`
                      : `Time of day is not tracked for ${meta.plural} yet — the heatmap fills in once the first hour lands.`}
                  </p>
                )}
                <UsageHeatmap cells={data.heatmap} peak={data.peak} dataset={dataset} label={meta.label} />
              </>
            )}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

function InsightsError({ testId, onRetry }: { testId: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert" data-testid={testId}>
      <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        Insights could not be loaded.{' '}
        {onRetry && (
          <button type="button" className="underline" onClick={onRetry}>Try again</button>
        )}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------- heatmap */

const FALLBACK_W = 640;
const LABEL_W = 34;
const HEADER_H = 18;
const GAP = 2;

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

interface UsageHeatmapProps {
  cells: AppUsageInsightsCell[];
  peak: AppUsageInsightsCell | null;
  dataset: InsightsDataset;
  label: string;
}

export function heatmapSummary(label: string, peak: AppUsageInsightsCell | null, dataset: InsightsDataset): string {
  return peak
    ? `${label} by weekday and hour in patients' local time. Peak: ${heatmapTooltip(peak, dataset)}.`
    : `${label} by weekday and hour in patients' local time. No timed activity in this range.`;
}

export function UsageHeatmap({ cells, peak, dataset, label }: UsageHeatmapProps) {
  const [frameRef, width] = useMeasuredWidth<HTMLDivElement>(FALLBACK_W);
  const [active, setActive] = useState<{ weekday: number; hour: number } | null>(null);
  const max = useMemo(() => Math.max(0, ...cells.map((cell) => cell.count)), [cells]);
  const byKey = useMemo(() => {
    const map = new Map<string, AppUsageInsightsCell>();
    for (const cell of cells) map.set(`${cell.weekday}:${cell.hour}`, cell);
    return map;
  }, [cells]);
  const cellW = Math.max(6, (width - LABEL_W - GAP * 23) / 24);
  const cellH = Math.min(22, Math.max(12, cellW));
  const height = HEADER_H + 7 * (cellH + GAP);
  const narrow = width < 480;
  const engaged = active !== null;
  const activeCell = active ? byKey.get(`${active.weekday}:${active.hour}`) ?? { ...active, count: 0 } : null;
  const readout = activeCell ? heatmapTooltip(activeCell, dataset) : '';
  const summary = heatmapSummary(label, peak, dataset);
  const x = (hour: number) => LABEL_W + hour * (cellW + GAP);
  const y = (weekday: number) => HEADER_H + weekday * (cellH + GAP);
  const move = (dw: number, dh: number) => {
    const from = active ?? peak ?? { weekday: 1, hour: 12 };
    setActive({ weekday: Math.min(6, Math.max(0, from.weekday + dw)), hour: Math.min(23, Math.max(0, from.hour + dh)) });
  };
  // Readout card anchored to the active cell, flipped inward near the right edge.
  const cardStyle: React.CSSProperties | null = activeCell
    ? {
        left: x(activeCell.hour) + cellW / 2,
        top: y(activeCell.weekday) - 8,
        transform: activeCell.hour > 15 ? 'translate(calc(-100% + 12px), -100%)' : activeCell.hour < 5 ? 'translate(-12px, -100%)' : 'translate(-50%, -100%)',
      }
    : null;
  return (
    <figure className="m-0" data-testid="chart-insights-heatmap">
      <div className="relative" ref={frameRef}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="block max-w-full select-none"
          role="img"
          aria-label={summary}
          tabIndex={0}
          onMouseLeave={() => setActive(null)}
          onFocus={() => { if (!active) setActive(peak ? { weekday: peak.weekday, hour: peak.hour } : { weekday: 1, hour: 12 }); }}
          onBlur={() => setActive(null)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); move(0, -1); }
            if (event.key === 'ArrowRight') { event.preventDefault(); move(0, 1); }
            if (event.key === 'ArrowUp') { event.preventDefault(); move(-1, 0); }
            if (event.key === 'ArrowDown') { event.preventDefault(); move(1, 0); }
            if (event.key === 'Escape') setActive(null);
          }}
        >
          {Array.from({ length: 24 }, (_, hour) => hour)
            .filter((hour) => (narrow ? hour % 6 === 0 : hour % 3 === 0))
            .map((hour) => (
              <text key={hour} x={x(hour)} y={HEADER_H - 6} fontSize={10} fill="hsl(var(--muted-foreground))">
                {formatHour(hour)}
              </text>
            ))}
          {WEEKDAY_SHORT.map((name, weekday) => (
            <text key={name} x={0} y={y(weekday) + cellH / 2 + 3.5} fontSize={10} fill="hsl(var(--muted-foreground))">
              {name}
            </text>
          ))}
          {cells.map((cell) => {
            const intensity = max > 0 ? cell.count / max : 0;
            const isActive = active?.weekday === cell.weekday && active?.hour === cell.hour;
            return (
              <rect
                key={`${cell.weekday}:${cell.hour}`}
                x={x(cell.hour)}
                y={y(cell.weekday)}
                width={cellW}
                height={cellH}
                rx={2}
                fill={cell.count === 0 ? 'hsl(var(--secondary))' : 'hsl(var(--navy))'}
                fillOpacity={cell.count === 0 ? 1 : 0.14 + 0.86 * intensity}
                stroke={isActive ? 'hsl(var(--navy))' : 'none'}
                strokeWidth={isActive ? 1.5 : 0}
                data-testid={`cell-insights-${cell.weekday}-${cell.hour}`}
                data-count={cell.count}
                onMouseEnter={() => setActive({ weekday: cell.weekday, hour: cell.hour })}
              />
            );
          })}
        </svg>
        <p className="sr-only" aria-live="polite" data-testid="text-insights-heatmap-live">
          {engaged ? readout : ''}
        </p>
        {engaged && cardStyle && (
          <div
            aria-hidden
            data-testid="chart-insights-heatmap-readout"
            className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-border bg-card/95 px-3 py-1.5 text-[11px] font-semibold text-navy shadow-soft backdrop-blur-sm"
            style={cardStyle}
          >
            {readout}
          </div>
        )}
      </div>
      <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5" data-testid="text-insights-heatmap-legend">
          Fewer
          {[0.14, 0.35, 0.57, 0.78, 1].map((opacity) => (
            <span key={opacity} aria-hidden className="h-2.5 w-4 rounded-sm" style={{ background: 'hsl(var(--navy))', opacity }} />
          ))}
          More{max > 0 ? ` · up to ${fmt(max)} in an hour` : ''}
        </span>
        <span data-testid="text-insights-heatmap-peak">{peak ? `Peak: ${heatmapTooltip(peak, dataset)}` : 'No timed activity in this range'}</span>
      </figcaption>
    </figure>
  );
}
