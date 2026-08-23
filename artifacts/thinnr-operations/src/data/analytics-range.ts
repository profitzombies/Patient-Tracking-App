/**
 * Range-driven synthetic data for the Revenue & Outcomes route.
 *
 * Every figure derives deterministically from the shared operations date
 * range (inclusive YYYY-MM-DD keys): the same range always yields the same
 * numbers, in every timezone — no Math.random(), no viewer clock. The range
 * arrives already normalized (ordered, clamped to Jan 1 2026 … the demo
 * anchor) by the shared date-range context; the selectors still clamp
 * defensively.
 *
 * Calibration: the default range (the 30 demo days ending on the fixed
 * anchor, Jul 24 – Aug 22, 2026) reproduces the legacy MOCK_ANALYTICS
 * headline figures exactly — $184,200 total revenue ($122,200 recurring +
 * $62,000 enrollments), 88.2% goal completion, 24.5 lbs average loss, 94.5%
 * retention, and the "+14%" maintenance-conversion note. Every other range
 * reads from the same underlying daily/monthly series, so custom selections
 * produce coherent (not merely relabeled) numbers.
 */
import { MOCK_ANALYTICS } from './mock-data';
import { TODAY_KEY } from './nutrition-data';

export interface AnalyticsRange {
  /** Inclusive start date key (YYYY-MM-DD). */
  start: string;
  /** Inclusive end date key (YYYY-MM-DD). */
  end: string;
}

const DAY_MS = 86_400_000;

/** The synthetic analytics series starts with the demo year. */
const SERIES_START_KEY = '2026-01-01';

/** UTC-noon epoch for a date key — timezone-proof calendar arithmetic. */
const keyToUtcMs = (key: string) => new Date(`${key}T12:00:00.000Z`).getTime();

const SERIES_START_MS = keyToUtcMs(SERIES_START_KEY);

/** Index of the fixed demo anchor (Aug 22, 2026) within the series. */
const ANCHOR_INDEX = Math.round((keyToUtcMs(TODAY_KEY) - SERIES_START_MS) / DAY_MS);

const toIndex = (key: string) => Math.round((keyToUtcMs(key) - SERIES_START_MS) / DAY_MS);
const indexToKey = (index: number) =>
  new Date(SERIES_START_MS + index * DAY_MS).toISOString().slice(0, 10);
const clampIndex = (index: number) => Math.min(ANCHOR_INDEX, Math.max(0, index));

/** Same deterministic hash the rest of the seeded demo data uses. */
const seededFraction = (seed: number) => {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
};

const round1 = (value: number) => Math.round(value * 10) / 10;

// ---------------------------------------------------------------------------
// Daily revenue series (Jan 1 – Aug 22, 2026)
// ---------------------------------------------------------------------------

/** Recurring revenue compounds ~+9% per 30 days; enrollments ~+19%. Together
 * they put the default window ~+12% over the prior 30 days — the growth story
 * the legacy page told with its hardcoded "+12.4%" badge. */
const RECURRING_DAILY_GROWTH = Math.log(1.09) / 30;
const ENROLLMENT_DAILY_GROWTH = Math.log(1.19) / 30;

/** Enrollments skew to weekdays (Sun..Sat); recurring billing is smooth. */
const ENROLLMENT_WEEKDAY_FACTOR = [0.55, 1.16, 1.18, 1.2, 1.16, 1.1, 0.65];

const rawRecurring: number[] = [];
const rawEnrollment: number[] = [];
for (let t = 0; t <= ANCHOR_INDEX; t++) {
  const recurringWiggle = 1 + (seededFraction(t * 1.7 + 11) - 0.5) * 0.05;
  rawRecurring.push(Math.exp(RECURRING_DAILY_GROWTH * t) * recurringWiggle);

  const weekday = new Date(SERIES_START_MS + t * DAY_MS).getUTCDay();
  const enrollmentWiggle = 1 + (seededFraction(t * 2.3 + 37) - 0.5) * 0.45;
  rawEnrollment.push(
    Math.exp(ENROLLMENT_DAILY_GROWTH * t) * ENROLLMENT_WEEKDAY_FACTOR[weekday] * enrollmentWiggle,
  );
}

const sumSlice = (series: number[], startIndex: number, endIndex: number) => {
  let total = 0;
  for (let t = startIndex; t <= endIndex; t++) total += series[t];
  return total;
};

const DEFAULT_START_INDEX = ANCHOR_INDEX - 29;

