/**
 * HQ Diets & restrictions report — what the network's patients are eating
 * and what they cannot eat, as aggregate counts only.
 *
 * One service-role RPC (`hq_diet_restrictions_facts`) returns the live
 * patients in scope with their diet, episode start, pending block, severe
 * allergy and pregnancy-conflict flags, plus the preference items, diet
 * changes, block activity and screening answers. This module turns that into
 * the report shape shared by the HQ page and the CSV export:
 *
 *   - standing figures (patients, frameworks, phases, lists, pending blocks,
 *     pregnancy conflicts) are AS OF NOW — a restriction is a current fact;
 *   - event figures (diet changes, blocks opened / overridden / rejected,
 *     screening answers) are bounded by the requested date range;
 *   - phase comes from the shared program rule (lib/diet-programs) so the
 *     count agrees with every other staff screen.
 *
 * Unavailable is never zero: a scope with no activated patient reports
 * `available: false` and null figures, and a failed RPC is an error, not an
 * empty report. No patient identifier leaves this module — rows are counted,
 * never listed.
 */
import { derivePhase, JUST_TRACKING_SLUG, PREFERENCE_LISTS, SCREENING_QUESTIONS, type PreferenceList, type ScreeningQuestion } from "@workspace/diet-programs";
import { supabaseAdmin } from "../lib/supabase-admin";
import type { DateRangeKeys } from "../routes/operational-rollups";

/* ------------------------------------------------------------ RPC shape */

export interface DietFactsPatient {
  patientId: string;
  providerId: string;
  programId: string | null;
  episodeStartedOn: string | null;
  dietSlug: string | null;
  dietName: string | null;
  pendingBlock: boolean;
  severeAllergy: boolean;
  pregnancyConflict: boolean;
}

export interface DietFactsItem {
  list: string;
  key: string;
  label: string;
  severity: string | null;
  patients: number;
}

export interface DietFactsPayload {
  patients: DietFactsPatient[];
  items: DietFactsItem[];
  changes: Record<string, number>;
  blocks: { created: number; pending: number; overridden: number; rejected: number } | null;
  screening: Array<{ question: string; answer: string; count: number }>;
  offices: Array<{ providerId: string; name: string }>;
}

const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Defensive parse of the RPC's jsonb so a malformed column fails loudly, not as zeros. */
export function dietFactsPayload(raw: unknown): DietFactsPayload {
  if (!raw || typeof raw !== "object") throw new Error("diet facts payload missing");
  const body = raw as Record<string, unknown>;
  const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? (value as Record<string, unknown>[]) : []);
  return {
    patients: list(body.patients).map((row) => ({
      patientId: String(row.patientId),
      providerId: String(row.providerId),
      programId: str(row.programId),
      episodeStartedOn: str(row.episodeStartedOn),
      dietSlug: str(row.dietSlug),
      dietName: str(row.dietName),
      pendingBlock: row.pendingBlock === true,
      severeAllergy: row.severeAllergy === true,
      pregnancyConflict: row.pregnancyConflict === true,
    })),
    items: list(body.items).map((row) => ({
      list: String(row.list),
      key: String(row.key),
      label: String(row.label ?? row.key),
      severity: str(row.severity),
      patients: num(row.patients),
    })),
    changes: Object.fromEntries(Object.entries((body.changes as Record<string, unknown> | null) ?? {}).map(([role, n]) => [role, num(n)])),
    blocks: body.blocks && typeof body.blocks === "object"
      ? { created: num((body.blocks as Record<string, unknown>).created), pending: num((body.blocks as Record<string, unknown>).pending), overridden: num((body.blocks as Record<string, unknown>).overridden), rejected: num((body.blocks as Record<string, unknown>).rejected) }
      : null,
    screening: list(body.screening).map((row) => ({ question: String(row.question), answer: String(row.answer), count: num(row.count) })),
    offices: list(body.offices).map((row) => ({ providerId: String(row.providerId), name: String(row.name ?? row.providerId) })),
  };
}

/* ---------------------------------------------------------- report shape */

export interface DietFrameworkCount {
  /** Library slug; "none" = no diet chosen yet. */
  slug: string;
  name: string;
  patients: number;
}

export interface DietRestrictionItemCount {
  list: PreferenceList;
  key: string;
  label: string;
  severity: "mild" | "severe" | null;
  patients: number;
}

