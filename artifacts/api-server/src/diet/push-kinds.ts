/**
 * Diet notification kinds and the copy that may leave for the push vendor.
 *
 * Two layers, deliberately different:
 *
 *   - The OUTBOX ROW (staff_notifications / patient notifications) keeps the
 *     specific kind (`diet_allergy_severe`, `diet_pregnancy_warning`, …) and a
 *     specific title / body. Rows are read only behind sign-in, so the bell
 *     and the in-app list can say what actually happened.
 *   - The PUSH MESSAGE that goes through Expo (no BAA) carries a generic,
 *     non-clinical kind and copy, plus the ids the app needs to open the
 *     authenticated record. Nothing in it names a diet, an allergy, a
 *     pregnancy or a screening answer, and staff pushes carry no patient id.
 *
 * Kept dependency-free so both senders can import it without pulling in the
 * enqueue side.
 */

// ── Staff (care-team) kinds ─────────────────────────────────────────────────

export const DIET_STAFF_KINDS = ["diet_change", "diet_safety", "diet_allergy_severe"] as const;
export type DietStaffKind = (typeof DIET_STAFF_KINDS)[number];
export function isDietStaffKind(value: unknown): value is DietStaffKind {
  return typeof value === "string" && (DIET_STAFF_KINDS as readonly string[]).includes(value);
}

/** Row copy (authenticated store only): names the event, never the patient, diet, answer or allergen. */
export const DIET_STAFF_ROW_COPY: Record<DietStaffKind, { title: string; body: string }> = {
  diet_change: { title: "A patient's eating plan changed", body: "A patient on your roster chose or was moved to a different eating plan today. Open the app to review." },
  diet_safety: { title: "A patient's eating plan needs review", body: "A patient's eating-plan choice or screening answer needs your attention today. Open the app." },
  diet_allergy_severe: { title: "A patient recorded a severe allergy", body: "A patient on your roster added a severe allergy today. Open the app to review their record." },
};

/** What the vendor sees for ANY diet staff row: one generic kind and one generic sentence. */
export const DIET_STAFF_PUSH_KIND = "patient_record_review";
export const DIET_STAFF_PUSH = {
  title: "A patient record needs your review",
  body: "Something on a patient's record changed today. Open the app to review it.",
} as const;

// ── Patient kinds ───────────────────────────────────────────────────────────

export const DIET_PATIENT_KINDS = ["diet_changed_by_provider", "diet_pregnancy_warning"] as const;
export type DietPatientKind = (typeof DIET_PATIENT_KINDS)[number];
export function isDietPatientKind(value: unknown): value is DietPatientKind {
  return typeof value === "string" && (DIET_PATIENT_KINDS as readonly string[]).includes(value);
}

/** Row copy (authenticated in-app list only). */
export const DIET_PATIENT_ROW_COPY: Record<DietPatientKind, { category: "office_reminders" | "account"; title: string; body: string }> = {
  diet_changed_by_provider: { category: "office_reminders", title: "Your eating plan was updated", body: "Your care team updated your eating plan. Open the app to see what changed." },
  diet_pregnancy_warning: { category: "account", title: "Please review your eating plan", body: "Based on an answer you gave, your current eating plan may not be recommended right now. Open the app to review it with your care team." },
};

/** What the vendor sees for ANY diet patient row: one generic kind and one generic sentence. */
export const DIET_PATIENT_PUSH_KIND = "account_update";
export const DIET_PATIENT_PUSH = {
  title: "There's an update for you",
  body: "Your care team has an update for you. Open the app to see it.",
} as const;
