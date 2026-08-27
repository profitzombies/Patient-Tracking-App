/**
 * Stall-nudge trigger — the one shared decision behind the coach's proactive
 * outreach when weight stalls while the food diary keeps drifting off-plan.
 *
 * Both apps read the SAME rules: this file and the mobile app's
 * `data/stall-nudge.ts` are deliberate near-copies, and the demo-parity suite
 * pins their agreement for the shared demo patient. The mobile side keys
 * diary entries by seeded library ids; this side keys the same dishes by
 * display name — the two verdict maps must stay pairwise identical.
 *
 * Decision shape (all thresholds exported for the verify suites):
 * - Adherence: over the last ADHERENCE_WINDOW_DAYS, look at entries with a
 *   curated verdict. `repeatedOffPlan` needs enough logging activity, enough
 *   classified entries, and an off-plan share past the floor. Sparse logging
 *   or unclassifiable food never qualifies — quiet data is unknown, not
 *   evidence of drift.
 * - Stall: over the last STALL_WINDOW_DAYS of weigh-ins, compare the median
 *   of the older half of readings against the newer half. Medians damp the
 *   normal day-to-day bounce; too few readings, a short span, or a silent
 *   recent tail mean UNKNOWN, which never counts as stalled.
 * - The nudge is active only when BOTH hold. `crossedOnKey` walks the same
 *   math back day by day to date the current episode, so every surface
 *   (coach outreach, check-in note, staff roster and detail page) tells one
 *   consistent story about when the signals crossed.
 */
import type { Patient } from './mock-data';
import { TODAY_KEY, getNutritionProfile } from './nutrition-data';

export type EntryVerdict = 'aligned' | 'off_plan' | 'neutral' | 'unknown';

// ─── Thresholds (kept in lockstep with the mobile copy) ─────────────────────

/** Diary window for the adherence signal. */
export const ADHERENCE_WINDOW_DAYS = 14;
/** Weigh-in window for the plateau signal — the "2 to 3 weeks" of the brief. */
export const STALL_WINDOW_DAYS = 21;
/** Fewest days with any diary entry before adherence is judged at all. */
export const MIN_LOGGED_DAYS = 8;
/** Fewest verdict-bearing entries before the off-plan share means anything. */
export const MIN_CLASSIFIED_ENTRIES = 12;
/** "Repeated" means at least this many off-plan entries in the window... */
export const MIN_OFF_PLAN_ENTRIES = 6;
/** ...and at least this share of everything classifiable. */
export const MIN_OFF_PLAN_SHARE = 0.34;
/** Fewest weigh-ins in the stall window before the trend is judged. */
export const MIN_WEIGH_INS = 4;
/** The readings must cover most of the window, not one busy weekend. */
export const MIN_WEIGH_IN_SPAN_DAYS = 12;
/** A silent scale recently means unknown, never stalled. */
export const MAX_NEWEST_WEIGH_IN_AGE_DAYS = 5;
/**
 * Older-half median minus newer-half median at or below this is a stall.
 * Chosen against the seeded records: the plateau cases measure ≈ 0.2 while
 * the slowest genuinely-declining curves still measure ≥ 0.8, so this sits
 * between them with the plateau side favored.
 */
export const STALL_MAX_DROP_LB = 0.5;
/** How far back the episode date is traced before giving up. */
export const CROSSING_LOOKBACK_DAYS = 28;
/** At most one fresh nudge per this many days (enforced by the patient app). */
export const NUDGE_COOLDOWN_DAYS = 14;

// ─── Entry classification (curated against the THINNR approved list) ────────

/**
 * Curated verdicts for the seeded dishes, judged ingredient-by-ingredient
 * against the approved-foods list. `aligned` means every material ingredient
 * is on the list (Normalization additions included — the demo patients are
 * past day 43); `off_plan` names the ingredient that is not; the zero-calorie
 * sips are neutral by design. The mobile app keys the same dishes by library
 * id — the verdicts must stay pairwise identical.
 */