// Scale the raw curves so the default window sums to the legacy headline
// figures exactly.
const recurringScale =
  MOCK_ANALYTICS.recurringRevenue / sumSlice(rawRecurring, DEFAULT_START_INDEX, ANCHOR_INDEX);
const enrollmentScale =
  MOCK_ANALYTICS.enrollmentRevenue / sumSlice(rawEnrollment, DEFAULT_START_INDEX, ANCHOR_INDEX);
const dailyRecurring = rawRecurring.map((value) => value * recurringScale);
const dailyEnrollment = rawEnrollment.map((value) => value * enrollmentScale);

export interface RevenueSummary {
  total: number;
  recurring: number;
  enrollment: number;
}

/** Revenue collected inside the range. Recurring + enrollment always add up
 * to the displayed total (rounded once each, then summed). */
export function getRevenueSummary(range: AnalyticsRange): RevenueSummary {
  const start = clampIndex(toIndex(range.start));
  const end = clampIndex(toIndex(range.end));
  const recurring = Math.round(sumSlice(dailyRecurring, start, end));
  const enrollment = Math.round(sumSlice(dailyEnrollment, start, end));
  return { total: recurring + enrollment, recurring, enrollment };
}

export interface RevenueComparison {
  /** Percent change vs the prior window, rounded to one decimal. */
  deltaPercent: number;
  /** The equal-length window immediately before the range. */
  priorRange: AnalyticsRange;
}

/**
 * Compare the range against the equal-length window immediately before it.
 * Returns null when that prior window would predate the demo dataset
 * (before Jan 1, 2026) — the page shows an honest "no comparison" note
 * instead of inventing one.
 */
export function getRevenueComparison(range: AnalyticsRange): RevenueComparison | null {
  const start = clampIndex(toIndex(range.start));
  const end = clampIndex(toIndex(range.end));
  const length = end - start + 1;
  const priorStart = start - length;
  const priorEnd = start - 1;
  if (priorStart < 0) return null;

  const current = sumSlice(dailyRecurring, start, end) + sumSlice(dailyEnrollment, start, end);
  const prior =
    sumSlice(dailyRecurring, priorStart, priorEnd) + sumSlice(dailyEnrollment, priorStart, priorEnd);
  return {
    deltaPercent: round1(((current - prior) / prior) * 100),
    priorRange: { start: indexToKey(priorStart), end: indexToKey(priorEnd) },
  };
}

/** Inclusive day count of a range (clamped to the demo window). */
export function getRangeDayCount(range: AnalyticsRange): number {
  return clampIndex(toIndex(range.end)) - clampIndex(toIndex(range.start)) + 1;
}

// ---------------------------------------------------------------------------
// Monthly outcome series (blend weights for the outcome summary card)
// ---------------------------------------------------------------------------

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'] as const;

/** First/last series index of each 2026 month (Aug ends at the anchor). */
const monthBounds = MONTH_LABELS.map((_, monthIndex) => {
  const first = toIndex(`2026-${String(monthIndex + 1).padStart(2, '0')}-01`);
  const last =
    monthIndex === MONTH_LABELS.length - 1
      ? ANCHOR_INDEX
      : toIndex(`2026-${String(monthIndex + 2).padStart(2, '0')}-01`) - 1;
  return { first, last };
});

/** Outcomes reported by patients completing protocols in each month: a gentle
 * upward trend plus a small seeded wiggle, so different ranges genuinely read
 * differently while staying plausible. */
const rawMonthlyOutcomes = MONTH_LABELS.map((_, m) => ({
  goalCompletion: 86.2 + m * 0.42 + (seededFraction(m * 5.1 + 3) - 0.5) * 0.8,
  avgPoundsLost: 23.2 + m * 0.34 + (seededFraction(m * 7.3 + 9) - 0.5) * 0.9,
  retention: 92.4 + m * 0.4 + (seededFraction(m * 3.7 + 21) - 0.5) * 0.7,
}));

/** Day-weighted average of a per-month series across a range. */
function blendMonthly(values: number[], startIndex: number, endIndex: number): number {
  let weightTotal = 0;
  let valueTotal = 0;
  monthBounds.forEach((bounds, m) => {
    const overlap = Math.min(endIndex, bounds.last) - Math.max(startIndex, bounds.first) + 1;
    if (overlap > 0) {
      weightTotal += overlap;
      valueTotal += overlap * values[m];
    }
  });
  return weightTotal === 0 ? 0 : valueTotal / weightTotal;
}

