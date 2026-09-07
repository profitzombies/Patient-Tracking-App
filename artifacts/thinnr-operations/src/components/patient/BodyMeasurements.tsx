/**
 * "Body measurements" card: every staff-recorded measurement visit laid out
 * side by side (one column per visit, newest first; one row per body area,
 * inches plus the change since the patient's first recording of that area),
 * and the Log a Visit dialog.
 *
 * The card is data-source agnostic: the demo record feeds it session-held
 * visits layered over the seed, the live record feeds it the API's visit
 * list and routes saves/removals through the office-scoped endpoints. The
 * pure pieces (table builder, validation, LogVisitForm) live apart from the
 * Radix dialog so they can be exercised under react-test-renderer.
 */
import { useId, useState, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  BODY_AREAS,
  INCHES_HINT,
  buildMeasurementTable,
  formatInches,
  formatInchesChange,
  totalInchesChange,
  validateVisitForm,
  type BodyAreaKey,
  type MeasurementVisit,
  type VisitFormInput,
  type VisitFormResult,
} from '@/lib/body-measurements';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, MICRO_LABEL, PANEL_LABEL, SectionCard } from './heritage';

export type VisitDraft = NonNullable<VisitFormResult['value']>;

/** Outcome of a save attempt: closed on success, otherwise a message beside a field (or the whole form). */
export type SaveOutcome = { ok: true } | { ok: false; field?: string; message: string };

