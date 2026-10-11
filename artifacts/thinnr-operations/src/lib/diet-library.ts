/**
 * HQ Diet library — pure rules shared by the list page, the entry editor and
 * the verification suite.
 *
 * The library is the content THINNR publishes to patients: 26 named diet
 * frameworks plus "No specific diet, just tracking". Every entry carries a
 * review status; only `published` entries ever reach the patient app (the
 * tracking-only option is always selectable). The owners sign off on content
 * and counsel reviews condition claims, so the transitions below are the
 * launch switch: draft → reviewed → published, with "back to draft" and
 * "retire" as the reverse gears. A content edit to anything but a draft sends
 * the entry back to draft on the server; the editor explains that before the
 * save, not after.
 */
import type {
  DietComplexity,
  DietEvidenceStrength,
  DietReviewStatus,
  DietScreeningQuestion,
  DietSupervisionLevel,
  HqDietLibraryEntry,
  HqDietLibraryEntryPatch,
} from '@workspace/api-client-react';
import { CHIP_COBALT, CHIP_RISK, CHIP_WARM } from '@/components/patient/heritage';

export const DIET_LIBRARY_PATH = '/admin/diet-library';
export const JUST_TRACKING_SLUG = 'just_tracking';

export const REVIEW_STATUS_ORDER: readonly DietReviewStatus[] = ['published', 'reviewed', 'draft', 'retired'];

export const REVIEW_STATUS_LABELS: Record<DietReviewStatus, string> = {
  draft: 'Draft',
  reviewed: 'Reviewed',
  published: 'Published',
  retired: 'Retired',
};

export const REVIEW_STATUS_HELP: Record<DietReviewStatus, string> = {
  draft: 'Being written or edited. Patients never see drafts.',
  reviewed: 'Signed off by the owners and counsel; ready to publish.',
  published: 'Live in the patient app.',
  retired: 'No longer offered; patients already on it keep their choice.',
};

const CHIP_NEUTRAL = 'inline-flex h-5 items-center gap-1 rounded-sm border border-border bg-secondary px-1.5 text-[9px] font-bold uppercase tracking-[.08em] text-muted-foreground';
const CHIP_OK = 'inline-flex h-5 items-center gap-1 rounded-sm border border-[#b5d2b8] bg-[#eef7ef] px-1.5 text-[9px] font-bold uppercase tracking-[.08em] text-[#1f6b35]';

export function reviewStatusChipClass(status: DietReviewStatus): string {
  switch (status) {
    case 'published': return CHIP_OK;
    case 'reviewed': return CHIP_COBALT;
    case 'retired': return CHIP_RISK;
    default: return CHIP_WARM;
  }
}

export const NEUTRAL_CHIP = CHIP_NEUTRAL;

export const COMPLEXITY_LABELS: Record<DietComplexity, string> = { simple: 'Simple', moderate: 'Moderate', advanced: 'Advanced' };
export const EVIDENCE_LABELS: Record<DietEvidenceStrength, string> = { strong: 'Strong', moderate: 'Moderate', limited: 'Limited', emerging: 'Emerging' };
export const SUPERVISION_LABELS: Record<DietSupervisionLevel, string> = { none: 'None needed', recommended: 'Recommended', required: 'Required' };
export const SCREENING_LABELS: Record<DietScreeningQuestion, string> = {
  medication: 'Takes medication',
  eating_disorder: 'Eating disorder history',
  pregnancy: 'Pregnant or trying',
};

export const COMPLEXITIES: readonly DietComplexity[] = ['simple', 'moderate', 'advanced'];
export const EVIDENCE_STRENGTHS: readonly DietEvidenceStrength[] = ['strong', 'moderate', 'limited', 'emerging'];
export const SUPERVISION_LEVELS: readonly DietSupervisionLevel[] = ['none', 'recommended', 'required'];
export const SCREENING_QUESTIONS: readonly DietScreeningQuestion[] = ['medication', 'eating_disorder', 'pregnancy'];

/** Which review moves the editor offers from each status, in button order. */
export interface ReviewTransition {
  to: DietReviewStatus;
  label: string;
  /** Needs the second "are you sure" confirmation. */
  confirm: boolean;
  tone: 'primary' | 'secondary' | 'danger';
}

export function reviewTransitionsFor(status: DietReviewStatus, slug: string): ReviewTransition[] {
  if (slug === JUST_TRACKING_SLUG) return [];
  switch (status) {
    case 'draft':
      return [{ to: 'reviewed', label: 'Mark reviewed', confirm: false, tone: 'primary' }];
    case 'reviewed':
      return [
        { to: 'published', label: 'Publish to patients', confirm: true, tone: 'primary' },
        { to: 'draft', label: 'Back to draft', confirm: false, tone: 'secondary' },
      ];
    case 'published':
      return [
        { to: 'retired', label: 'Retire', confirm: true, tone: 'danger' },
        { to: 'draft', label: 'Unpublish to draft', confirm: true, tone: 'secondary' },
      ];
    case 'retired':
      return [{ to: 'draft', label: 'Reopen as draft', confirm: false, tone: 'secondary' }];
    default:
      return [];
  }
}