export const DISH_VERDICTS: Record<string, EntryVerdict> = {
  'Greek Yogurt Protein Bowl': 'off_plan', // honey; Greek yogurt is not on the list
  'Spinach & Egg White Scramble': 'aligned',
  'Blueberry Overnight Oats': 'off_plan', // rolled oats are not an approved grain
  'Avocado Toast with Poached Egg': 'off_plan', // generic bread is not among the approved breads
  'Cottage Cheese Berry Parfait': 'off_plan', // honey; cottage cheese is not on the list
  'Grilled Chicken Cobb Salad': 'off_plan', // feta and balsamic vinaigrette
  'Turkey & Quinoa Power Bowl': 'aligned', // quinoa + sweet potato are Normalization foods
  'Mediterranean Tuna Wrap': 'off_plan', // wheat wrap is not among the approved breads
  'Lentil & Vegetable Soup': 'aligned', // lentils are Normalization foods
  'Shrimp & Zucchini Noodle Bowl': 'aligned',
  'Baked Salmon & Asparagus': 'aligned',
  'Herb Roast Chicken & Vegetables': 'aligned', // carrots are approved (3 oz portion)
  'Turkey Meatballs & Zoodles': 'off_plan', // jarred marinara sauce
  'Seared Cod & Broccolini': 'off_plan', // butter — the list allows alternatives, not butter
  'Lean Beef Stir-Fry': 'off_plan', // soy sauce — the list names Braggs as the alternative
  'Almond Energy Bites': 'off_plan', // honey, chocolate chips, oats
  'Cucumber Hummus Bites': 'off_plan', // hummus is not on the list
  'Apple & Almond Butter': 'aligned', // apple + raw almonds are approved
  'Seasoned Hard-Boiled Eggs': 'aligned', // eggs are Normalization foods
  'Chocolate Protein Smoothie': 'off_plan', // banana and cocoa are not on the list
  'Coffee, black': 'neutral',
  'Apple': 'aligned',
  'Sparkling Water': 'neutral',
};

/** Verdict for one logged meal; dishes outside the seeded pools are unknown. */
export function classifyMealName(name: string): EntryVerdict {
  return DISH_VERDICTS[name] ?? 'unknown';
}

// ─── Signal evaluation (shared math — keep identical to the mobile copy) ────

export interface ClassifiedEntry {
  dateKey: string;
  verdict: EntryVerdict;
}

export interface WeighIn {
  dateKey: string;
  weight: number;
}

export interface AdherenceSignal {
  /** Days in the window with at least one diary entry of any kind. */
  loggedDays: number;
  /** Entries carrying an aligned or off-plan verdict. */
  classified: number;
  offPlan: number;
  /** offPlan / classified, or null when nothing was classifiable. */
  offPlanShare: number | null;
  repeatedOffPlan: boolean;
}

export interface StallSignal {
  weighIns: number;
  spanDays: number;
  /** Days since the newest reading, or null with no readings at all. */
  newestAgeDays: number | null;
  /** Older-half median minus newer-half median, or null when unjudgeable. */
  dropLb: number | null;
  stalled: boolean;
}

export interface NudgeAssessment {
  adherence: AdherenceSignal;
  stall: StallSignal;
  /** Both signals hold as of the evaluation day. */
  active: boolean;
  /** First day of the current contiguous active streak, or null when inactive. */
  crossedOnKey: string | null;
}

function keyToUtcMs(dateKey: string): number {
  return new Date(`${dateKey}T12:00:00.000Z`).getTime();
}