export interface DietReportCounts {
  patients: number;
  /** Active selection of a real framework (tracking-only is NOT a diet). */
  onDiet: number;
  /** Active "just tracking" selection: the patient chose to follow no framework. */
  justTracking: number;
  /** No active selection at all (not yet chosen). */
  noDiet: number;
  byFramework: DietFrameworkCount[];
  phases: { protocol: number; maintenance: number };
  lists: Record<PreferenceList, number>;
  severeAllergyPatients: number;
  topItems: DietRestrictionItemCount[];
  /**
   * Diet selections started in range, by who made them. Roles are the values
   * the selection rows persist: the patient in the app, office staff on the
   * record, or the system (defaults / migrations). HQ cannot set diets.
   */
  changes: { total: number; byPatient: number; byStaff: number; bySystem: number };
  blocks: { opened: number; pending: number; overridden: number; rejected: number };
  pregnancyConflicts: number;
  screening: Array<{ question: ScreeningQuestion; yes: number; no: number }>;
}

export interface DietReportOfficeRow {
  providerId: string;
  name: string;
  patients: number;
  onDiet: number;
  protocol: number;
  maintenance: number;
  severeAllergy: number;
  pendingBlocks: number;
  pregnancyConflicts: number;
}

export interface DietRestrictionsResult {
  range: DateRangeKeys;
  asOf: string;
  todayKey: string;
  office: { id: string; name: string } | null;
  /** False when no activated patient is in scope: every figure is null, never 0. */
  available: boolean;
  counts: DietReportCounts | null;
  offices: DietReportOfficeRow[];
}

const NO_DIET_SLUG = "none";
const NO_DIET_NAME = "No diet chosen";
const TOP_ITEMS = 25;

const isList = (value: string): value is PreferenceList => (PREFERENCE_LISTS as readonly string[]).includes(value);
const isQuestion = (value: string): value is ScreeningQuestion => (SCREENING_QUESTIONS as readonly string[]).includes(value);
const severityOf = (value: string | null): "mild" | "severe" | null => (value === "severe" ? "severe" : value === "mild" ? "mild" : null);