export function localTodayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export const formatVisitDay = (dateKey: string) =>
  new Date(`${dateKey}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <p id={id} role="alert" className="mt-1 text-[11px] font-medium text-destructive">{message}</p> : null;
}

const emptyForm = (todayKey: string): VisitFormInput => ({ dateKey: todayKey, note: '', inches: {} });

type FormErrors = VisitFormResult['errors'] & { form?: string };

// ── Form ─────────────────────────────────────────────────────────────────────

export interface LogVisitFormProps {
  /** Local calendar day; injected so tests and the demo anchor can pin it. */
  todayKey: string;
  onSave: (draft: VisitDraft) => Promise<SaveOutcome>;
  onCancel: () => void;
  /** Extra content shown above the fields (conflict / permission notices on the live record). */
  notice?: ReactNode;
  /** Test-id prefix so several forms can coexist on one page. */
  prefix?: string;
}

/** The Log a Visit fields and their inline validation, independent of the dialog chrome. */
export function LogVisitForm({ todayKey, onSave, onCancel, notice, prefix = 'visit' }: LogVisitFormProps) {
  const [form, setForm] = useState<VisitFormInput>(() => emptyForm(todayKey));
  const [errors, setErrors] = useState<FormErrors>({});
  const [pending, setPending] = useState(false);
  const idBase = useId();
  const errorId = (key: string) => `${idBase}-${key}-error`;

  const setInches = (key: BodyAreaKey, value: string) => {
    setForm((current) => ({ ...current, inches: { ...current.inches, [key]: value } }));
    setErrors((current) => ({ ...current, [key]: undefined, measurements: undefined, form: undefined }));
  };
  const setField = (key: 'dateKey' | 'note', value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined, form: undefined }));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = validateVisitForm(form, todayKey);
    if (!result.value) { setErrors(result.errors); return; }
    setPending(true);
    const outcome = await onSave(result.value);
    setPending(false);
    if (outcome.ok) { setForm(emptyForm(todayKey)); setErrors({}); return; }
    const field = outcome.field && (outcome.field === 'dateKey' || outcome.field === 'note' || outcome.field === 'measurements' || BODY_AREAS.some((area) => area.key === outcome.field))
      ? outcome.field
      : 'form';
    setErrors({ [field]: outcome.message });
  };

  const measurementsError = errors.measurements ?? errors.form;

  return (
    <form onSubmit={(event) => void submit(event)} noValidate data-testid={`form-${prefix}`}>
      <div className="space-y-4">
        {notice}
        <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
          <label className="block">
            <span className={PANEL_LABEL}>Visit date</span>
            <input
              type="date"
              max={todayKey}
              value={form.dateKey}
              onChange={(event) => setField('dateKey', event.target.value)}
              className={`${INPUT_CLASS} mt-1 h-9 w-full`}
              aria-invalid={errors.dateKey ? true : undefined}
              aria-describedby={errors.dateKey ? errorId('dateKey') : undefined}
              data-testid={`input-${prefix}-dateKey`}
            />
            <FieldError id={errorId('dateKey')} message={errors.dateKey} />
          </label>
          <label className="block">
            <span className={PANEL_LABEL}>Note (optional)</span>
            <input
              type="text"
              maxLength={500}
              value={form.note}
              onChange={(event) => setField('note', event.target.value)}
              placeholder="e.g. Measured over light clothing"
              className={`${INPUT_CLASS} mt-1 h-9 w-full`}
              aria-invalid={errors.note ? true : undefined}
              aria-describedby={errors.note ? errorId('note') : undefined}
              data-testid={`input-${prefix}-note`}
            />
            <FieldError id={errorId('note')} message={errors.note} />
          </label>
        </div>
        <fieldset
          className="rounded-md border border-border bg-secondary p-3"
          aria-describedby={measurementsError ? errorId('measurements') : `${idBase}-hint`}
          aria-invalid={measurementsError ? true : undefined}
        >
          <legend className={`${PANEL_LABEL} px-1`}>Measurements (inches)</legend>
          <p id={`${idBase}-hint`} className="mb-3 text-[11px] text-muted-foreground">Fill in only the areas measured today. {INCHES_HINT}</p>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            {BODY_AREAS.map((area) => (
              <label key={area.key} className="block">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-semibold text-foreground">{area.label}</span>
                  <span className={MICRO_LABEL}>in</span>
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={form.inches[area.key] ?? ''}
                  onChange={(event) => setInches(area.key, event.target.value)}
                  placeholder="—"
                  className={`${INPUT_CLASS} mt-1 h-9 w-full font-mono`}
                  aria-invalid={errors[area.key] ? true : undefined}
                  aria-describedby={errors[area.key] ? errorId(area.key) : undefined}
                  data-testid={`input-${prefix}-${area.key}`}
                />
                <FieldError id={errorId(area.key)} message={errors[area.key]} />
              </label>
            ))}
          </div>
          <FieldError id={errorId('measurements')} message={measurementsError} />
        </fieldset>
      </div>
      <DialogFooter className="mt-5">
        <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={onCancel} disabled={pending} data-testid={`button-${prefix}-cancel`}>Cancel</button>
        <button type="submit" className={`${BTN_PRIMARY} h-9 px-3.5`} disabled={pending} data-testid={`button-${prefix}-save`}>{pending ? 'Saving…' : 'Save visit'}</button>
      </DialogFooter>
    </form>
  );
}

// ── Table ────────────────────────────────────────────────────────────────────

export interface MeasurementTableProps {
  visits: MeasurementVisit[];
  patientName: string;
  /** When provided, each visit column carries a remove action. */
  onRemove?: (visit: MeasurementVisit) => void;
  removingId?: string | null;
}

export function MeasurementTableView({ visits, patientName, onRemove, removingId }: MeasurementTableProps) {
  const table = buildMeasurementTable(visits);
  const baselineIds = new Set<string>();
  for (const row of table.rows) {
    const baseline = [...row.cells].reverse().find((cell) => cell.value !== null);
    if (baseline) baselineIds.add(`${row.key}:${baseline.visitId}`);
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[420px] text-left text-xs" data-testid="table-body-measurements">
        <caption className="sr-only">Body measurement visits for {patientName}, newest first, in inches with the change since the first recording of each area</caption>
        <thead className="bg-secondary text-[9px] uppercase tracking-[.12em] text-muted-foreground">
          <tr>
            <th scope="col" className="sticky left-0 z-10 bg-secondary px-3 py-2 font-bold">Area</th>
            {table.visits.map((visit) => (
              <th key={visit.id} scope="col" className="min-w-[124px] px-3 py-2 align-top font-bold" data-testid={`column-visit-${visit.id}`}>
                <span className="block normal-case tracking-normal text-[11px] font-bold text-navy">{formatVisitDay(visit.dateKey)}</span>
                {visit.recordedByName && <span className="mt-0.5 block normal-case tracking-normal text-[10px] font-medium text-muted-foreground">{visit.recordedByName}</span>}
                {visit.note && <span className="mt-0.5 block max-w-[180px] truncate normal-case tracking-normal text-[10px] font-normal italic text-muted-foreground" title={visit.note}>{visit.note}</span>}
                {onRemove && (
                  <button
                    type="button"
                    onClick={() => onRemove(visit)}
                    disabled={removingId === visit.id}
                    className="mt-1 inline-flex items-center gap-1 rounded-sm normal-case tracking-normal text-[10px] font-semibold text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    aria-label={`Remove the ${formatVisitDay(visit.dateKey)} visit`}
                    data-testid={`button-remove-visit-${visit.id}`}
                  >
                    <Trash2 size={11} aria-hidden="true" />Remove
                  </button>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.key} className="border-t border-border" data-testid={`row-measurement-${row.key}`}>
              <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-2.5 text-left font-semibold text-foreground">{row.label}</th>
              {row.cells.map((cell) => (
                <td key={cell.visitId} className="px-3 py-2.5 align-top" data-testid={`cell-${row.key}-${cell.visitId}`}>
                  {cell.value === null ? (
                    <span className="text-muted-foreground" aria-label="Not measured">—</span>
                  ) : (
                    <>
                      <span className="font-mono font-semibold text-navy">{formatInches(cell.value)}</span>
                      <span className={`block text-[10px] font-semibold ${cell.change === null ? 'text-muted-foreground' : cell.change < 0 ? 'text-[#1f7a4d]' : cell.change > 0 ? 'text-[#b65c22]' : 'text-muted-foreground'}`}>
                        {cell.change === null ? (baselineIds.has(`${row.key}:${cell.visitId}`) ? 'First recorded' : '') : formatInchesChange(cell.change)}
                      </span>
                    </>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────

export interface BodyMeasurementsCardProps {
  visits: MeasurementVisit[];
  patientName: string;
  /** Whether this viewer may log and remove visits; false hides the actions entirely. */
  canEdit: boolean;
  todayKey: string;
  onSave: (draft: VisitDraft) => Promise<SaveOutcome>;
  onRemove: (visit: MeasurementVisit) => Promise<void> | void;
  /** Rendered inside the dialog above the fields (live conflict / permission notices). */
  dialogNotice?: ReactNode;
  /** Rendered in the card body above the table (e.g. a permission notice after a refused removal). */
  bodyNotice?: ReactNode;
}

export function summarizeVisits(visits: MeasurementVisit[]): string {
  if (visits.length === 0) return 'Inches by body area, visit over visit.';
  const table = buildMeasurementTable(visits);
  const total = totalInchesChange(table);
  const count = `${visits.length} visit${visits.length === 1 ? '' : 's'}`;
  if (total === null) return `${count} recorded · change appears from the second visit.`;
  if (total < 0) return `${count} · ${Math.abs(total).toFixed(1)} in lost across measured areas since the first visit.`;
  if (total > 0) return `${count} · ${total.toFixed(1)} in gained across measured areas since the first visit.`;
  return `${count} · no net change across measured areas since the first visit.`;
}

export function BodyMeasurementsCard({ visits, patientName, canEdit, todayKey, onSave, onRemove, dialogNotice, bodyNotice }: BodyMeasurementsCardProps) {
  const [open, setOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const remove = async (visit: MeasurementVisit) => {
    const areaCount = Object.keys(visit.measurements).length;
    if (!window.confirm(`Remove the ${formatVisitDay(visit.dateKey)} visit (${areaCount} measurement${areaCount === 1 ? '' : 's'})? Removed visits cannot be restored — log a new visit instead.`)) return;
    setRemovingId(visit.id);
    try { await onRemove(visit); } finally { setRemovingId(null); }
  };

  return (
    <SectionCard
      title="Body measurements"
      sub={summarizeVisits(visits)}
      action={canEdit ? <button type="button" onClick={() => setOpen(true)} className={`${BTN_SECONDARY} h-8 px-3`} data-testid="button-log-visit">Log a Visit</button> : undefined}
    >
      <div className="p-5">
        {bodyNotice}
        {visits.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground" data-testid="text-measurements-empty">
            No measurement visits yet.{canEdit ? ' Log a visit to start tracking inches lost alongside pounds lost.' : ''}
          </p>
        ) : (
          <MeasurementTableView visits={visits} patientName={patientName} onRemove={canEdit ? (visit) => void remove(visit) : undefined} removingId={removingId} />
        )}
      </div>
      {canEdit && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[620px]">
            <DialogHeader>
              <DialogTitle className="font-serif text-navy">Log a visit</DialogTitle>
              <DialogDescription>Record today's measurements for {patientName}. Leave any area you did not measure blank.</DialogDescription>
            </DialogHeader>
            <LogVisitForm
              todayKey={todayKey}
              notice={dialogNotice}
              onCancel={() => setOpen(false)}
              onSave={async (draft) => {
                const outcome = await onSave(draft);
                if (outcome.ok) setOpen(false);
                return outcome;
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </SectionCard>
  );
}
