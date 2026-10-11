/**
 * HQ Diets & restrictions — pure rules shared by the reporting page and its
 * verification suite.
 *
 * The page reads one aggregate rollup (`GET /hq/diet-restrictions`) and never
 * invents a figure: a scope with no activated patient is "unavailable", and a
 * failed read is "Error". Shares and labels here follow the roster filter
 * vocabulary (framework names, "No diet chosen", Protocol / Maintenance,
 * "Severe allergy", "Pending block") so a number on this page means the same
 * thing as the matching roster filter.
 */
import type { DietReportCounts, DietReportOfficeRow, DietRestrictionsResult, DietScreeningQuestion, PreferenceListName } from '@workspace/api-client-react';
import { SCREENING_LABELS } from '@/lib/diet-library';

/** Same titles the office record uses for the four lists. */
export const LIST_TITLES: Record<PreferenceListName, string> = {
  allergy: 'Allergies',
  sensitivity: 'Sensitivities',
  restriction: 'Restrictions',
  dislike: 'Dislikes',
};

export const DIET_REPORTING_PATH = '/admin/diet-reporting';
export const DIET_RESTRICTIONS_EXPORT_KIND = 'diet_restrictions';

export const fmtCount = (value: number) => value.toLocaleString('en-US');

/** Whole-percent share of `part` in `whole`; null when there is nothing to divide by. */
export function sharePct(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

export function shareLabel(part: number, whole: number): string {
  const pct = sharePct(part, whole);
  return pct === null ? '—' : `${pct}% of patients`;
}

export interface BarRow {
  key: string;
  label: string;
  value: number;
  /** Width of the bar relative to the largest row (0–100). */
  widthPct: number;
  /** Share of patients in scope, or null when there are none. */
  sharePct: number | null;
  tone?: 'severe' | 'mild' | null;
}

/** Framework rows ordered by patients, with "No diet chosen" always last. */
export function frameworkRows(counts: DietReportCounts | null): BarRow[] {
  if (!counts) return [];
  const rows = [...counts.byFramework].sort((a, b) => (a.slug === 'none' ? 1 : b.slug === 'none' ? -1 : 0) || b.patients - a.patients || a.name.localeCompare(b.name));
  const max = rows.reduce((m, row) => Math.max(m, row.patients), 0);
  return rows.map((row) => ({
    key: row.slug,
    label: row.name,
    value: row.patients,
    widthPct: max > 0 ? Math.round((row.patients / max) * 100) : 0,
    sharePct: sharePct(row.patients, counts.patients),
  }));
}

/** The four lists in display order with how many items patients currently carry. */
export function listRows(counts: DietReportCounts | null): BarRow[] {
  if (!counts) return [];
  const entries = (Object.keys(LIST_TITLES) as PreferenceListName[]).map((list) => ({ list, value: counts.lists[list] ?? 0 }));
  const max = entries.reduce((m, row) => Math.max(m, row.value), 0);
  return entries.map(({ list, value }) => ({
    key: list,
    label: LIST_TITLES[list],
    value,
    widthPct: max > 0 ? Math.round((value / max) * 100) : 0,
    sharePct: null,
  }));
}

/** Most common items across every list, flagged by severity. */
export function topItemRows(counts: DietReportCounts | null, limit = 12): BarRow[] {
  if (!counts) return [];
  const items = counts.topItems.slice(0, limit);
  const max = items.reduce((m, item) => Math.max(m, item.patients), 0);
  return items.map((item) => ({
    key: `${item.list}:${item.key}:${item.severity ?? 'none'}`,
    label: `${item.label} · ${LIST_TITLES[item.list].toLowerCase()}`,
    value: item.patients,
    widthPct: max > 0 ? Math.round((item.patients / max) * 100) : 0,
    sharePct: sharePct(item.patients, counts.patients),
    tone: item.severity ?? null,
  }));
}

export interface ScreeningRow {
  question: DietScreeningQuestion;
  label: string;
  yes: number;
  no: number;
  /** Percent answering yes among those who answered; null when nobody did. */
  yesPct: number | null;
}

export function screeningRows(counts: DietReportCounts | null): ScreeningRow[] {
  if (!counts) return [];
  return counts.screening.map((row) => ({
    question: row.question,
    label: SCREENING_LABELS[row.question],
    yes: row.yes,
    no: row.no,
    yesPct: sharePct(row.yes, row.yes + row.no),
  }));
}

export type OfficeSortKey = 'name' | 'patients' | 'onDiet' | 'protocol' | 'maintenance' | 'severeAllergy' | 'pendingBlocks' | 'pregnancyConflicts';

export const OFFICE_COLUMNS: ReadonlyArray<{ key: OfficeSortKey; label: string; numeric: boolean }> = [
  { key: 'name', label: 'Practice', numeric: false },
  { key: 'patients', label: 'Patients', numeric: true },
  { key: 'onDiet', label: 'On a diet', numeric: true },
  { key: 'protocol', label: 'Protocol', numeric: true },
  { key: 'maintenance', label: 'Maintenance', numeric: true },
  { key: 'severeAllergy', label: 'Severe allergy', numeric: true },
  { key: 'pendingBlocks', label: 'Pending blocks', numeric: true },
  { key: 'pregnancyConflicts', label: 'Pregnancy conflicts', numeric: true },
];

export function sortOfficeRows(rows: readonly DietReportOfficeRow[], key: OfficeSortKey, direction: 'asc' | 'desc'): DietReportOfficeRow[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === 'name') return sign * a.name.localeCompare(b.name) || a.providerId.localeCompare(b.providerId);
    return sign * (a[key] - b[key]) || a.name.localeCompare(b.name);
  });
}

