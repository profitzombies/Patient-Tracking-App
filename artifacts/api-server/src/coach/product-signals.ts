/**
 * Patient signals for coach product suggestions — the "what the coach knows
 * about this patient" half of data-driven suggestions.
 *
 * `deriveSuggestionSignals` is pure: it turns raw account facts (weigh-ins,
 * diary entries, water, medication records, committed bloodwork results)
 * into the fixed signal vocabulary from billing/types.ts, each with a short
 * factual detail line the prompt can quote. `loadSuggestionFacts` is the
 * live-account reader. The demo persona never reaches either.
 *
 * Trend and stall math reuse the app's own stall-nudge module so the coach
 * and the outreach worker agree on what "stalled" means. Bloodwork is read
 * from REVIEWED reports only (a care-team member marked the committed,
 * fully extracted report reviewed; automatic extraction alone never
 * qualifies), and only the newest such report within the freshness window,
 * only its non-uncertain results; a signal here never claims a diagnosis —
 * the prompt turns it into "worth asking your provider about".
 */
import {
  classifyEntries,
  evaluateAdherence,
  evaluateStall,
  shiftDateKey,
  type WeighIn,
} from "../../../thinnr-mobile/data/stall-nudge";
import type { MedicationRecord } from "../medications/schedule";
import { listMedications } from "../medications/store";
import { supabaseAdmin } from "../lib/supabase-admin";
import type { CoachSuggestionSignal } from "../billing/types";
import type { PatientDayTargets } from "./prompt";
import { DEFAULT_TARGETS } from "./real-patient";

const enc = encodeURIComponent;

export interface SuggestionSignal {
  id: CoachSuggestionSignal;
  /** One factual sentence for the prompt, e.g. "Weight has held within 0.5 lb for 21 days." */
  detail: string;
}

export interface DiaryEntryFact {
  dateKey: string;
  kind: "food" | "recipe" | "quick";
  refId: string | null;
  protein: number;
}

export interface BloodworkResultFact {
  testName: string | null;
  valueText: string | null;
  referenceRange: string | null;
  labFlag: string | null;
}

export interface SuggestionFacts {
  todayKey: string;
  programDay: number;
  weighIns: WeighIn[];
  /** Last ADHERENCE window of diary entries (14 days). */
  entries: DiaryEntryFact[];
  /** Last 7 days of water, one row per logged day. */
  waterDays: { dateKey: string; oz: number }[];
  targets: Pick<PatientDayTargets, "protein" | "waterOz">;
  medications: MedicationRecord[];
  /** Non-uncertain results from committed reports. */
  bloodwork: BloodworkResultFact[];
}

/** Weigh-ins whose newer half sits this much above the older half read as regain. */
export const REGAIN_MIN_LB = 1;
export const LOW_LOGGING_MAX_DAYS = 3;
export const LOW_PROTEIN_SHARE = 0.7;
export const LOW_WATER_SHARE = 0.6;
export const PROGRAM_COMPLETE_DAY = 42;
export const WEIGH_IN_LOOKBACK_DAYS = 28;

const GLP1_RE = /\b(semaglutide|tirzepatide|liraglutide|dulaglutide|exenatide|ozempic|wegovy|mounjaro|zepbound|saxenda|victoza|trulicity|rybelsus|glp[\s-]?1)\b/i;
const DIABETES_RE = /\b(metformin|glucophage|insulin|lantus|humalog|novolog|glipizide|glyburide|glimepiride|jardiance|empagliflozin|farxiga|dapagliflozin|januvia|sitagliptin|pioglitazone|actos)\b/i;
const BLOOD_THINNER_RE = /\b(warfarin|coumadin|apixaban|eliquis|rivaroxaban|xarelto|dabigatran|pradaxa|edoxaban|clopidogrel|plavix|heparin|enoxaparin|lovenox|blood thinner)\b/i;

