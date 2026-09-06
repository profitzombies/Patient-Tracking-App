/**
 * Patient activity signals — the one definition shared by the live roster
 * and the patient detail record.
 *
 * The roster gets these figures from the office-wide SQL aggregate
 * (provider_patient_activity_summary); the detail page gets them from this
 * TypeScript computation over the patient's raw diary/water/check-in rows.
 * Both follow the definitions below, and a parity test runs them against
 * the same fixture so a staff member comparing the two screens sees the same
 * numbers for the same patient and day.
 *
 * Day bucketing is by the stored date_key (the patient's local day as written
 * by the app); `asOfDate` is the patient's local "today".
 *
 * Zero versus unknown: a family is null when the patient has no rows of that
 * kind up to the as-of day (nothing to summarise yet). Window counts are real
 * zeros only once at least one row exists; averages are null when their
 * window holds no qualifying day.
 */

export const MOOD_KEYS = ["1", "2", "3", "4", "5"] as const;
export type MoodKey = (typeof MOOD_KEYS)[number];
export type MoodCounts = Record<MoodKey, number>;

export interface SideEffectCount {
  name: string;
  count: number;
}

export interface PatientActivitySignals {
  /** Patient-local calendar day the signals were computed for. */
  asOfDate: string;
  /** Seven booleans, oldest -> newest, ending on asOfDate; null = no diary data yet. */
  loggedLast7: boolean[] | null;
  loggedDays7: number | null;
  /** Consecutive logged days ending today (or yesterday while today is still open). */
  mealStreak: number | null;
  /** Rounded mean of per-day calorie totals over logged days in the window. */
  avgCalories7: number | null;
  /** Rounded mean oz over window days with oz > 0. */
  avgWater7: number | null;
  /** Consecutive check-in days ending today or yesterday; null = no check-ins yet. */
  checkInStreak: number | null;
  /** round(100 * check-in days in the 30 days ending asOfDate / 30). */
  checkInRate30: number | null;
  latestCheckInDate: string | null;
  moodCounts: MoodCounts | null;
  /** Up to three, most frequent first, ties alphabetical. */
  topSideEffects: SideEffectCount[] | null;
}

export interface ActivityDiaryRow {
  dateKey: string;
  calories: number;
}
export interface ActivityWaterRow {
  dateKey: string;
  oz: number;
}
export interface ActivityCheckInRow {
  dateKey: string;
  mood: number | null;
  sideEffects: unknown;
}

/** Streaks look back at most this many days (matches the SQL bounded scan). */
export const STREAK_LOOKBACK_DAYS = 400;

const DAY_MS = 24 * 60 * 60 * 1000;

function dayNumber(dateKey: string): number {
  return Math.floor(Date.parse(`${dateKey}T00:00:00Z`) / DAY_MS);
}

