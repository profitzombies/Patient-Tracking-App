/**
 * Live Revenue Trend for the signed-in office Overview.
 *
 * One office billing dashboard request covers the prior equal-length window
 * AND the selected range, so the headline total, the delta and the chart all
 * come from the same response (and the endpoint's Stripe balance/payout
 * lookups run once, not twice). Everything derives from date keys.
 *
 * The delta compares against the prior window only when that window has
 * revenue to compare to; a range that predates the office's first payment
 * (or a prior window with nothing collected) reports `null` — "no prior
 * period" — rather than inventing a percentage.
 */
import { addDaysToKey, type OperationsDateRange } from '@/contexts/date-range';
import type { SeriesPoint } from '@/lib/billing-types';

export interface LiveRevenueWindow {
  /** First day of the prior window (dashboard `from`). */
  from: string;
  /** Last day of the selected range (dashboard `to`). */
  to: string;
  /** Days in the selected range; the prior window is the same length. */
  dayCount: number;
}

export interface LiveRevenueView {
  /** Day keys of the selected range, in order. */
  dates: string[];
  /** Gross collected per day, cents. */
  gross: number[];
  /** Collected minus refunds issued that day, cents (can be negative). */
  net: number[];
  totalCents: number;
  /** Gross collected over the prior window; null when nothing was collected then. */
  priorTotalCents: number | null;
  /** Percent change against the prior window; null when there is nothing to compare to. */
  deltaPct: number | null;
  dayCount: number;
}

export function rangeDayCount(range: OperationsDateRange): number {
  let count = 0;
  for (let key = range.start; key <= range.end; key = addDaysToKey(key, 1)) count += 1;
  return count;
}

export function liveRevenueWindow(range: OperationsDateRange): LiveRevenueWindow {
  const dayCount = rangeDayCount(range);
  return { from: addDaysToKey(range.start, -dayCount), to: range.end, dayCount };
}

export function buildLiveRevenueView(range: OperationsDateRange, series: SeriesPoint[]): LiveRevenueView {
  const window = liveRevenueWindow(range);
  const byDate = new Map(series.map((point) => [point.date, point]));
  const dates: string[] = [];
  const gross: number[] = [];
  const net: number[] = [];
  let totalCents = 0;
  for (let key = range.start; key <= range.end; key = addDaysToKey(key, 1)) {
    const point = byDate.get(key);
    const collected = point?.collected_cents ?? 0;
    dates.push(key);
    gross.push(collected);
    net.push(collected - (point?.refunded_cents ?? 0));
    totalCents += collected;
  }
  let priorCollected = 0;
  for (let key = window.from; key < range.start; key = addDaysToKey(key, 1)) {
    priorCollected += byDate.get(key)?.collected_cents ?? 0;
  }
  const priorTotalCents = priorCollected > 0 ? priorCollected : null;
  const deltaPct = priorTotalCents === null ? null : ((totalCents - priorTotalCents) / priorTotalCents) * 100;
  return { dates, gross, net, totalCents, priorTotalCents, deltaPct, dayCount: window.dayCount };
}