const BLOODWORK_GROUPS: Array<{ id: CoachSuggestionSignal; test: RegExp; direction: "high" | "low" | "any" }> = [
  { id: "bloodwork_glucose_high", test: /\b(glucose|a1c|hba1c|hemoglobin a1c|insulin)\b/i, direction: "high" },
  { id: "bloodwork_lipids_high", test: /\b(cholesterol|ldl|triglycerides?|non[\s-]?hdl)\b/i, direction: "high" },
  { id: "bloodwork_liver_high", test: /\b(alt|ast|ggt|sgpt|sgot|alkaline phosphatase|alk phos|bilirubin)\b/i, direction: "high" },
  { id: "bloodwork_b12_low", test: /\b(b[\s-]?12|cobalamin|folate|folic acid)\b/i, direction: "low" },
  { id: "bloodwork_vitamin_d_low", test: /\b(vitamin d|25[\s-]?oh|calcidiol|cholecalciferol)\b/i, direction: "low" },
  { id: "bloodwork_iron_low", test: /\b(iron|ferritin|hemoglobin|hgb|hematocrit|tibc)\b/i, direction: "low" },
  { id: "bloodwork_kidney_flag", test: /\b(creatinine|egfr|gfr|bun|urea nitrogen)\b/i, direction: "any" },
];

/**
 * Direction of a result: the lab's own flag wins; otherwise a numeric value
 * outside a simple "a-b", "<b", or ">a" reference range decides. Anything
 * unparseable is "normal" — a suggestion must never lean on a guess.
 */
export function resultDirection(result: BloodworkResultFact): "high" | "low" | null {
  const flag = (result.labFlag ?? "").trim().toUpperCase();
  if (/^(H|HH|HIGH|ABOVE|ABN(ORMAL)? ?H|\*H)\b/.test(flag) || flag === "H*") return "high";
  if (/^(L|LL|LOW|BELOW|ABN(ORMAL)? ?L|\*L)\b/.test(flag) || flag === "L*") return "low";
  if (flag !== "") return null;
  const value = parseFloat((result.valueText ?? "").replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(value)) return null;
  const range = (result.referenceRange ?? "").replace(/\s+/g, "");
  let match = range.match(/^(-?\d+(?:\.\d+)?)[-–](-?\d+(?:\.\d+)?)/);
  if (match) {
    const low = parseFloat(match[1]);
    const high = parseFloat(match[2]);
    if (value > high) return "high";
    if (value < low) return "low";
    return null;
  }
  match = range.match(/^[<≤](=)?(-?\d+(?:\.\d+)?)/);
  if (match) return value > parseFloat(match[2]) ? "high" : null;
  match = range.match(/^[>≥](=)?(-?\d+(?:\.\d+)?)/);
  if (match) return value < parseFloat(match[2]) ? "low" : null;
  return null;
}

function activeMedications(medications: readonly MedicationRecord[], todayKey: string): MedicationRecord[] {
  return medications.filter((med) => med.startDate <= todayKey && (med.stopDate === null || med.stopDate >= todayKey));
}

