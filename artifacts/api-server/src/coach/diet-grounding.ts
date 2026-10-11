/**
 * Diet grounding for the coach — the signed-in patient's diet, phase, four
 * food lists, screening cautions, per-diet settings and the honest limits
 * of what the coach may claim, rendered as ONE canonical block appended to
 * the patient line of the system prompt.
 *
 * Only real accounts carry this (the loader runs from real-patient.ts); the
 * demo persona's prompt stays byte-identical. The block is rendered in a
 * fixed order from the same inputs so the provider's prompt cache keeps
 * reusing it across turns until something about the diet actually changes.
 *
 * Failures THROW, like the rest of the real-patient grounding: a signed-in
 * patient is never coached as though they had no allergies on record.
 */
import {
  DIET_DISCLAIMER,
  JUST_TRACKING_SLUG,
  RESTRICTION_BY_KEY,
  SENSITIVITY_BY_KEY,
  isScreeningAnswer,
  isScreeningQuestion,
  programDayBetween,
  type AllergySeverity,
  type ClassifierContext,
  type DietFitRules,
  type PreferenceItemInput,
  type PreferenceList,
  type ProgramPhase,
  type ScreeningQuestion,
} from "@workspace/diet-programs";
import { supabaseAdmin } from "../lib/supabase-admin";
import { fitRulesBySlug, loadLibraryRows, loadLibrarySettings, type DietLibraryRow } from "../diet/library";
import { PREFERENCE_SELECT, preferenceRecord, type PreferenceRecord } from "../diet/store";
import type { PatientDayTargets } from "./prompt";

const enc = encodeURIComponent;

export interface DietListItem {
  list: PreferenceList;
  key: string;
  label: string;
  custom: boolean;
  severity: AllergySeverity | null;
}

export interface DietSummary {
  slug: string;
  name: string;
  summary: string;
  complexity: string;
  ruleSheet: string[];
}

/** A diet change the coach has not yet acknowledged in chat. */
export interface PendingDietAck {
  selectionId: string;
  newName: string;
  newSlug: string;
  /** Name of the diet this one replaced; null for a first choice. */
  previousName: string | null;
}

export interface DietGrounding {
  phase: ProgramPhase;
  /** The active diet (null = nothing chosen yet; "just tracking" is a diet here). */
  diet: DietSummary | null;
  /** HQ-edited fit rules by slug, read by the classifier instead of the catalog. */
  fitRules: Record<string, DietFitRules>;
  lists: DietListItem[];
  /** Screening answers that temper advice (medication, pregnancy, eating-disorder history). */
  cautions: string[];
  fastingWindow: { eatingStart: string; eatingEnd: string } | null;
  /** Day N of a Whole30 when the start date is set; null otherwise. */
  whole30Day: number | null;
  disclaimer: string;
  pendingAck: PendingDietAck | null;
}

/**
 * Diets whose curated food data is phase 2: the coach must say so plainly
 * rather than invent thresholds, serving caps or "safe lists".
 */
export const PHASE_TWO_LIMITS: Readonly<Record<string, string>> = {
  low_fodmap: "FODMAP",
  low_histamine: "histamine",
  low_oxalate: "oxalate",
  low_purine: "purine",
};
/** Sensitivities whose specifics are likewise phase 2. */
const PHASE_TWO_SENSITIVITIES: Readonly<Record<string, string>> = { fodmap: "FODMAP", histamine: "histamine" };

export const LOW_GLYCEMIC_SLUG = "low_glycemic";

interface SelectionRow {
  id: string;
  dietSlug: string;
  status: string;
  settings: Record<string, unknown>;
  startedAt: string;
  coachAcknowledgedAt: string | null;
}

export interface RawDietGrounding {
  active: SelectionRow | null;
  previous: SelectionRow | null;
  preferences: PreferenceRecord[];
  answers: Partial<Record<ScreeningQuestion, "yes" | "no" | "skipped">>;
  library: DietLibraryRow[];
  disclaimer: string;
}

function rows(res: { status: number; json: unknown }, what: string): Record<string, unknown>[] {
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`${what} failed (${res.status})`);
  return res.json as Record<string, unknown>[];
}

function selectionRow(row: Record<string, unknown>): SelectionRow {
  return {
    id: String(row.id),
    dietSlug: String(row.diet_slug),
    status: String(row.status),
    settings: row.settings && typeof row.settings === "object" ? (row.settings as Record<string, unknown>) : {},
    startedAt: String(row.started_at ?? ""),
    coachAcknowledgedAt: typeof row.coach_acknowledged_at === "string" ? row.coach_acknowledged_at : null,
  };
}

