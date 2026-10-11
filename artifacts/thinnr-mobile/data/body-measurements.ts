/**
 * Body measurement visits — the one place the measurable areas are defined.
 *
 * Staff track inches lost alongside pounds lost. A visit is a date plus
 * whichever areas were measured that day (inches, at most one decimal); every
 * area is optional on every visit, and an unmeasured area is "not measured",
 * never zero. The ordered BODY_AREAS list drives the form, the table rows,
 * and the API wire keys — add or rename an area here and everything follows.
 *
 * The web app carries a mirror of this module (lib/body-measurements.ts);
 * the two must stay in lockstep.
 */
export const BODY_AREAS = [
  { key: 'neck', label: 'Neck' },
  { key: 'chest', label: 'Chest' },
  { key: 'leftArm', label: 'Left arm' },
  { key: 'rightArm', label: 'Right arm' },
  { key: 'waist', label: 'Waist' },
  { key: 'hips', label: 'Hips' },
  { key: 'leftThigh', label: 'Left thigh' },
  { key: 'rightThigh', label: 'Right thigh' },
  { key: 'leftCalf', label: 'Left calf' },
  { key: 'rightCalf', label: 'Right calf' },
] as const;

export type BodyAreaKey = (typeof BODY_AREAS)[number]['key'];

/** Inches per measured area; areas that were not measured are simply absent. */
export type MeasurementValues = Partial<Record<BodyAreaKey, number>>;

export interface MeasurementVisit {
  id: string;
  /** Local calendar day of the visit, YYYY-MM-DD. */
  dateKey: string;
  note: string | null;
  measurements: MeasurementValues;
  recordedByName?: string;
  /** Row version echoed back when removing a live visit (null for legacy rows). */
  version?: string | null;
}

/** Plausible tape-measure range in inches for any single area. */
export const INCHES_MIN = 1;
export const INCHES_MAX = 120;

export const NO_MEASUREMENTS_MESSAGE = 'Enter at least one measurement.';
export const INCHES_HINT = 'Inches, one decimal at most.';

export type InchesParse =
  | { kind: 'blank' }
  | { kind: 'value'; value: number }
  | { kind: 'error'; error: string };

/** Parse one inches field: blank means "not measured"; anything else must be a plausible value. */
export function parseInchesInput(raw: string): InchesParse {
  const text = raw.trim();
  if (text === '') return { kind: 'blank' };
  if (!/^\d+(\.\d+)?$/.test(text)) return { kind: 'error', error: 'Enter the measurement in inches.' };
  const value = Number(text);
  if (!(value > 0)) return { kind: 'error', error: 'Measurements must be greater than zero.' };
  if (/\.\d{2,}/.test(text)) return { kind: 'error', error: 'Use at most one decimal place.' };
  if (value < INCHES_MIN || value > INCHES_MAX) {
    return { kind: 'error', error: `Measurements must be between ${INCHES_MIN} and ${INCHES_MAX} inches.` };
  }
  return { kind: 'value', value: Math.round(value * 10) / 10 };
}

export interface VisitFormInput {
  dateKey: string;
  note: string;
  /** Raw text per area, exactly as typed. */
  inches: Partial<Record<BodyAreaKey, string>>;
}

export interface VisitFormResult {
  /** Field-keyed messages: area keys, 'dateKey', 'note', or 'measurements' (nothing entered). */
  errors: Partial<Record<BodyAreaKey | 'dateKey' | 'note' | 'measurements', string>>;
  /** Present only when errors is empty. */
  value: { dateKey: string; note: string | null; measurements: MeasurementValues } | null;
}

/** Validate the whole Log a Visit form against the caller's local today. */
export function validateVisitForm(input: VisitFormInput, todayKey: string): VisitFormResult {
  const errors: VisitFormResult['errors'] = {};
  const measurements: MeasurementValues = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateKey) || input.dateKey > todayKey || input.dateKey < '2000-01-01') {
    errors.dateKey = 'Enter a date on or before today.';
  }
  const note = input.note.trim();
  if (note.length > 500) errors.note = 'Keep the note under 500 characters.';
  for (const area of BODY_AREAS) {
    const parsed = parseInchesInput(input.inches[area.key] ?? '');
    if (parsed.kind === 'error') errors[area.key] = parsed.error;
    else if (parsed.kind === 'value') measurements[area.key] = parsed.value;
  }
  if (Object.keys(measurements).length === 0) errors.measurements = NO_MEASUREMENTS_MESSAGE;
  if (Object.keys(errors).length > 0) return { errors, value: null };
  return { errors, value: { dateKey: input.dateKey, note: note || null, measurements } };
}

export interface MeasurementCell {
  visitId: string;
  /** Inches, or null when the area was not measured on this visit. */
  value: number | null;
  /** Change since the earliest visit that measured this area; null on that baseline visit or when unmeasured. */
  change: number | null;
}

export interface MeasurementRow {
  key: BodyAreaKey;
  label: string;
  cells: MeasurementCell[];
}

export interface MeasurementTable {
  /** Visits newest first — one column each. */
  visits: MeasurementVisit[];
  /** One row per body area in BODY_AREAS order; unmeasured cells are null (rendered as a dash). */
  rows: MeasurementRow[];
}

/** Newest first by visit day; same-day visits keep their incoming order. */
export function sortVisitsNewestFirst(visits: MeasurementVisit[]): MeasurementVisit[] {
  return [...visits].sort((a, b) => (a.dateKey < b.dateKey ? 1 : a.dateKey > b.dateKey ? -1 : 0));
}

/**
 * Lay visits out side by side: a column per visit (newest first) and a row
 * per body area, each cell carrying the inches and the change since the
 * patient's first recorded value for that area.
 */
export function buildMeasurementTable(input: MeasurementVisit[]): MeasurementTable {
  const visits = sortVisitsNewestFirst(input);
  const rows: MeasurementRow[] = [];
  for (const area of BODY_AREAS) {
    const measured = visits.filter((visit) => typeof visit.measurements[area.key] === 'number');
    const baseline = measured[measured.length - 1] ?? null;
    const baselineValue = baseline ? (baseline.measurements[area.key] as number) : null;
    rows.push({
      key: area.key,
      label: area.label,
      cells: visits.map((visit) => {
        const value = visit.measurements[area.key];
        if (typeof value !== 'number' || baselineValue === null) return { visitId: visit.id, value: null, change: null };
        const change = visit === baseline ? null : Math.round((value - baselineValue) * 10) / 10;
        return { visitId: visit.id, value, change };
      }),
    });
  }
  return { visits, rows };
}

export function formatInches(value: number): string {
  return `${value.toFixed(1)} in`;
}

/** Signed change with a real minus sign, e.g. "−1.5 in", "+0.5 in", "0.0 in". */
export function formatInchesChange(change: number): string {
  if (change === 0) return '0.0 in';
  return `${change < 0 ? '−' : '+'}${Math.abs(change).toFixed(1)} in`;
}

/** Total inches lost across every area since each area's first measurement, for the card summary. */
export function totalInchesChange(table: MeasurementTable): number | null {
  if (table.visits.length < 2) return null;
  let total = 0;
  let counted = 0;
  for (const row of table.rows) {
    const latest = row.cells.find((cell) => cell.value !== null);
    if (!latest || latest.change === null) continue;
    total += latest.change;
    counted += 1;
  }
  return counted === 0 ? null : Math.round(total * 10) / 10;
}
