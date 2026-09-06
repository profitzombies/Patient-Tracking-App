/**
 * Pure date-key helpers for the shared operations date range.
 *
 * Kept free of React and browser globals so the regression scripts can pin
 * the demo anchor and live-mode bounds without booting the session context.
 * Ranges are inclusive `YYYY-MM-DD` keys; calendar widgets work with local
 * Dates, so keys convert to *local-noon* Dates and back (same calendar day in
 * every timezone).
 */
import { TODAY_KEY } from '../data/nutrition-data';

export interface OperationsDateRange {
  /** Inclusive start date key (YYYY-MM-DD). */
  start: string;
  /** Inclusive end date key (YYYY-MM-DD). */
  end: string;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Parse a date key into a local-noon Date (safe for calendar display in any timezone). */
export function keyToDate(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

/** Serialize a (local) Date back to its calendar date key. */
export function dateToKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Shift a date key by whole days (calendar arithmetic, timezone-proof). */
export function addDaysToKey(key: string, days: number): string {
  const date = keyToDate(key);
  date.setDate(date.getDate() + days);
  return dateToKey(date);
}

/** The fixed demo anchor — the synthetic "today" shared with the mobile app. */
export const DEMO_TODAY_KEY = TODAY_KEY;

/** Earliest selectable day: the demo year's monthly analytics reach back to January. */
export const DATE_RANGE_MIN_KEY = '2026-01-01';

/** Latest selectable day: nothing exists after the demo anchor. */
export const DATE_RANGE_MAX_KEY = DEMO_TODAY_KEY;

/** Default range: the inclusive 30 demo days ending on the anchor (Jul 24 – Aug 22, 2026). */
export const DEFAULT_DATE_RANGE: OperationsDateRange = {
  start: addDaysToKey(DEMO_TODAY_KEY, -29),
  end: DEMO_TODAY_KEY,
};

/**
 * Human label for a range, e.g. "Jul 24 – Aug 22, 2026" (long) or
 * "Jul 24 – Aug 22" (short, for narrow headers).
 */
export function formatRangeLabel(range: OperationsDateRange, style: 'long' | 'short' = 'long'): string {
  const start = keyToDate(range.start);
  const end = keyToDate(range.end);
  const monthDay = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const monthDayYear = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  if (range.start === range.end) {
    return style === 'long' ? monthDayYear(end) : monthDay(end);
  }
  if (style === 'short') return `${monthDay(start)} – ${monthDay(end)}`;
  return start.getFullYear() === end.getFullYear()
    ? `${monthDay(start)} – ${monthDayYear(end)}`
    : `${monthDayYear(start)} – ${monthDayYear(end)}`;
}

/** Live analytics accept at most a year per request (mirrors the API's MAX_RANGE_DAYS). */
export const LIVE_RANGE_MAX_DAYS = 366;

export type DateRangeMode = 'demo' | 'live';

export interface DateRangeBounds {
  mode: DateRangeMode;
  minKey: string;
  maxKey: string;
  defaultRange: OperationsDateRange;
}

/** Today's calendar day on this device (live mode only — never used for the demo). */
export function deviceTodayKey(now: Date = new Date()): string {
  return dateToKey(now);
}

/** Bounds + default for a mode: the demo window, or the trailing live year ending today. */
export function rangeBoundsFor(mode: DateRangeMode, todayKey: string = deviceTodayKey()): DateRangeBounds {
  if (mode === 'live') {
    return {
      mode,
      minKey: addDaysToKey(todayKey, -(LIVE_RANGE_MAX_DAYS - 1)),
      maxKey: todayKey,
      defaultRange: { start: addDaysToKey(todayKey, -29), end: todayKey },
    };
  }
  return { mode, minKey: DATE_RANGE_MIN_KEY, maxKey: DATE_RANGE_MAX_KEY, defaultRange: DEFAULT_DATE_RANGE };
}

const clampKeyTo = (key: string, minKey: string, maxKey: string) =>
  key < minKey ? minKey : key > maxKey ? maxKey : key;

/** Normalize an arbitrary pair of keys into an ordered, in-bounds range (demo bounds by default). */
export function normalizeRange(
  range: OperationsDateRange,
  bounds: Pick<DateRangeBounds, 'minKey' | 'maxKey'> = rangeBoundsFor('demo'),
): OperationsDateRange {
  const start = clampKeyTo(range.start, bounds.minKey, bounds.maxKey);
  const end = clampKeyTo(range.end, bounds.minKey, bounds.maxKey);
  return start <= end ? { start, end } : { start: end, end: start };
}