/** One "all practices" line for the foot of the office table. */
export function officeTotals(data: DietRestrictionsResult | undefined): DietReportOfficeRow | null {
  if (!data?.available || !data.counts) return null;
  const c = data.counts;
  return {
    providerId: '',
    name: data.office?.name ?? 'All practices',
    patients: c.patients,
    onDiet: c.onDiet,
    protocol: c.phases.protocol,
    maintenance: c.phases.maintenance,
    severeAllergy: c.severeAllergyPatients,
    pendingBlocks: c.blocks.pending,
    pregnancyConflicts: c.pregnancyConflicts,
  };
}

export const DIET_REPORT_DEFINITIONS: ReadonlyArray<{ term: string; text: string }> = [
  { term: 'Patients', text: 'Claimed, activated patient accounts at enabled practices, not closed. Every share on this page is a share of these patients.' },
  { term: 'On a diet / Just tracking / No diet chosen', text: 'On a diet = an active library framework. Just tracking = the patient chose to follow no framework. No diet chosen = nothing selected yet.' },
  { term: 'Diet changes', text: 'Selections started in the range, by who made them: the patient in the app, office staff on the record, or the system (defaults). HQ cannot set diets.' },
  { term: 'Protocol / Maintenance', text: 'Phase from the shared program rule and the patient\u2019s current episode start (a restart puts the patient back on day one). Counted as of today.' },
  { term: 'Lists and items', text: 'Items currently on patient allergy, sensitivity, restriction and dislike lists. A patient with two items counts twice in the list total but once per item.' },
  { term: 'Severe allergy', text: 'Patients with at least one allergy flagged severe, right now.' },
  { term: 'Safety blocks', text: 'Blocks opened, overridden (with the two-step confirmation) or rejected within the range; pending blocks are counted as of now.' },
  { term: 'Pregnancy conflicts', text: 'Patients who answered pregnant or trying and are on a diet the library flags as pregnancy-blocked, as of now.' },
  { term: 'Screening answers', text: 'Yes / no answers recorded within the date range; a patient re-answering counts each time.' },
  { term: 'Unavailable', text: 'A practice or range with no activated patient reports nothing rather than zero. A failed read says Error; it never shows the previous figures.' },
];
