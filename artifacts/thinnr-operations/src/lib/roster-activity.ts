/**
 * Live-roster activity row model.
 *
 * The signed-in roster used to fill in whatever the API did not supply with
 * zeros, so "this patient did nothing" and "we did not load it" looked the
 * same and outreach filters acted on the fakes. This module maps the API's
 * explicitly nullable signals (see PatientActivitySignals in lib/office-roster)
 * into a three-way model every cell, filter and sort can reason about:
 *
 *   unknown  — the office aggregate had no row for the patient (status
 *              "unknown"); nothing about their activity is known;
 *   known    — signals are present; within them a family is either a real
 *              value (zero included) or null = "no data of that kind yet".
 *
 * Only the live branch of the roster uses this; the guided demo keeps its
 * seeded LoggingStats untouched.
 */
import type { MoodKey, OfficePatient, PatientActivitySignals } from '@/lib/office-roster';

export type RosterActivity =
  | { kind: 'unknown' }
  | {
      kind: 'known';
      signals: PatientActivitySignals;
      /** Whole days since the latest diary entry on the patient's own calendar; null = never logged. */
      daysSinceLastLog: number | null;
      /** Server's own lapsed verdict — the only thing that may flag outreach. */
      lapsed: boolean;
    };

export const UNAVAILABLE_LABEL = 'Not available';
export const NO_DATA_LABEL = 'No data yet';

function dayDiff(later: string, earlier: string): number {
  return Math.max(0, Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000));
}

export function rosterActivityFor(patient: Pick<OfficePatient, 'operational'>): RosterActivity {
  const operational = patient.operational;
  const signals = operational?.activity;
  if (!operational || !signals) return { kind: 'unknown' };
  const asOf = operational.asOfDate ?? signals.asOfDate;
  const latestDiary = operational.latestDiaryDate;
  return {
    kind: 'known',
    signals,
    daysSinceLastLog: latestDiary ? dayDiff(asOf, latestDiary) : null,
    lapsed: operational.reasons.includes('logging_lapsed'),
  };
}

/** Lapsed filter: unknown rows are never lapsed — missing data is not silence. */
export function isLiveLapsed(activity: RosterActivity): boolean {
  return activity.kind === 'known' && activity.lapsed;
}

/** 0–100 share of the last 7 days with a diary entry; null while unknown or before any diary data. */
export function loggingRate7(activity: RosterActivity): number | null {
  if (activity.kind !== 'known' || activity.signals.loggedDays7 == null) return null;
  return (activity.signals.loggedDays7 / 7) * 100;
}

/**
 * Logging sort comparator for one direction. Known rows order by 7-day rate
 * (ties: longer silence first when ascending); rows whose rate is unknown
 * always sink to the bottom regardless of direction, so a "lowest logging"
 * sort never leads with patients we simply have no data for.
 */
export function compareLiveLogging(a: RosterActivity, b: RosterActivity, order: 'asc' | 'desc'): number {
  const rateA = loggingRate7(a);
  const rateB = loggingRate7(b);
  if (rateA == null && rateB == null) return 0;
  if (rateA == null) return 1;
  if (rateB == null) return -1;
  let comparison = rateA - rateB;
  if (comparison === 0) {
    const silenceA = a.kind === 'known' ? (a.daysSinceLastLog ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    const silenceB = b.kind === 'known' ? (b.daysSinceLastLog ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    comparison = silenceB - silenceA;
  }
  return order === 'asc' ? comparison : -comparison;
}

export function liveLastLogLabel(activity: RosterActivity): string {
  if (activity.kind !== 'known') return UNAVAILABLE_LABEL;
  const days = activity.daysSinceLastLog;
  if (days === null) return 'No logs yet';
  if (days === 0) return 'Logged today';
  if (days === 1) return 'Logged yesterday';
  return `Last log ${days}d ago`;
}

export const MOOD_KEYS: MoodKey[] = ['1', '2', '3', '4', '5'];

export function moodTotal(counts: Record<MoodKey, number>): number {
  return MOOD_KEYS.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
}

/** Plain-language summary of a mood distribution for titles and screen readers. */
export function describeMoods(counts: Record<MoodKey, number> | null): string {
  if (!counts) return `Mood: ${NO_DATA_LABEL.toLowerCase()}`;
  const total = moodTotal(counts);
  if (total === 0) return 'Mood: no check-ins in the last 30 days';
  return `Mood over ${total} check-in${total === 1 ? '' : 's'}: ${MOOD_KEYS.map((key) => `${key}/5 ×${counts[key] ?? 0}`).join(', ')}`;
}

export function describeSideEffects(effects: Array<{ name: string; count: number }> | null): string {
  if (!effects) return `Side effects: ${NO_DATA_LABEL.toLowerCase()}`;
  if (effects.length === 0) return 'Side effects: none reported in the last 30 days';
  return `Top side effects: ${effects.map((effect) => `${effect.name} ×${effect.count}`).join(', ')}`;
}

export function formatDayCount(value: number | null, unit = 'day'): string {
  if (value == null) return NO_DATA_LABEL;
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}