export function transitionConfirmCopy(to: DietReviewStatus, name: string): { title: string; body: string; action: string } {
  switch (to) {
    case 'published':
      return {
        title: `Publish “${name}” to patients?`,
        body: 'Patients will be able to choose this plan in the app immediately. Publish only after the owners have signed off on the content and counsel has reviewed any condition claims and the disclaimer.',
        action: 'Yes, publish',
      };
    case 'retired':
      return {
        title: `Retire “${name}”?`,
        body: 'New patients will no longer see this plan. Patients already following it keep their choice and their history; nothing is deleted.',
        action: 'Yes, retire',
      };
    default:
      return {
        title: `Take “${name}” offline?`,
        body: 'The plan leaves the patient app until it is reviewed and published again. Patients already following it keep their choice.',
        action: 'Yes, unpublish',
      };
  }
}

export interface LibraryCounts { total: number; byStatus: Record<DietReviewStatus, number> }

export function countLibrary(entries: readonly HqDietLibraryEntry[]): LibraryCounts {
  const byStatus: Record<DietReviewStatus, number> = { draft: 0, reviewed: 0, published: 0, retired: 0 };
  for (const entry of entries) byStatus[entry.reviewStatus] += 1;
  return { total: entries.length, byStatus };
}

export type LibraryStatusFilter = DietReviewStatus | 'all';

