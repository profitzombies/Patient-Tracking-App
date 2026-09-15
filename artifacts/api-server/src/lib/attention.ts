/** Pure, ordered evaluation of the facts that make an active patient need staff attention. */
export const ATTENTION_REASON_CODES = [
  "no_weight",
  "no_meals",
  "no_water",
  "no_medication_doses",
  "weight_stalled",
  "check_in_overdue",
  "no_activity_14d",
] as const;

export type AttentionReasonCode = (typeof ATTENTION_REASON_CODES)[number];

export const ATTENTION_LABELS: Record<AttentionReasonCode, string> = {
  no_weight: "No weight logged",
  no_meals: "No meals logged",
  no_water: "No water logged",
  no_medication_doses: "No medication doses logged",
  weight_stalled: "Weight stalled",
  check_in_overdue: "Check-in overdue",
  no_activity_14d: "No activity in 14 days",
};

export const ATTENTION_THRESHOLDS = {
  weightDays: 7,
  mealsDays: 3,
  waterDays: 3,
  medicationDays: 3,
  checkInDays: 7,
  activityDays: 14,
  stallMinimumDays: 3,
} as const;

export interface AttentionFacts {
  asOfDate: string;
  activationStatus: string | null;
  pendingDeletion?: boolean;
  /** False means the aggregate was not loaded: all activity-derived signals stay unknown. */
  activityKnown: boolean;
  accountCreatedDate: string | null;
  programStartDate: string | null;
  latestWeightDate: string | null;
  latestDiaryDate: string | null;
  latestWaterDate: string | null;
  latestCheckInDate: string | null;
  latestActivityDate: string | null;
  /** Start dates of schedules active on asOfDate. */
  activeMedicationStartDates?: string[];
  latestMedicationDoseDate?: string | null;
  stall?: { stalled?: boolean } | null;
  stallCrossedOnDate?: string | null;
  stallAsOfDate?: string | null;
}

export interface AttentionReason {
  code: AttentionReasonCode;
  label: string;
  days: number | null;
}

export interface AttentionResult {
  flagged: boolean;
  reasons: AttentionReason[];
  signature: string | null;
}

function dayNumber(key: string | null | undefined): number | null {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const value = Date.parse(`${key}T00:00:00Z`);
  return Number.isFinite(value) ? Math.floor(value / 86_400_000) : null;
}

export function attentionDaysSince(date: string | null | undefined, asOfDate: string): number | null {
  const from = dayNumber(date);
  const to = dayNumber(asOfDate);
  return from === null || to === null ? null : Math.max(0, to - from);
}

export function attentionSignature(reasons: readonly Pick<AttentionReason, "code">[]): string | null {
  return reasons.length ? reasons.map((reason) => reason.code).sort().join(",") : null;
}

export function evaluateAttention(facts: AttentionFacts): AttentionResult {
  if (facts.activationStatus !== "activated" || facts.pendingDeletion || !facts.activityKnown) {
    return { flagged: false, reasons: [], signature: null };
  }
  const accountAge = attentionDaysSince(facts.accountCreatedDate, facts.asOfDate) ?? 0;
  const programAge = attentionDaysSince(facts.programStartDate, facts.asOfDate) ?? accountAge;
  const age = Math.max(accountAge, programAge);
  const reasons: AttentionReason[] = [];
  const add = (code: AttentionReasonCode, days: number | null) =>
    reasons.push({ code, label: ATTENTION_LABELS[code], days });
  const stale = (date: string | null, threshold: number) => {
    const days = attentionDaysSince(date, facts.asOfDate);
    return { days, yes: days === null || days >= threshold };
  };

  const weight = stale(facts.latestWeightDate, ATTENTION_THRESHOLDS.weightDays);
  if (age >= ATTENTION_THRESHOLDS.weightDays && weight.yes) add("no_weight", weight.days);
  const meals = stale(facts.latestDiaryDate, ATTENTION_THRESHOLDS.mealsDays);
  if (age >= ATTENTION_THRESHOLDS.mealsDays && meals.yes) add("no_meals", meals.days);
  const water = stale(facts.latestWaterDate, ATTENTION_THRESHOLDS.waterDays);
  if (age >= ATTENTION_THRESHOLDS.waterDays && water.yes) add("no_water", water.days);

  const activeStarts = (facts.activeMedicationStartDates ?? []).filter((date) => dayNumber(date) !== null);
  if (activeStarts.length) {
    const sortedStarts = activeStarts.sort();
    const latestStart = sortedStarts[sortedStarts.length - 1]!;
    const baseline =
      facts.latestMedicationDoseDate && facts.latestMedicationDoseDate > latestStart
        ? facts.latestMedicationDoseDate
        : latestStart;
    const days = attentionDaysSince(baseline, facts.asOfDate);
    if (days !== null && days >= ATTENTION_THRESHOLDS.medicationDays) add("no_medication_doses", days);
  }

  if (facts.stall?.stalled === true) {
    const days = attentionDaysSince(facts.stallCrossedOnDate ?? facts.stallAsOfDate, facts.asOfDate);
    add("weight_stalled", Math.max(ATTENTION_THRESHOLDS.stallMinimumDays, days ?? 0));
  }
  const checkIn = stale(facts.latestCheckInDate, ATTENTION_THRESHOLDS.checkInDays);
  if (age >= ATTENTION_THRESHOLDS.checkInDays && checkIn.yes) add("check_in_overdue", checkIn.days);
  const activity = stale(facts.latestActivityDate, ATTENTION_THRESHOLDS.activityDays);
  if (accountAge >= ATTENTION_THRESHOLDS.activityDays && activity.yes) add("no_activity_14d", activity.days);

  return { flagged: reasons.length > 0, reasons, signature: attentionSignature(reasons) };
}