/** Everything the diet block needs, in one round of parallel reads. */
export async function loadRawDietGrounding(patientId: string): Promise<RawDietGrounding> {
  const scope = `patient_id=eq.${enc(patientId)}`;
  const [selections, prefs, answers, library, settings] = await Promise.all([
    supabaseAdmin(
      "GET",
      `/rest/v1/patient_diet_selections?${scope}&status=in.(active,superseded)&select=id,diet_slug,status,settings,started_at,coach_acknowledged_at&order=started_at.desc&limit=6`,
    ),
    supabaseAdmin("GET", `/rest/v1/patient_preference_items?${scope}&removed_at=is.null&select=${PREFERENCE_SELECT}&order=created_at.asc&limit=500`),
    supabaseAdmin("GET", `/rest/v1/patient_screening_answers?${scope}&select=question,answer,created_at&order=created_at.desc&limit=60`),
    loadLibraryRows(),
    loadLibrarySettings(),
  ]);
  const selectionRows = rows(selections, "diet selection read").map(selectionRow);
  const active = selectionRows.find((s) => s.status === "active") ?? null;
  const previous = selectionRows.find((s) => s.status === "superseded" && (!active || s.startedAt <= active.startedAt)) ?? null;
  const latest: RawDietGrounding["answers"] = {};
  for (const row of rows(answers, "screening answer read")) {
    if (!isScreeningQuestion(row.question) || !isScreeningAnswer(row.answer)) continue;
    if (latest[row.question] === undefined) latest[row.question] = row.answer;
  }
  return {
    active,
    previous,
    preferences: rows(prefs, "preference item read").map(preferenceRecord),
    answers: latest,
    library,
    disclaimer: settings.disclaimer || DIET_DISCLAIMER,
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}

function summaryOf(row: DietLibraryRow | undefined, slug: string): DietSummary {
  if (!row) return { slug, name: slug.replace(/_/g, " "), summary: "", complexity: "moderate", ruleSheet: [] };
  return { slug: row.slug, name: row.name, summary: row.summary ?? "", complexity: String(row.complexity ?? "moderate"), ruleSheet: strings(row.rule_sheet) };
}

/** Shape the raw reads into the grounding for one calendar day and phase. */
export function buildDietGrounding(raw: RawDietGrounding, phase: ProgramPhase, dateKey: string): DietGrounding {
  const bySlug = new Map(raw.library.map((row) => [row.slug, row]));
  const active = raw.active;
  const diet = active ? summaryOf(bySlug.get(active.dietSlug), active.dietSlug) : null;
  const previousName = raw.previous && raw.previous.dietSlug !== active?.dietSlug
    ? summaryOf(bySlug.get(raw.previous.dietSlug), raw.previous.dietSlug).name
    : null;

  const settings = active?.settings ?? {};
  const fw = settings.fastingWindow as { eatingStart?: unknown; eatingEnd?: unknown } | null | undefined;
  const fastingWindow = active?.dietSlug === "intermittent_fasting" && fw && typeof fw.eatingStart === "string" && typeof fw.eatingEnd === "string"
    ? { eatingStart: fw.eatingStart, eatingEnd: fw.eatingEnd }
    : null;
  const whole30Start = typeof settings.whole30StartDate === "string" ? settings.whole30StartDate : null;
  // Whole30 counts the start date as day 1; programDayBetween counts elapsed days.
  const whole30Day = active?.dietSlug === "whole30" && whole30Start && whole30Start <= dateKey
    ? (whole30Start === dateKey ? 1 : programDayBetween(whole30Start, dateKey) + 1)
    : null;

  const cautions: string[] = [];
  if (raw.answers.medication === "yes") cautions.push("takes medication that can interact with diet changes (ask them to loop in their care team before big shifts)");
  if (raw.answers.pregnancy === "yes") cautions.push("is pregnant, trying to conceive, or breastfeeding (never suggest fasting, very low calories, or elimination resets)");
  if (raw.answers.eating_disorder === "yes") cautions.push("has a history of disordered eating (no restriction framing, no fasting or strict elimination suggestions; keep the tone steady and non-numeric where you can)");

  // A diet change is acknowledged once: any unacknowledged active choice,
  // except "just tracking" picked fresh (there is nothing to acknowledge
  // until it replaces a real diet).
  const pendingAck: PendingDietAck | null =
    active && diet && active.coachAcknowledgedAt === null && (active.dietSlug !== JUST_TRACKING_SLUG || previousName !== null)
      ? { selectionId: active.id, newName: diet.name, newSlug: diet.slug, previousName }
      : null;

  return {
    phase,
    diet,
    fitRules: fitRulesBySlug(raw.library),
    lists: raw.preferences.map((p) => ({ list: p.list, key: p.itemKey, label: p.label, custom: p.isCustom, severity: p.severity })),
    cautions,
    fastingWindow,
    whole30Day,
    disclaimer: raw.disclaimer,
    pendingAck,
  };
}

/** The classifier context for this patient's diet, phase and lists. */
export function classifierContextOf(diet: DietGrounding): ClassifierContext {
  const preferences: PreferenceItemInput[] = diet.lists.map((item) => ({
    list: item.list, key: item.custom ? item.key.replace(/^custom:/, "") : item.key, label: item.label, custom: item.custom, severity: item.severity,
  }));
  return { dietSlug: diet.diet?.slug ?? null, phase: diet.phase, preferences, fitRulesBySlug: diet.fitRules };
}

const LIST_ORDER: readonly PreferenceList[] = ["allergy", "sensitivity", "restriction", "dislike"];
const LIST_TITLES: Record<PreferenceList, string> = {
  allergy: "Allergies",
  sensitivity: "Sensitivities",
  restriction: "Restrictions",
  dislike: "Dislikes",
};

function clean(value: string, max: number): string {
  return value.replace(/[<>`]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function listLine(list: PreferenceList, items: DietListItem[]): string {
  const own = items.filter((item) => item.list === list);
  if (own.length === 0) return `${LIST_TITLES[list]}: none recorded.`;
  const parts = own.map((item) => {
    const label = clean(item.label, 80);
    if (list === "allergy") return `${label} (${item.severity === "severe" ? "SEVERE" : "mild"})`;
    if (list === "restriction") {
      const def = RESTRICTION_BY_KEY.get(item.key);
      return def ? `${def.label}: ${def.rules.join(" ")}` : label;
    }
    if (list === "sensitivity") {
      const def = SENSITIVITY_BY_KEY.get(item.key);
      return def ? def.label : label;
    }
    return label;
  });
  return `${LIST_TITLES[list]}: ${parts.join("; ")}.`;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Plain-English window status: inside, or how it sits around the clock. */
export function describeEatingWindow(window: { eatingStart: string; eatingEnd: string }): string {
  const start = minutesOf(window.eatingStart);
  const end = minutesOf(window.eatingEnd);
  const hours = ((end - start + 1440) % 1440) / 60;
  const fasting = 24 - hours;
  return `eating window ${window.eatingStart}–${window.eatingEnd} (about ${Math.round(hours)} hours eating, ${Math.round(fasting)} fasting)`;
}

/**
 * The canonical diet block. Same inputs → same bytes; nothing in here comes
 * from the clock except the Whole30 day, which changes once per calendar day.
 */
export function renderDietBlock(diet: DietGrounding, firstName: string, targets: PatientDayTargets | null): string {
  const name = clean(firstName, 60) || "The patient";
  const lines: string[] = [];
  lines.push("Diet and food lists (authoritative for this patient; the rule sheet is the authority, general nutrition knowledge fills gaps, and the disclaimer below applies):");

  if (diet.phase === "protocol") {
    lines.push(`- Phase: THINNR protocol. During the protocol the THINNR Approved Foods list decides what fits; ${diet.diet && diet.diet.slug !== JUST_TRACKING_SLUG ? `the ${clean(diet.diet.name, 80)} choice below resumes in the maintenance phase` : "a diet choice only applies in maintenance"}.`);
  } else {
    lines.push("- Phase: maintenance (Metabolic Normalization). The chosen diet below is the plan; the Approved Foods list is a resource, not the rule.");
  }

  if (!diet.diet) {
    lines.push(`- Diet: ${name} has not chosen a diet yet. Coach to the targets and the lists; do not assume a named plan.`);
  } else if (diet.diet.slug === JUST_TRACKING_SLUG) {
    lines.push(`- Diet: ${clean(diet.diet.name, 80)}. No food rules beyond the lists below; coach to the targets.`);
  } else {
    const d = diet.diet;
    lines.push(`- Diet: ${clean(d.name, 80)} (complexity: ${clean(d.complexity, 20)}). ${clean(d.summary, 400)}`);
    if (d.ruleSheet.length > 0) {
      lines.push("- Rule sheet:");
      for (const rule of d.ruleSheet.slice(0, 16)) lines.push(`  • ${clean(rule, 300)}`);
    }
    const limit = PHASE_TWO_LIMITS[d.slug];
    if (limit) {
      lines.push(`- Honest limit: THINNR's curated ${limit} food data is not available yet. Say so plainly when ${name} asks for specific ${limit} thresholds, serving caps or safe lists; give only the rule sheet, general direction and the disclaimer, and point to a dietitian or care team for specifics. Never invent numbers.`);
    }
    if (d.slug === LOW_GLYCEMIC_SLUG) {
      lines.push("- Judgment note: there is no curated glycemic index table here; use general knowledge of glycemic load to judge foods, say it is a judgment call when it is close, and attach the disclaimer.");
    }
    if (diet.fastingWindow) {
      lines.push(`- Fasting: ${describeEatingWindow(diet.fastingWindow)}, in ${name}'s local time. When a food question falls outside the window, say so, suggest water, black coffee or plain tea, and point to the next window opening; never shame a window break. The patient's device decides the current local time — do not assume it.`);
    } else if (d.slug === "intermittent_fasting") {
      lines.push("- Fasting: no eating window saved yet. Ask which window they keep (16:8 is the common start) before timing suggestions.");
    }
    if (diet.whole30Day !== null) {
      lines.push(`- Whole30: today is day ${diet.whole30Day} of 30${diet.whole30Day > 30 ? " (past the 30 days — reintroduction time; ask what they are reintroducing)" : ""}. Make replies day-aware (early-days adjustment, mid-program motivation, the home stretch).`);
    } else if (d.slug === "whole30") {
      lines.push("- Whole30: no start date saved yet. Ask what day they are on before counting days.");
    }
  }

  const sens = diet.lists.filter((item) => item.list === "sensitivity" && PHASE_TWO_SENSITIVITIES[item.key]);
  for (const item of sens) {
    const limit = PHASE_TWO_SENSITIVITIES[item.key]!;
    if (!(diet.diet && PHASE_TWO_LIMITS[diet.diet.slug] === limit)) {
      lines.push(`- Honest limit: curated ${limit} data is not available yet; name obvious triggers only, say specifics are coming, and never invent thresholds.`);
    }
  }

  for (const list of LIST_ORDER) lines.push(`- ${listLine(list, diet.lists)}`);
  lines.push("- List rules: never suggest, recommend or include in a recipe any food that hits an allergy, sensitivity or restriction, including \"may contain\" for a severe allergy. If the patient logs or asks about one, answer, flag it clearly in one sentence, and do not recommend it. Disliked foods may be discussed but never suggested. Kosher and halal also forbid meat (including poultry) with dairy in one dish.");
  lines.push(`- List changes: when ${name} says they dislike, react to, or are allergic to a food that is not on the lists, offer once to add it (the app shows the confirmation chips) and only treat it as added after they confirm. Never claim a list changed on your own.`);

  if (diet.cautions.length > 0) {
    lines.push(`- Cautions: ${name} ${diet.cautions.join("; ")}.`);
  }
  if (targets) {
    const n = (value: number) => String(Math.max(0, Math.round(value)));
    lines.push(`- Daily targets (calculated from goals, body numbers, activity and phase, with any care-team overrides; independent of the diet): ${n(targets.calories)} calories, ${n(targets.protein)}g protein, ${n(targets.carbs)}g carbs, ${n(targets.fat)}g fat, ${n(targets.waterOz)} oz water.`);
  }
  lines.push(`- Disclaimer to attach when giving diet-specific guidance (once per reply, brief): ${clean(diet.disclaimer, 600)}`);
  return lines.join("\n");
}

/** One-line opener the coach uses exactly once after a diet change. */
export function dietChangeAckLine(ack: PendingDietAck): string {
  const next = clean(ack.newName, 80);
  if (ack.newSlug === JUST_TRACKING_SLUG) {
    return ack.previousName
      ? `Quick note: I see you've stepped off ${clean(ack.previousName, 80)} and are just tracking now, so I'll coach to your targets and your food lists from here.`
      : "Quick note: I see you're just tracking for now, so I'll coach to your targets and your food lists.";
  }
  return ack.previousName
    ? `Quick note: I see you've switched from ${clean(ack.previousName, 80)} to ${next}, so I'll coach to ${next} from here on.`
    : `Quick note: I see you're following ${next} now, so I'll keep its rules in mind from here on.`;
}

/** Stamp the selection as acknowledged; a failed stamp only risks a repeat, never the reply. */
export async function markDietChangeAcknowledged(patientId: string, selectionId: string, at: Date): Promise<void> {
  const res = await supabaseAdmin(
    "PATCH",
    `/rest/v1/patient_diet_selections?id=eq.${enc(selectionId)}&patient_id=eq.${enc(patientId)}&coach_acknowledged_at=is.null`,
    { coach_acknowledged_at: at.toISOString() },
    "return=minimal",
  );
  if (res.status >= 300) throw new Error(`diet acknowledgement stamp failed (${res.status})`);
}
