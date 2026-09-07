/**
 * Stall-nudge trigger — the one shared decision behind the coach's proactive
 * outreach when weight stalls while the food diary keeps drifting off-plan.
 *
 * Both apps read the SAME rules: this file and the operations dashboard's
 * `src/data/stall-nudge.ts` are deliberate near-copies, and the demo-parity
 * suite pins their agreement for the shared demo patient. The mobile side
 * keys diary entries by seeded library ids; the staff side keys the same
 * dishes by name — the two verdict maps must stay pairwise identical.
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
 *
 * Cooldown, stop-on-engagement, and opt-out live with the patient's persisted
 * state (PatientContext), not here: this module answers "do the signals say
 * nudge?", the context answers "has this patient already been nudged, replied,
 * or asked us to stop?".
 */
import { isApprovedFood } from './approved-foods';
import type { MealLogEntry } from './patient-data';

export type EntryVerdict = 'aligned' | 'off_plan' | 'neutral' | 'unknown';

// ─── Thresholds (kept in lockstep with the operations copy) ─────────────────

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
/** At most one fresh nudge per this many days (enforced by the app state). */
export const NUDGE_COOLDOWN_DAYS = 14;

export function isOutreachMessageId(id: string): boolean {
  return id === 'coach-outreach' || id.startsWith('coach-outreach:');
}

/**
 * The outreach offer's closing question — the exact tail of the coach's
 * proactive message. The api server keys its back-on-track follow-up branch
 * on this precise string (artifacts/api-server/src/coach/back-on-track.ts);
 * the stall-nudge verify suite asserts the two stay byte-identical. Ends
 * with "?" deliberately: the outreach bubble carries its own quick replies.
 */
/** Persisted outreach bookkeeping the seeding decision reads. */
export interface OutreachGateState {
  /** Patient turned proactive nudges off (check-in note or decline chips). */
  optOut: boolean;
  /** Patient replied to the outreach bubble this episode. */
  engaged: boolean;
  /** Anchor day of the last outreach actually seeded, or null if never. */
  lastSentKey: string | null;
  /** Crossing day of the episode that outreach belonged to. */
  lastCrossingKey: string | null;
}

/**
 * The SEND gate: may the coach send this episode's outreach now? At most one
 * send per episode — `recordNudgeSent` stamps `lastCrossingKey`, so a stamped
 * episode never sends again, answered or not — and sends across episodes are
 * spaced by the cooldown window anchored on `lastSentKey`.
 */
export function shouldSendOutreach(
  assessment: NudgeAssessment,
  gate: OutreachGateState,
  todayKey: string,
  cooldownDays: number = NUDGE_COOLDOWN_DAYS,
): boolean {
  if (!assessment.active || gate.optOut) return false;
  const crossing = assessment.crossedOnKey;
  if (crossing === null) return false;
  if (gate.lastCrossingKey === crossing) return false;
  return (
    gate.lastSentKey === null || dayDiff(gate.lastSentKey, todayKey) >= cooldownDays
  );
}

/**
 * The STANDING-MESSAGE rule: the persisted gate says this episode's outreach
 * was already sent (`lastCrossingKey` matches) and stands unanswered. Chat
 * history is session-only, so a reopened thread re-renders that same single
 * message — persisted conversation state, not a second send. `recordNudgeSent`
 * is idempotent per episode, so re-rendering never moves the cooldown anchor.
 */
export function shouldRenderStandingOutreach(
  assessment: NudgeAssessment,
  gate: OutreachGateState,
): boolean {
  if (!assessment.active || gate.optOut || gate.engaged) return false;
  const crossing = assessment.crossedOnKey;
  return crossing !== null && gate.lastCrossingKey === crossing;
}

/**
 * What the chat thread consumes: show the outreach when it is due to send OR
 * when the already-sent episode's message still stands unanswered.
 */