export function filterLibrary(entries: readonly HqDietLibraryEntry[], status: LibraryStatusFilter, search: string): HqDietLibraryEntry[] {
  const needle = search.trim().toLowerCase();
  return entries
    .filter((entry) => status === 'all' || entry.reviewStatus === status)
    .filter((entry) => !needle || entry.name.toLowerCase().includes(needle) || entry.slug.includes(needle) || entry.summary.toLowerCase().includes(needle))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** The editor's working copy — every field a string the inputs can bind to. */
export interface EntryForm {
  name: string;
  summary: string;
  complexity: DietComplexity;
  ruleSheet: string;
  sampleDay: string;
  sources: string;
  oversightRecommended: boolean;
  pregnancyBlocked: boolean;
  screeningQuestions: DietScreeningQuestion[];
  fitRules: string;
  evidenceStrength: DietEvidenceStrength;
  supervisionLevel: DietSupervisionLevel;
  sortOrder: string;
  changeNote: string;
}

export const linesToText = (lines: readonly string[]): string => lines.join('\n');
export const textToLines = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

export function entryToForm(entry: HqDietLibraryEntry): EntryForm {
  return {
    name: entry.name,
    summary: entry.summary,
    complexity: entry.complexity,
    ruleSheet: linesToText(entry.ruleSheet),
    sampleDay: linesToText(entry.sampleDay),
    sources: linesToText(entry.sources),
    oversightRecommended: entry.oversightRecommended,
    pregnancyBlocked: entry.pregnancyBlocked,
    screeningQuestions: [...entry.screeningQuestions],
    fitRules: JSON.stringify(entry.fitRules ?? {}, null, 2),
    evidenceStrength: entry.evidenceStrength,
    supervisionLevel: entry.supervisionLevel,
    sortOrder: String(entry.sortOrder),
    changeNote: '',
  };
}

export type FormProblem = { field: keyof EntryForm; message: string };

/** Client-side mirror of the server rules — the API stays authoritative. */
export function validateForm(form: EntryForm): FormProblem[] {
  const problems: FormProblem[] = [];
  const name = form.name.trim();
  if (name.length < 1 || name.length > 80) problems.push({ field: 'name', message: 'Name must be 1–80 characters.' });
  const summary = form.summary.trim();
  if (summary.length < 1 || summary.length > 600) problems.push({ field: 'summary', message: 'Summary must be 1–600 characters.' });
  const lists: Array<[keyof EntryForm, number, string]> = [['ruleSheet', 40, 'Rule sheet'], ['sampleDay', 20, 'Sample day'], ['sources', 20, 'Sources']];
  for (const [field, max, label] of lists) {
    const lines = textToLines(String(form[field]));
    if (lines.length > max) problems.push({ field, message: `${label} can have at most ${max} lines.` });
    if (lines.some((line) => line.length > 400)) problems.push({ field, message: `${label} lines must be 400 characters or fewer.` });
  }
  const parsedRules = parseFitRulesText(form.fitRules);
  if (!parsedRules.ok) problems.push({ field: 'fitRules', message: parsedRules.error });
  const order = Number(form.sortOrder);
  if (form.sortOrder.trim() === '' || !Number.isInteger(order) || order < 0 || order > 10000) problems.push({ field: 'sortOrder', message: 'Sort order must be a whole number between 0 and 10000.' });
  if (form.changeNote.length > 500) problems.push({ field: 'changeNote', message: 'Change note must be 500 characters or fewer.' });
  return problems;
}

export function parseFitRulesText(text: string): { ok: true; rules: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Fit rules must be valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'Fit rules must be a JSON object.' };
  const rules = parsed as Record<string, unknown>;
  if (rules.mode !== 'exclude' && rules.mode !== 'include') return { ok: false, error: 'Fit rules need a "mode" of "exclude" or "include".' };
  for (const key of ['excludeTags', 'limitTags', 'includeTags'] as const) {
    if (rules[key] !== undefined && (!Array.isArray(rules[key]) || !(rules[key] as unknown[]).every((tag) => typeof tag === 'string'))) {
      return { ok: false, error: `Fit rules "${key}" must be a list of tags.` };
    }
  }
  for (const key of ['maxCarbsPerServing', 'maxEnergyDensity'] as const) {
    if (rules[key] !== undefined && (typeof rules[key] !== 'number' || !Number.isFinite(rules[key] as number) || (rules[key] as number) < 0)) {
      return { ok: false, error: `Fit rules "${key}" must be a non-negative number.` };
    }
  }
  return { ok: true, rules };
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * Only the fields that changed ride the PATCH, so two editors touching
 * different fields do not fight over the ones they left alone. Returns null
 * when nothing changed.
 */
export function formToPatch(form: EntryForm, entry: HqDietLibraryEntry): HqDietLibraryEntryPatch | null {
  const patch: HqDietLibraryEntryPatch = { expectedVersion: entry.version };
  let changed = false;
  const set = <K extends keyof HqDietLibraryEntryPatch>(key: K, value: HqDietLibraryEntryPatch[K]) => { patch[key] = value; changed = true; };
  if (form.name.trim() !== entry.name) set('name', form.name.trim());
  if (form.summary.trim() !== entry.summary) set('summary', form.summary.trim());
  if (form.complexity !== entry.complexity) set('complexity', form.complexity);
  const ruleSheet = textToLines(form.ruleSheet);
  if (!sameList(ruleSheet, entry.ruleSheet)) set('ruleSheet', ruleSheet);
  const sampleDay = textToLines(form.sampleDay);
  if (!sameList(sampleDay, entry.sampleDay)) set('sampleDay', sampleDay);
  const sources = textToLines(form.sources);
  if (!sameList(sources, entry.sources)) set('sources', sources);
  if (form.oversightRecommended !== entry.oversightRecommended) set('oversightRecommended', form.oversightRecommended);
  if (form.pregnancyBlocked !== entry.pregnancyBlocked) set('pregnancyBlocked', form.pregnancyBlocked);
  const screening = SCREENING_QUESTIONS.filter((question) => form.screeningQuestions.includes(question));
  if (!sameList(screening, SCREENING_QUESTIONS.filter((question) => entry.screeningQuestions.includes(question)))) set('screeningQuestions', screening);
  const rules = parseFitRulesText(form.fitRules);
  if (rules.ok && JSON.stringify(rules.rules) !== JSON.stringify(entry.fitRules ?? {})) set('fitRules', rules.rules);
  if (form.evidenceStrength !== entry.evidenceStrength) set('evidenceStrength', form.evidenceStrength);
  if (form.supervisionLevel !== entry.supervisionLevel) set('supervisionLevel', form.supervisionLevel);
  if (Number(form.sortOrder) !== entry.sortOrder) set('sortOrder', Number(form.sortOrder));
  if (!changed) return null;
  if (form.changeNote.trim()) patch.changeNote = form.changeNote.trim();
  return patch;
}

/** Saving a non-draft entry sends it back to draft — say so before the click. */
export function saveWarningFor(entry: HqDietLibraryEntry): string | null {
  if (entry.slug === JUST_TRACKING_SLUG) return null;
  if (entry.reviewStatus === 'published') return 'This plan is live. Saving changes takes it back to draft and off the patient app until it is reviewed and published again.';
  if (entry.reviewStatus === 'reviewed') return 'Saving changes returns this plan to draft; it will need a fresh review before it can be published.';
  if (entry.reviewStatus === 'retired') return 'Saving changes reopens this plan as a draft.';
  return null;
}

/** Why "Publish" is not available yet, or null when it is. */
export function publishBlockedReason(entry: HqDietLibraryEntry): string | null {
  if (entry.slug === JUST_TRACKING_SLUG) return 'Just tracking is always available to patients and has no review status.';
  if (entry.reviewStatus === 'published') return 'Already published.';
  if (entry.reviewStatus !== 'reviewed') return 'Mark the entry reviewed before publishing it.';
  return null;
}

export function describeApiProblem(error: unknown, fallback: string): { message: string; code: string | null; field: string | null } {
  if (error && typeof error === 'object') {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === 'object') {
      const body = data as { error?: unknown; code?: unknown; field?: unknown };
      return {
        message: typeof body.error === 'string' && body.error ? body.error : fallback,
        code: typeof body.code === 'string' ? body.code : null,
        field: typeof body.field === 'string' ? body.field : null,
      };
    }
    const status = (error as { status?: unknown }).status;
    if (status === 401 || status === 403) return { message: 'Your HQ role does not include content management.', code: 'FORBIDDEN', field: null };
  }
  return { message: fallback, code: null, field: null };
}