function medicationText(med: MedicationRecord): string {
  return [med.name, med.dose ?? "", med.notes ?? ""].join(" ");
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function deriveSuggestionSignals(facts: SuggestionFacts): SuggestionSignal[] {
  const out: SuggestionSignal[] = [];
  const { todayKey } = facts;

  // Weekly trend and stall: the app's own trigger math over the 21-day window.
  const byDay = new Map<string, number>();
  for (const w of [...facts.weighIns].sort((a, b) => a.dateKey.localeCompare(b.dateKey))) byDay.set(w.dateKey, w.weight);
  const weighIns = [...byDay.entries()].map(([dateKey, weight]) => ({ dateKey, weight }));
  const stall = evaluateStall(weighIns, todayKey);
  // Older-half median minus newer-half median (positive = still losing).
  const drop = stall.dropLb;
  if (stall.stalled && drop !== null) {
    out.push({
      id: "stall",
      detail: drop <= -REGAIN_MIN_LB
        ? `Weight is up about ${fmt(Math.abs(drop))} lb across ${stall.weighIns} weigh-ins over the last ${stall.spanDays} days.`
        : `Weight has held within ${fmt(Math.max(0, drop))} lb across ${stall.weighIns} weigh-ins over the last ${stall.spanDays} days.`,
    });
  }
  if (drop !== null && drop <= -REGAIN_MIN_LB) {
    out.push({ id: "weight_regain", detail: `Recent weigh-ins run about ${fmt(Math.abs(drop))} lb above the earlier ones.` });
  }

  // Compliance: repeated off-plan meals and lapsed logging.
  const classified = classifyEntries(facts.entries.map((e) => ({ dateKey: e.dateKey, kind: e.kind, refId: e.refId ?? undefined })));
  const adherence = evaluateAdherence(classified, todayKey);
  if (adherence.repeatedOffPlan) {
    out.push({
      id: "off_plan_meals",
      detail: `${adherence.offPlan} of the last ${adherence.classified} classified meals were off plan over the past two weeks.`,
    });
  }
  const weekStart = shiftDateKey(todayKey, -6);
  const weekEntries = facts.entries.filter((e) => e.dateKey >= weekStart && e.dateKey <= todayKey);
  const loggedDays = new Set(weekEntries.map((e) => e.dateKey));
  if (loggedDays.size <= LOW_LOGGING_MAX_DAYS) {
    out.push({
      id: "low_logging",
      detail: loggedDays.size === 0
        ? "No diary entries logged in the last 7 days."
        : `Only ${loggedDays.size} of the last 7 days have a diary entry.`,
    });
  }
  if (loggedDays.size > 0 && facts.targets.protein > 0) {
    const proteinByDay = new Map<string, number>();
    for (const e of weekEntries) proteinByDay.set(e.dateKey, (proteinByDay.get(e.dateKey) ?? 0) + (Number.isFinite(e.protein) ? e.protein : 0));
    const avg = [...proteinByDay.values()].reduce((a, b) => a + b, 0) / proteinByDay.size;
    if (avg < facts.targets.protein * LOW_PROTEIN_SHARE) {
      out.push({
        id: "low_protein",
        detail: `Protein averaged ${Math.round(avg)} g on logged days this week against a ${facts.targets.protein} g target.`,
      });
    }
  }
  const waterDays = facts.waterDays.filter((d) => d.dateKey >= weekStart && d.dateKey <= todayKey);
  if (waterDays.length > 0 && facts.targets.waterOz > 0) {
    const avg = waterDays.reduce((a, d) => a + (Number.isFinite(d.oz) ? d.oz : 0), 0) / waterDays.length;
    if (avg < facts.targets.waterOz * LOW_WATER_SHARE) {
      out.push({
        id: "low_water",
        detail: `Water averaged ${Math.round(avg)} oz on logged days this week against a ${facts.targets.waterOz} oz target.`,
      });
    }
  }

  if (facts.programDay > PROGRAM_COMPLETE_DAY) {
    out.push({ id: "program_complete", detail: `Program day ${facts.programDay}, past the ${PROGRAM_COMPLETE_DAY}-day protocol.` });
  }

  // Medication records: names only, never doses in the detail line.
  const active = activeMedications(facts.medications, todayKey);
  const named = (re: RegExp) => active.filter((med) => re.test(medicationText(med))).map((med) => med.name);
  const glp1 = named(GLP1_RE);
  if (glp1.length) out.push({ id: "glp1_medication", detail: `Active GLP-1 medication on record: ${glp1.join(", ")}.` });
  const diabetes = named(DIABETES_RE);
  if (diabetes.length) out.push({ id: "diabetes_medication", detail: `Active diabetes medication on record: ${diabetes.join(", ")}.` });
  const thinners = named(BLOOD_THINNER_RE);
  if (thinners.length) out.push({ id: "blood_thinner_medication", detail: `Active blood thinner on record: ${thinners.join(", ")}.` });

  // Committed bloodwork: flagged markers grouped by family, named but never interpreted.
  for (const group of BLOODWORK_GROUPS) {
    const hits = facts.bloodwork.filter((r) => {
      if (!r.testName || !group.test.test(r.testName)) return false;
      const direction = resultDirection(r);
      return direction !== null && (group.direction === "any" || direction === group.direction);
    });
    if (hits.length === 0) continue;
    const names = [...new Set(hits.map((r) => (r.testName as string).trim()))].slice(0, 3);
    const word = group.direction === "any" ? "flagged" : `flagged ${group.direction}`;
    out.push({ id: group.id, detail: `Bloodwork your care team reviewed shows ${names.join(", ")} ${word} on the lab report.` });
  }

  return out;
}

/** A reviewed report older than this (by lab date, else review date) no longer informs suggestions. */
export const BLOODWORK_MAX_AGE_DAYS = 365;

export interface ReviewedReportRow {
  id: string;
  reviewed_at: string | null;
  report_date: string | null;
}

/**
 * The single bloodwork report whose results may feed signals: reviewed by
 * the care team, the newest by lab date (review date when the lab date is
 * unknown), and no older than the freshness window. Unreviewed rows are
 * ignored even when they are newer.
 */
export function selectReviewedReport(rows: ReviewedReportRow[], now: Date): ReviewedReportRow | null {
  const dated = rows
    .filter((row) => typeof row.reviewed_at === "string" && Number.isFinite(Date.parse(row.reviewed_at)))
    .map((row) => {
      const labDate = row.report_date ? Date.parse(row.report_date) : Number.NaN;
      return { row, at: Number.isFinite(labDate) ? labDate : Date.parse(row.reviewed_at as string) };
    })
    .sort((a, b) => b.at - a.at);
  const newest = dated[0];
  if (!newest) return null;
  if (now.getTime() - newest.at > BLOODWORK_MAX_AGE_DAYS * 86_400_000) return null;
  return newest.row;
}

function expectRows(response: { status: number; json: unknown }, what: string): Record<string, unknown>[] {
  if (response.status >= 300 || !Array.isArray(response.json)) throw new Error(`${what} lookup failed (${response.status})`);
  return response.json as Record<string, unknown>[];
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Live reader for a real patient's suggestion facts. Throws on any upstream failure. */
export async function loadSuggestionFacts(
  patientId: string,
  todayKey: string,
  programDay: number,
  targets: Pick<PatientDayTargets, "protein" | "waterOz"> = DEFAULT_TARGETS,
  now: Date = new Date(),
): Promise<SuggestionFacts> {
  const pid = enc(patientId);
  const [checkIns, entries, water, reports, medications] = await Promise.all([
    supabaseAdmin("GET", `/rest/v1/patient_check_ins?patient_id=eq.${pid}&date_key=gte.${shiftDateKey(todayKey, -WEIGH_IN_LOOKBACK_DAYS)}&select=date_key,weight&order=date_key.asc&limit=200`),
    supabaseAdmin("GET", `/rest/v1/patient_diary_entries?patient_id=eq.${pid}&date_key=gte.${shiftDateKey(todayKey, -13)}&date_key=lte.${todayKey}&select=date_key,kind,ref_id,protein&limit=2000`),
    supabaseAdmin("GET", `/rest/v1/patient_water_days?patient_id=eq.${pid}&date_key=gte.${shiftDateKey(todayKey, -6)}&date_key=lte.${todayKey}&select=date_key,oz&limit=14`),
    // Reviewed reports only, newest first; the freshness cut happens in
    // selectReviewedReport so the rule is testable without a database.
    supabaseAdmin("GET", `/rest/v1/patient_bloodwork_reports?patient_id=eq.${pid}&lifecycle_status=eq.committed&extraction_status=eq.completed&reviewed_at=not.is.null&select=id,reviewed_at,report_date&order=reviewed_at.desc&limit=50`),
    listMedications(patientId),
  ]);
  const reviewed = selectReviewedReport(
    expectRows(reports, "bloodwork reports").map((r) => ({ id: String(r.id), reviewed_at: str(r.reviewed_at), report_date: str(r.report_date) })),
    now,
  );
  let bloodwork: BloodworkResultFact[] = [];
  if (reviewed) {
    const results = await supabaseAdmin(
      "GET",
      `/rest/v1/patient_bloodwork_results?patient_id=eq.${pid}&uncertain=eq.false&report_id=eq.${enc(reviewed.id)}&select=test_name,value_text,reference_range,lab_flag&limit=2000`,
    );
    bloodwork = expectRows(results, "bloodwork results").map((r) => ({
      testName: str(r.test_name), valueText: str(r.value_text), referenceRange: str(r.reference_range), labFlag: str(r.lab_flag),
    }));
  }
  return {
    todayKey,
    programDay,
    weighIns: expectRows(checkIns, "check-ins")
      .filter((r) => typeof r.weight === "number" && Number.isFinite(r.weight))
      .map((r) => ({ dateKey: String(r.date_key), weight: r.weight as number })),
    entries: expectRows(entries, "diary").map((r) => ({
      dateKey: String(r.date_key),
      kind: (r.kind === "recipe" || r.kind === "quick" ? r.kind : "food") as DiaryEntryFact["kind"],
      refId: str(r.ref_id),
      protein: num(r.protein),
    })),
    waterDays: expectRows(water, "water").map((r) => ({ dateKey: String(r.date_key), oz: num(r.oz) })),
    targets,
    medications,
    bloodwork,
  };
}
