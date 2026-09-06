/**
 * Shared operations date-range state.
 *
 * One app-level range drives every route (the header control edits it).
 *
 * Two modes, chosen from auth state (never from whether data happens to be
 * present):
 *   - demo (signed out / persona): anchored to the fixed demo "today"
 *     (TODAY_KEY, 2026-08-22), defaulting to the inclusive prior 30 demo days
 *     (Jul 24 – Aug 22, 2026). Never derive the demo default, labels, or
 *     bounds from Date.now() — the demo is a snapshot pinned in time and must
 *     render identically in every timezone.
 *   - live (signed in): anchored to the device-local calendar day, defaulting
 *     to the last 30 days, bounded to the API's one-year window. Live figures
 *     are real, so "today" has to be the real today.
 * Switching modes resets the range to that mode's default.
 *
 * Ranges are stored as inclusive `YYYY-MM-DD` date keys (the same canonical
 * keys as the seeded data). Calendar widgets work with local-time Dates, so
 * the helpers below convert keys to *local-noon* Dates and back: a local-noon
 * Date carries the same calendar day in every timezone.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSession } from '@/contexts/session';

export {
  DATE_RANGE_MAX_KEY,
  DATE_RANGE_MIN_KEY,
  DEFAULT_DATE_RANGE,
  DEMO_TODAY_KEY,
  LIVE_RANGE_MAX_DAYS,
  addDaysToKey,
  dateToKey,
  deviceTodayKey,
  formatRangeLabel,
  keyToDate,
  normalizeRange,
  rangeBoundsFor,
} from '@/lib/date-range-keys';
export type { DateRangeBounds, DateRangeMode, OperationsDateRange } from '@/lib/date-range-keys';
import { rangeBoundsFor, normalizeRange, type DateRangeMode, type OperationsDateRange } from '@/lib/date-range-keys';

interface DateRangeContextValue {
  /** The active inclusive range, shared across all routes. */
  range: OperationsDateRange;
  /** Replace the range (normalized: ordered and clamped to the mode's window). */
  setRange: (next: OperationsDateRange) => void;
  /** Restore the mode's default 30-day window. */
  resetRange: () => void;
  defaultRange: OperationsDateRange;
  minKey: string;
  maxKey: string;
  /** 'live' while a real staff session is signed in; 'demo' otherwise. */
  mode: DateRangeMode;
}

const DateRangeContext = createContext<DateRangeContextValue | null>(null);

export function DateRangeProvider({ children }: { children: ReactNode }) {
  const { authStatus } = useSession();
  const mode: DateRangeMode = authStatus === 'signed-in' ? 'live' : 'demo';
  const bounds = useMemo(() => rangeBoundsFor(mode), [mode]);
  const [range, setRangeState] = useState<OperationsDateRange>(bounds.defaultRange);

  // Mode flips (sign-in / sign-out) restart from that mode's default so a
  // demo window never rides into live data or vice versa.
  const [appliedMode, setAppliedMode] = useState(mode);
  useEffect(() => {
    if (appliedMode === mode) return;
    setAppliedMode(mode);
    setRangeState(bounds.defaultRange);
  }, [mode, appliedMode, bounds]);

  const setRange = useCallback((next: OperationsDateRange) => {
    setRangeState(normalizeRange(next, bounds));
  }, [bounds]);

  const resetRange = useCallback(() => setRangeState(bounds.defaultRange), [bounds]);

  const value = useMemo<DateRangeContextValue>(
    () => ({
      range: appliedMode === mode ? range : bounds.defaultRange,
      setRange,
      resetRange,
      defaultRange: bounds.defaultRange,
      minKey: bounds.minKey,
      maxKey: bounds.maxKey,
      mode,
    }),
    [range, setRange, resetRange, bounds, mode, appliedMode],
  );

  return <DateRangeContext.Provider value={value}>{children}</DateRangeContext.Provider>;
}

export function useDateRange() {
  const context = useContext(DateRangeContext);
  if (!context) throw new Error('useDateRange must be used within DateRangeProvider');
  return context;
}