function shiftDay(dateKey: string, days: number): string {
  return new Date((dayNumber(dateKey) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** Length of the run of consecutive days ending on `asOf`, or on `asOf - 1`. */
function openStreak(days: Set<string>, asOf: string): number {
  const start = days.has(asOf) ? asOf : days.has(shiftDay(asOf, -1)) ? shiftDay(asOf, -1) : null;
  if (!start) return 0;
  const floor = dayNumber(asOf) - STREAK_LOOKBACK_DAYS;
  let length = 0;
  let cursor = start;
  while (days.has(cursor) && dayNumber(cursor) >= floor) {
    length += 1;
    cursor = shiftDay(cursor, -1);
  }
  return length;
}

function withinWindow(dateKey: string, from: string, to: string): boolean {
  return dateKey >= from && dateKey <= to;
}

export function emptyMoodCounts(): MoodCounts {
  return { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
}

export function computePatientActivity(
  rows: {
    diary: ActivityDiaryRow[];
    water: ActivityWaterRow[];
    checkIns: ActivityCheckInRow[];
  },
  asOfDate: string,
): PatientActivitySignals {
  const windowStart7 = shiftDay(asOfDate, -6);
  const windowStart30 = shiftDay(asOfDate, -29);

  // Diary family -----------------------------------------------------------
  const caloriesByDay = new Map<string, number>();
  for (const row of rows.diary) {
    if (row.dateKey > asOfDate) continue;
    caloriesByDay.set(row.dateKey, (caloriesByDay.get(row.dateKey) ?? 0) + row.calories);
  }
  const diaryDays = new Set(caloriesByDay.keys());
  let loggedLast7: boolean[] | null = null;
  let loggedDays7: number | null = null;
  let mealStreak: number | null = null;
  let avgCalories7: number | null = null;
  if (diaryDays.size > 0) {
    loggedLast7 = Array.from({ length: 7 }, (_, i) => diaryDays.has(shiftDay(windowStart7, i)));
    loggedDays7 = loggedLast7.filter(Boolean).length;
    mealStreak = openStreak(diaryDays, asOfDate);
    const windowTotals = [...caloriesByDay.entries()]
      .filter(([day]) => withinWindow(day, windowStart7, asOfDate))
      .map(([, calories]) => calories);
    avgCalories7 = windowTotals.length
      ? Math.round(windowTotals.reduce((sum, value) => sum + value, 0) / windowTotals.length)
      : null;
  }

  // Water --------------------------------------------------------------------
  const waterWindow = rows.water.filter(
    (row) => withinWindow(row.dateKey, windowStart7, asOfDate) && row.oz > 0,
  );
  const avgWater7 = waterWindow.length
    ? Math.round(waterWindow.reduce((sum, row) => sum + row.oz, 0) / waterWindow.length)
    : null;

  // Check-in family ----------------------------------------------------------
  const checkIns = rows.checkIns.filter((row) => row.dateKey <= asOfDate);
  let checkInStreak: number | null = null;
  let checkInRate30: number | null = null;
  let latestCheckInDate: string | null = null;
  let moodCounts: MoodCounts | null = null;
  let topSideEffects: SideEffectCount[] | null = null;
  if (checkIns.length > 0) {
    const checkInDays = new Set(checkIns.map((row) => row.dateKey));
    latestCheckInDate = [...checkInDays].sort().at(-1) ?? null;
    checkInStreak = openStreak(checkInDays, asOfDate);
    const window30 = checkIns.filter((row) => withinWindow(row.dateKey, windowStart30, asOfDate));
    const window30Days = new Set(window30.map((row) => row.dateKey));
    checkInRate30 = Math.round((100 * window30Days.size) / 30);
    moodCounts = emptyMoodCounts();
    const effectCounts = new Map<string, number>();
    for (const row of window30) {
      const key = row.mood == null ? null : (String(row.mood) as MoodKey);
      if (key && key in moodCounts) moodCounts[key] += 1;
      if (Array.isArray(row.sideEffects)) {
        for (const effect of row.sideEffects) {
          if (typeof effect !== "string") continue;
          effectCounts.set(effect, (effectCounts.get(effect) ?? 0) + 1);
        }
      }
    }
    topSideEffects = [...effectCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, 3);
  }

  return {
    asOfDate,
    loggedLast7,
    loggedDays7,
    mealStreak,
    avgCalories7,
    avgWater7,
    checkInStreak,
    checkInRate30,
    latestCheckInDate,
    moodCounts,
    topSideEffects,
  };
}

// ---------------------------------------------------------------------------
// Mapping the SQL aggregate row (provider_patient_activity_summary) onto the
// same DTO. Every field is nullable on the wire; anything malformed becomes
// null (unknown) rather than a guessed zero.

function intOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }
  return null;
}

function dateOrNull(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function bitmapOrNull(value: unknown): boolean[] | null {
  if (!Array.isArray(value) || value.length !== 7) return null;
  return value.every((item) => typeof item === "boolean") ? (value as boolean[]) : null;
}

function moodCountsOrNull(value: unknown): MoodCounts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const counts = emptyMoodCounts();
  for (const key of MOOD_KEYS) {
    const parsed = intOrNull((value as Record<string, unknown>)[key]);
    if (parsed === null) return null;
    counts[key] = parsed;
  }
  return counts;
}

function sideEffectsOrNull(value: unknown): SideEffectCount[] | null {
  if (!Array.isArray(value)) return null;
  const out: SideEffectCount[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const name = (item as Record<string, unknown>).name;
    const count = intOrNull((item as Record<string, unknown>).count);
    if (typeof name !== "string" || count === null) return null;
    out.push({ name, count });
  }
  return out;
}

/**
 * Signals from one aggregate row. Returns null when the row has no usable
 * as-of day — the caller then reports the whole family as unavailable.
 */
export function activityFromSummaryRow(
  row: Record<string, unknown> | undefined,
  fallbackAsOf: string,
): PatientActivitySignals | null {
  if (!row) return null;
  const asOfDate = dateOrNull(row.as_of_date) ?? fallbackAsOf;
  const loggedLast7 = bitmapOrNull(row.logged_last_7);
  return {
    asOfDate,
    loggedLast7,
    loggedDays7: loggedLast7 ? (intOrNull(row.logged_days_7) ?? loggedLast7.filter(Boolean).length) : null,
    mealStreak: loggedLast7 ? intOrNull(row.meal_streak) : null,
    avgCalories7: loggedLast7 ? intOrNull(row.avg_calories_7) : null,
    avgWater7: intOrNull(row.avg_water_7),
    checkInStreak: intOrNull(row.check_in_streak),
    checkInRate30: intOrNull(row.check_in_rate_30),
    latestCheckInDate: dateOrNull(row.latest_check_in_date),
    moodCounts: moodCountsOrNull(row.mood_counts),
    topSideEffects: sideEffectsOrNull(row.top_side_effects),
  };
}