export function assembleDietRestrictions(input: {
  range: DateRangeKeys;
  asOf: string;
  todayKey: string;
  office: { id: string; name: string } | null;
  payload: DietFactsPayload;
}): DietRestrictionsResult {
  const { range, asOf, todayKey, office, payload } = input;
  if (payload.patients.length === 0) {
    return { range, asOf, todayKey, office, available: false, counts: null, offices: [] };
  }

  const frameworks = new Map<string, DietFrameworkCount>();
  const phases = { protocol: 0, maintenance: 0 };
  const perOffice = new Map<string, DietReportOfficeRow>();
  for (const o of payload.offices) {
    perOffice.set(o.providerId, { providerId: o.providerId, name: o.name, patients: 0, onDiet: 0, protocol: 0, maintenance: 0, severeAllergy: 0, pendingBlocks: 0, pregnancyConflicts: 0 });
  }
  let onDiet = 0;
  let justTracking = 0;
  let severeAllergyPatients = 0;
  let pregnancyConflicts = 0;
  let pendingFromRows = 0;

  for (const p of payload.patients) {
    const slug = p.dietSlug ?? NO_DIET_SLUG;
    const entry = frameworks.get(slug) ?? { slug, name: p.dietSlug ? (p.dietName ?? p.dietSlug) : NO_DIET_NAME, patients: 0 };
    entry.patients += 1;
    frameworks.set(slug, entry);
    const phase = derivePhase({ episodeStartedOn: p.episodeStartedOn, todayKey, programId: (p.programId ?? "thinnr") as "thinnr" | "glp1" | "none" }).phase;
    phases[phase] += 1;
    const framework = p.dietSlug !== null && p.dietSlug !== JUST_TRACKING_SLUG;
    if (framework) onDiet += 1;
    else if (p.dietSlug === JUST_TRACKING_SLUG) justTracking += 1;
    if (p.severeAllergy) severeAllergyPatients += 1;
    if (p.pregnancyConflict) pregnancyConflicts += 1;
    if (p.pendingBlock) pendingFromRows += 1;
    const row = perOffice.get(p.providerId) ?? { providerId: p.providerId, name: p.providerId, patients: 0, onDiet: 0, protocol: 0, maintenance: 0, severeAllergy: 0, pendingBlocks: 0, pregnancyConflicts: 0 };
    row.patients += 1;
    if (framework) row.onDiet += 1;
    row[phase] += 1;
    if (p.severeAllergy) row.severeAllergy += 1;
    if (p.pendingBlock) row.pendingBlocks += 1;
    if (p.pregnancyConflict) row.pregnancyConflicts += 1;
    perOffice.set(p.providerId, row);
  }

  const lists: Record<PreferenceList, number> = { allergy: 0, sensitivity: 0, restriction: 0, dislike: 0 };
  const topItems: DietRestrictionItemCount[] = [];
  for (const item of payload.items) {
    if (!isList(item.list)) continue;
    // Items are grouped per (list, key, severity) by the RPC; a patient with
    // the same item at two severities would count twice here, which the
    // write path forbids (one row per patient × list × key).
    lists[item.list] += item.patients;
    topItems.push({ list: item.list, key: item.key, label: item.label, severity: severityOf(item.severity), patients: item.patients });
  }
  topItems.sort((a, b) => b.patients - a.patients || a.label.localeCompare(b.label));

  const screening = SCREENING_QUESTIONS.map((question) => {
    const rows = payload.screening.filter((s) => s.question === question);
    return { question, yes: rows.filter((s) => s.answer === "yes").reduce((n, s) => n + s.count, 0), no: rows.filter((s) => s.answer === "no").reduce((n, s) => n + s.count, 0) };
  }).filter((row) => isQuestion(row.question));

  // Keyed by the persisted selected_by_role values ('patient' | 'staff' | 'system').
  const changes = {
    byPatient: payload.changes.patient ?? 0,
    byStaff: payload.changes.staff ?? 0,
    bySystem: payload.changes.system ?? 0,
  };
  const blocks = payload.blocks ?? { created: 0, pending: pendingFromRows, overridden: 0, rejected: 0 };

  const byFramework = [...frameworks.values()].sort((a, b) => b.patients - a.patients || a.name.localeCompare(b.name));
  const offices = [...perOffice.values()].filter((row) => row.patients > 0).sort((a, b) => b.patients - a.patients || a.name.localeCompare(b.name));

  return {
    range,
    asOf,
    todayKey,
    office,
    available: true,
    counts: {
      patients: payload.patients.length,
      onDiet,
      justTracking,
      noDiet: payload.patients.length - onDiet - justTracking,
      byFramework,
      phases,
      lists,
      severeAllergyPatients,
      topItems: topItems.slice(0, TOP_ITEMS),
      changes: { total: changes.byPatient + changes.byStaff + changes.bySystem, ...changes },
      blocks: { opened: blocks.created, pending: blocks.pending, overridden: blocks.overridden, rejected: blocks.rejected },
      pregnancyConflicts,
      screening,
    },
    offices,
  };
}

/* ------------------------------------------------------------- loading */

export async function loadDietFacts(range: DateRangeKeys, providerId: string | null): Promise<DietFactsPayload> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/hq_diet_restrictions_facts", {
    p_from: range.start,
    p_to: range.end,
    p_provider_id: providerId,
  });
  if (result.status >= 300) throw new Error(`diet restrictions facts failed (${result.status})`);
  return dietFactsPayload(result.json);
}

/** Enabled office by id, or null when unknown / disabled (same rule as the other HQ analytics). */
export async function loadReportOffice(providerId: string): Promise<{ id: string; name: string } | null> {
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/providers?provider_id=eq.${encodeURIComponent(providerId)}&access_disabled=is.false&select=provider_id,provider_name,office_name&limit=1`,
  );
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`diet restrictions office failed (${result.status})`);
  const row = result.json[0] as { provider_id?: unknown; provider_name?: unknown; office_name?: unknown } | undefined;
  if (!row) return null;
  return { id: String(row.provider_id), name: String(row.office_name ?? row.provider_name ?? "Unnamed office") };
}

export const todayKeyUtc = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

export async function buildDietRestrictionsReport(range: DateRangeKeys, office: { id: string; name: string } | null, now: Date = new Date()): Promise<DietRestrictionsResult> {
  const payload = await loadDietFacts(range, office?.id ?? null);
  return assembleDietRestrictions({ range, asOf: now.toISOString(), todayKey: todayKeyUtc(now), office, payload });
}