/** dateKey shifted by whole days, immune to the viewer's timezone and DST. */
export function shiftDateKey(dateKey: string, days: number): string {
  return new Date(keyToUtcMs(dateKey) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `fromKey` to `toKey` (positive when toKey is later). */
export function dayDiff(fromKey: string, toKey: string): number {
  return Math.round((keyToUtcMs(toKey) - keyToUtcMs(fromKey)) / 86_400_000);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function evaluateAdherence(entries: readonly ClassifiedEntry[], asOfKey: string): AdherenceSignal {
  const fromKey = shiftDateKey(asOfKey, -(ADHERENCE_WINDOW_DAYS - 1));
  const loggedDayKeys = new Set<string>();
  let classified = 0;
  let offPlan = 0;
  for (const entry of entries) {
    if (entry.dateKey < fromKey || entry.dateKey > asOfKey) continue;
    loggedDayKeys.add(entry.dateKey);
    if (entry.verdict === 'aligned') {
      classified += 1;
    } else if (entry.verdict === 'off_plan') {
      classified += 1;
      offPlan += 1;
    }
  }
  const offPlanShare = classified > 0 ? offPlan / classified : null;
  const repeatedOffPlan =
    loggedDayKeys.size >= MIN_LOGGED_DAYS &&
    classified >= MIN_CLASSIFIED_ENTRIES &&
    offPlan >= MIN_OFF_PLAN_ENTRIES &&
    offPlanShare !== null &&
    offPlanShare >= MIN_OFF_PLAN_SHARE;
  return { loggedDays: loggedDayKeys.size, classified, offPlan, offPlanShare, repeatedOffPlan };
}

export function evaluateStall(weighIns: readonly WeighIn[], asOfKey: string): StallSignal {
  const fromKey = shiftDateKey(asOfKey, -(STALL_WINDOW_DAYS - 1));
  const inWindow = weighIns
    .filter((reading) => reading.dateKey >= fromKey && reading.dateKey <= asOfKey)
    .sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));
  if (inWindow.length === 0) {
    return { weighIns: 0, spanDays: 0, newestAgeDays: null, dropLb: null, stalled: false };
  }
  const spanDays = dayDiff(inWindow[0].dateKey, inWindow[inWindow.length - 1].dateKey);
  const newestAgeDays = dayDiff(inWindow[inWindow.length - 1].dateKey, asOfKey);
  if (
    inWindow.length < MIN_WEIGH_INS ||
    spanDays < MIN_WEIGH_IN_SPAN_DAYS ||
    newestAgeDays > MAX_NEWEST_WEIGH_IN_AGE_DAYS
  ) {
    return { weighIns: inWindow.length, spanDays, newestAgeDays, dropLb: null, stalled: false };
  }
  const half = Math.floor(inWindow.length / 2);
  const olderMedian = median(inWindow.slice(0, half).map((reading) => reading.weight));
  const newerMedian = median(inWindow.slice(inWindow.length - half).map((reading) => reading.weight));
  const dropLb = parseFloat((olderMedian - newerMedian).toFixed(2));
  return {
    weighIns: inWindow.length,
    spanDays,
    newestAgeDays,
    dropLb,
    stalled: dropLb <= STALL_MAX_DROP_LB,
  };
}

/**
 * The full trigger read as of `todayKey`. When active, the episode is dated
 * by re-running both signals on earlier days until one goes quiet.
 */
export function assessNudge(
  entries: readonly ClassifiedEntry[],
  weighIns: readonly WeighIn[],
  todayKey: string,
): NudgeAssessment {
  const activeOn = (asOfKey: string): boolean => {
    const adherence = evaluateAdherence(entries, asOfKey);
    if (!adherence.repeatedOffPlan) return false;
    return evaluateStall(weighIns, asOfKey).stalled;
  };
  const adherence = evaluateAdherence(entries, todayKey);
  const stall = evaluateStall(weighIns, todayKey);
  const active = adherence.repeatedOffPlan && stall.stalled;
  let crossedOnKey: string | null = null;
  if (active) {
    crossedOnKey = todayKey;
    for (let back = 1; back <= CROSSING_LOOKBACK_DAYS; back++) {
      const earlierKey = shiftDateKey(todayKey, -back);
      if (!activeOn(earlierKey)) break;
      crossedOnKey = earlierKey;
    }
  }
  return { adherence, stall, active, crossedOnKey };
}

// ─── Staff-side assessment (derived from the seeded nutrition profile) ──────

const assessmentCache = new Map<string, NudgeAssessment>();

/**
 * The trigger read for one patient, derived from the same seeded diary and
 * check-in records the rest of the dashboard renders. Deterministic, so it is
 * cached per patient for roster-wide sweeps.
 */
export function getNudgeAssessment(patient: Patient): NudgeAssessment {
  const cached = assessmentCache.get(patient.id);
  if (cached) return cached;
  const profile = getNutritionProfile(patient);
  const entries: ClassifiedEntry[] = [];
  const weighIns: WeighIn[] = [];
  for (const day of profile.days) {
    for (const meal of day.meals) {
      entries.push({ dateKey: day.dateKey, verdict: classifyMealName(meal.name) });
    }
    if (typeof day.checkIn?.weight === 'number') {
      weighIns.push({ dateKey: day.dateKey, weight: day.checkIn.weight });
    }
  }
  const assessment = assessNudge(entries, weighIns, TODAY_KEY);
  assessmentCache.set(patient.id, assessment);
  return assessment;
}
