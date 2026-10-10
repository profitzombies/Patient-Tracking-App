/**
 * Diet library reads — the HQ-editable copy of the shared catalog.
 *
 * The database row is the authority once seeded (HQ edits it; the repo
 * catalog is only the seed). Two audiences read it:
 *
 *  - Patients (and the coach on their behalf) see PUBLISHED entries only,
 *    with the evidence strength and supervision level withheld — the owner
 *    wants name, plain-language summary and complexity on the picker, and an
 *    "consider talking to your care team" note where oversight is recommended.
 *    "No specific diet, just tracking" is always offered: it is the absence of
 *    a diet, not content counsel reviews.
 *  - Staff and HQ see every entry with every field, plus the version trail.
 */
import { supabaseAdmin } from "../lib/supabase-admin";
import {
  DIET_DISCLAIMER,
  JUST_TRACKING_SLUG,
  OVERSIGHT_NOTE_TEXT,
  parseFitRules,
  isScreeningQuestion,
  type DietFitRules,
  type ReviewStatus,
  type ScreeningDietFacts,
  type ScreeningQuestion,
} from "@workspace/diet-programs";

const enc = encodeURIComponent;

export interface DietLibraryRow {
  id: string;
  slug: string;
  name: string;
  summary: string;
  complexity: string;
  rule_sheet: unknown;
  sample_day: unknown;
  oversight_note: boolean;
  pregnancy_blocked: boolean;
  screening_questions: unknown;
  fit_rules: unknown;
  evidence_strength: string;
  supervision_level: string;
  sources: unknown;
  review_status: ReviewStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  published_at: string | null;
  sort_order: number;
  version: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export const LIBRARY_SELECT =
  "id,slug,name,summary,complexity,rule_sheet,sample_day,oversight_note,pregnancy_blocked,screening_questions,fit_rules,evidence_strength,supervision_level,sources,review_status,reviewed_by,reviewed_at,published_at,sort_order,version,updated_by,created_at,updated_at";

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function screeningQuestionsOf(value: unknown): ScreeningQuestion[] {
  return strings(value).filter(isScreeningQuestion);
}

export function fitRulesOf(row: Pick<DietLibraryRow, "fit_rules">): DietFitRules {
  return parseFitRules(row.fit_rules) ?? { mode: "exclude", excludeTags: [] };
}

/** The subset of a row the screening rules read. */
export function screeningFacts(row: DietLibraryRow): ScreeningDietFacts {
  return {
    slug: row.slug,
    pregnancyBlocked: Boolean(row.pregnancy_blocked),
    screeningQuestions: screeningQuestionsOf(row.screening_questions),
    oversightNote: Boolean(row.oversight_note),
  };
}

/** Whether patients may pick this entry today. */
export function selectableByPatients(row: Pick<DietLibraryRow, "slug" | "review_status">): boolean {
  return row.slug === JUST_TRACKING_SLUG || row.review_status === "published";
}

export interface PatientDietEntryDto {
  slug: string;
  name: string;
  summary: string;
  complexity: string;
  ruleSheet: string[];
  sampleDay: string[];
  oversightNote: string | null;
  pregnancyBlocked: boolean;
  screeningQuestions: ScreeningQuestion[];
  fitRules: DietFitRules;
  sortOrder: number;
}

export function patientEntryDto(row: DietLibraryRow, oversightText: string): PatientDietEntryDto {
  return {
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    complexity: row.complexity,
    ruleSheet: strings(row.rule_sheet),
    sampleDay: strings(row.sample_day),
    oversightNote: row.oversight_note ? oversightText : null,
    pregnancyBlocked: Boolean(row.pregnancy_blocked),
    screeningQuestions: screeningQuestionsOf(row.screening_questions),
    fitRules: fitRulesOf(row),
    sortOrder: Number(row.sort_order ?? 0),
  };
}

export function staffEntryDto(row: DietLibraryRow, oversightText: string) {
  return {
    ...patientEntryDto(row, oversightText),
    id: row.id,
    oversightRecommended: Boolean(row.oversight_note),
    evidenceStrength: row.evidence_strength,
    supervisionLevel: row.supervision_level,
    sources: strings(row.sources),
    reviewStatus: row.review_status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    publishedAt: row.published_at,
    version: Number(row.version ?? 1),
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface LibrarySettings { disclaimer: string; oversightNoteText: string }

export async function loadLibrarySettings(): Promise<LibrarySettings> {
  const res = await supabaseAdmin("GET", "/rest/v1/diet_library_settings?select=disclaimer,oversight_note_text&limit=1");
  if (res.status >= 300) throw new Error(`diet library settings read failed (${res.status})`);
  const row = (Array.isArray(res.json) ? res.json[0] : null) as { disclaimer?: string; oversight_note_text?: string } | null;
  return {
    disclaimer: typeof row?.disclaimer === "string" && row.disclaimer ? row.disclaimer : DIET_DISCLAIMER,
    oversightNoteText: typeof row?.oversight_note_text === "string" && row.oversight_note_text ? row.oversight_note_text : OVERSIGHT_NOTE_TEXT,
  };
}

export async function loadLibraryRows(): Promise<DietLibraryRow[]> {
  const res = await supabaseAdmin("GET", `/rest/v1/diet_library_entries?select=${LIBRARY_SELECT}&order=sort_order.asc,slug.asc&limit=500`);
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`diet library read failed (${res.status})`);
  return res.json as DietLibraryRow[];
}

export async function loadLibraryEntry(slug: string): Promise<DietLibraryRow | null> {
  const res = await supabaseAdmin("GET", `/rest/v1/diet_library_entries?slug=eq.${enc(slug)}&select=${LIBRARY_SELECT}&limit=1`);
  if (res.status >= 300) throw new Error(`diet library entry read failed (${res.status})`);
  return (Array.isArray(res.json) ? (res.json[0] as DietLibraryRow | undefined) : undefined) ?? null;
}

/** Published entries (plus "just tracking") in picker order, with settings. */
export async function loadPatientLibrary(): Promise<{ settings: LibrarySettings; rows: DietLibraryRow[] }> {
  const [settings, rows] = await Promise.all([loadLibrarySettings(), loadLibraryRows()]);
  return { settings, rows: rows.filter(selectableByPatients) };
}

/** Fit rules keyed by slug — what the classifier reads for the active diet. */
export function fitRulesBySlug(rows: DietLibraryRow[]): Record<string, DietFitRules> {
  return Object.fromEntries(rows.map((row) => [row.slug, fitRulesOf(row)]));
}
