/**
 * Shared operations date-range state.
 *
 * One app-level range drives every route (the header control edits it). It is
 * anchored to the fixed demo "today" (TODAY_KEY, 2026-08-22) and defaults to
 * the inclusive prior 30 demo days (Jul 24 – Aug 22, 2026). Never derive the
 * default, labels, or bounds from Date.now()/new Date() — the demo is a
 * snapshot pinned in time and must render identically in every timezone.
 *
 * Ranges are stored as inclusive `YYYY-MM-DD` date keys (the same canonical
 * keys as the seeded data). Calendar widgets work with local-time Dates, so
 * the helpers below convert keys to *local-noon* Dates and back: a local-noon
 * Date carries the same calendar day in every timezone.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { TODAY_KEY } from '@/data/nutrition-data';

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

const clampKey = (key: string) =>
  key < DATE_RANGE_MIN_KEY ? DATE_RANGE_MIN_KEY : key > DATE_RANGE_MAX_KEY ? DATE_RANGE_MAX_KEY : key;

/** Normalize an arbitrary pair of keys into an ordered, in-bounds range. */
export function normalizeRange(range: OperationsDateRange): OperationsDateRange {
  const start = clampKey(range.start);
  const end = clampKey(range.end);
  return start <= end ? { start, end } : { start: end, end: start };
}

interface DateRangeContextValue {
  /** The active inclusive range, shared across all routes. */
  range: OperationsDateRange;
  /** Replace the range (normalized: ordered and clamped to the demo window). */
  setRange: (next: OperationsDateRange) => void;
  /** Restore the default 30-day window ending on the demo anchor. */
  resetRange: () => void;
  defaultRange: OperationsDateRange;
  minKey: string;
  maxKey: string;
}

const DateRangeContext = createContext<DateRangeContextValue | null>(null);

export function DateRangeProvider({ children }: { children: ReactNode }) {
  const [range, setRangeState] = useState<OperationsDateRange>(DEFAULT_DATE_RANGE);

  const setRange = useCallback((next: OperationsDateRange) => {
    setRangeState(normalizeRange(next));
  }, []);

  const resetRange = useCallback(() => setRangeState(DEFAULT_DATE_RANGE), []);

  const value = useMemo<DateRangeContextValue>(
    () => ({
      range,
      setRange,
      resetRange,
      defaultRange: DEFAULT_DATE_RANGE,
      minKey: DATE_RANGE_MIN_KEY,
      maxKey: DATE_RANGE_MAX_KEY,
    }),
    [range, setRange, resetRange],
  );

  return <DateRangeContext.Provider value={value}>{children}</DateRangeContext.Provider>;
}

export function useDateRange() {
  const context = useContext(DateRangeContext);
  if (!context) throw new Error('useDateRange must be used within DateRangeProvider');
  return context;
}