const goalSeries = rawMonthlyOutcomes.map((v) => v.goalCompletion);
const lostSeries = rawMonthlyOutcomes.map((v) => v.avgPoundsLost);
const retentionSeries = rawMonthlyOutcomes.map((v) => v.retention);

// Offsets so the default window blends to the legacy headline outcomes
// exactly (a uniform offset preserves the trend and the wiggle).
const goalOffset =
  MOCK_ANALYTICS.averageGoalCompletion - blendMonthly(goalSeries, DEFAULT_START_INDEX, ANCHOR_INDEX);
const lostOffset =
  MOCK_ANALYTICS.averagePoundsLost - blendMonthly(lostSeries, DEFAULT_START_INDEX, ANCHOR_INDEX);
const retentionOffset =
  MOCK_ANALYTICS.retention - blendMonthly(retentionSeries, DEFAULT_START_INDEX, ANCHOR_INDEX);

export interface OutcomeSummary {
  goalCompletion: number;
  avgPoundsLost: number;
  retention: number;
}

/** Outcome summary for the range: day-weighted blend of the monthly series. */
export function getOutcomeSummary(range: AnalyticsRange): OutcomeSummary {
  const start = clampIndex(toIndex(range.start));
  const end = clampIndex(toIndex(range.end));
  return {
    goalCompletion: round1(blendMonthly(goalSeries, start, end) + goalOffset),
    avgPoundsLost: round1(blendMonthly(lostSeries, start, end) + lostOffset),
    retention: round1(blendMonthly(retentionSeries, start, end) + retentionOffset),
  };
}

// ---------------------------------------------------------------------------
// Enrollment cohorts
// ---------------------------------------------------------------------------

export interface CohortRow {
  /** Cohort month key, e.g. '2026-01'. */
  monthKey: string;
  /** Display label, e.g. 'Jan 2026'. */
  label: string;
  /** Average pounds lost to date by the cohort. */
  avgLost: number;
  /** Retention percentage to date. */
  retention: number;
  /** True while the cohort is still inside the six-week protocol at the
   * demo anchor — its numbers are progress, not final outcomes. */
  inProgress: boolean;
}

/**
 * One cohort per 2026 enrollment month. Jan–Apr keep the legacy figures
 * (relabeled to the demo year — the old table stamped them "2024"); Jul and
 * Aug cohorts are still mid-protocol at the Aug 22 anchor, so their
 * to-date losses are honestly partial.
 */
const COHORT_OUTCOMES: CohortRow[] = [
  ...MOCK_ANALYTICS.cohortOutcomes.map((cohort, m) => ({
    monthKey: `2026-${String(m + 1).padStart(2, '0')}`,
    label: `${cohort.month} 2026`,
    avgLost: cohort.avgLost,
    retention: cohort.retention,
    inProgress: false,
  })),
  { monthKey: '2026-05', label: 'May 2026', avgLost: 24.6, retention: 94, inProgress: false },
  { monthKey: '2026-06', label: 'Jun 2026', avgLost: 25.3, retention: 95, inProgress: false },
  { monthKey: '2026-07', label: 'Jul 2026', avgLost: 19.4, retention: 96, inProgress: true },
  { monthKey: '2026-08', label: 'Aug 2026', avgLost: 8.7, retention: 97, inProgress: true },
];

/** Cohorts whose enrollment month intersects the range, oldest first. */
export function getCohortRows(range: AnalyticsRange): CohortRow[] {
  const start = clampIndex(toIndex(range.start));
  const end = clampIndex(toIndex(range.end));
  return COHORT_OUTCOMES.filter(
    (_, m) => monthBounds[m].first <= end && monthBounds[m].last >= start,
  );
}

// ---------------------------------------------------------------------------
// Growth-opportunity note
// ---------------------------------------------------------------------------

/** The legacy card claimed maintenance conversions were "up 14% this month";
 * the default range keeps that exact figure. */
const CONVERSION_TARGET = 14;

const rawConversionAt = (startIndex: number, endIndex: number) =>
  Math.round(6 + seededFraction(startIndex * 13.7 + endIndex * 3.1) * 12);

const conversionOffset = CONVERSION_TARGET - rawConversionAt(DEFAULT_START_INDEX, ANCHOR_INDEX);

/** Deterministic maintenance-conversion change for the range (percent). */
export function getMaintenanceConversionDelta(range: AnalyticsRange): number {
  const start = clampIndex(toIndex(range.start));
  const end = clampIndex(toIndex(range.end));
  return Math.min(18, Math.max(5, rawConversionAt(start, end) + conversionOffset));
}