export function shouldSeedOutreach(
  assessment: NudgeAssessment,
  gate: OutreachGateState,
  todayKey: string,
): boolean {
  return (
    shouldSendOutreach(assessment, gate, todayKey) ||
    shouldRenderStandingOutreach(assessment, gate)
  );
}

export const BACK_ON_TRACK_OFFER =
  'Want me to set up a short reset, a few days of approved meals, daily logging, and a provider check-in if you want one?';

// ─── Entry classification (curated against the THINNR approved list) ────────

/**
 * Zero-calorie sips the program explicitly leaves alone — logged, but never
 * evidence for or against the plan.
 */
const NEUTRAL_FOOD_IDS = new Set(['fd_coffee', 'fd_sparkling']);

/**
 * Curated verdicts for the seeded recipe library, judged ingredient-by-
 * ingredient against data/approved-foods.ts. `aligned` means every material
 * ingredient is on the list (Normalization additions included — the demo
 * patients are past day 43); `off_plan` names the ingredient that is not.
 * The staff dashboard keys the same dishes by display name.
 */
export const RECIPE_VERDICTS: Record<string, EntryVerdict> = {
  rec_yogurt_bowl: 'off_plan', // honey; Greek yogurt is not on the list
  rec_egg_scramble: 'aligned',
  rec_overnight_oats: 'off_plan', // rolled oats are not an approved grain
  rec_avocado_toast: 'off_plan', // generic bread is not among the approved breads
  rec_cottage_parfait: 'off_plan', // honey; cottage cheese is not on the list
  rec_cobb_salad: 'off_plan', // feta and balsamic vinaigrette
  rec_quinoa_bowl: 'aligned', // quinoa + sweet potato are Normalization foods
  rec_tuna_wrap: 'off_plan', // wheat wrap is not among the approved breads
  rec_lentil_soup: 'aligned', // lentils are Normalization foods
  rec_shrimp_zoodles: 'aligned',
  rec_baked_salmon: 'aligned',
  rec_roast_chicken: 'aligned', // carrots are approved (3 oz portion)
  rec_turkey_meatballs: 'off_plan', // jarred marinara sauce
  rec_seared_cod: 'off_plan', // butter — the list allows alternatives, not butter
  rec_beef_stirfry: 'off_plan', // soy sauce — the list names Braggs as the alternative
  rec_energy_bites: 'off_plan', // honey, chocolate chips, oats
  rec_cucumber_hummus: 'off_plan', // hummus is not on the list
  rec_apple_almond: 'aligned', // apple + raw almonds are approved
  rec_boiled_eggs: 'aligned', // eggs are Normalization foods
  rec_protein_smoothie: 'off_plan', // banana and cocoa are not on the list
};

/**
 * Verdict for one diary entry. Library foods lean on the approved-foods
 * matcher; seeded recipes carry curated verdicts; anything without a known
 * identity (quick adds, custom foods, saved AI recipes) is unknown — a
 * homemade meal is never presumed off-plan.
 */
export function classifyEntry(entry: Pick<MealLogEntry, 'kind' | 'refId'>): EntryVerdict {
  if (entry.kind === 'recipe') {
    return (entry.refId !== undefined ? RECIPE_VERDICTS[entry.refId] : undefined) ?? 'unknown';
  }
  if (entry.kind === 'food') {
    if (entry.refId === undefined || !entry.refId.startsWith('fd_')) return 'unknown';
    if (NEUTRAL_FOOD_IDS.has(entry.refId)) return 'neutral';
    return isApprovedFood(entry.refId) ? 'aligned' : 'off_plan';
  }
  return 'unknown';
}

// ─── Signal evaluation (shared math — keep identical to the web copy) ───────

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

/** Adapter from diary entries to the classifier-tagged shape the math reads. */
export function classifyEntries(
  entries: readonly Pick<MealLogEntry, 'dateKey' | 'kind' | 'refId'>[],
): ClassifiedEntry[] {
  return entries.map((entry) => ({ dateKey: entry.dateKey, verdict: classifyEntry(entry) }));
}
