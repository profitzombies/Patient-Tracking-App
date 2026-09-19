/**
 * History tab on the live patient record: every correction to the shared
 * record families (profile, status, weigh-ins, measurement visits,
 * medications, staff notes) with what it was, what it became, who changed it,
 * and when. HIPAA amendments append rather than overwrite, so a prior value is
 * always recoverable here even after several corrections.
 *
 * Read-only by design: staff correct a value by making a new edit on the
 * Record tab, never by restoring from here.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BTN_PRIMARY, BTN_SECONDARY, CHIP_COBALT, CHIP_WARM, MICRO_LABEL, SectionCard } from '@/components/patient/heritage';
import {
  fetchOfficePatientEditHistory,
  type PatientEditHistoryChange,
  type PatientEditHistoryFamily,
} from '@/lib/office-roster';

export const EDIT_HISTORY_PAGE_SIZE = 50;

const FAMILY_LABELS: Record<PatientEditHistoryFamily, string> = {
  profile: 'Profile',
  status: 'Status',
  weight: 'Weigh-ins',
  measurement: 'Measurements',
  medication: 'Medications',
  note: 'Staff notes',
};
const FAMILY_ORDER: PatientEditHistoryFamily[] = ['profile', 'status', 'weight', 'measurement', 'medication', 'note'];

const FIELD_LABELS: Record<string, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  phone: 'Phone',
  goalWeight: 'Goal weight',
  startingWeight: 'Starting weight',
  programStartDate: 'Program start',
  timezone: 'Time zone',
  status: 'Status',
  reason: 'Reason',
  dateKey: 'Date',
  weight: 'Weight',
  note: 'Note',
  body: 'Note',
  name: 'Name',
  form: 'Form',
  dose: 'Dose',
  scheduleKind: 'Schedule',
  times: 'Times',
  weekday: 'Weekday',
  notes: 'Notes',
  startDate: 'Start date',
  stopDate: 'Stop date',
  neck: 'Neck',
  chest: 'Chest',
  leftArm: 'Left arm',
  rightArm: 'Right arm',
  waist: 'Waist',
  hips: 'Hips',
  leftThigh: 'Left thigh',
  rightThigh: 'Right thigh',
  leftCalf: 'Left calf',
  rightCalf: 'Right calf',
};
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function fieldLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const words = field.replace(/([A-Z])/g, ' $1').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Human reading of one recorded value; "empty" when the field was blank or the record did not exist. */
export function formatHistoryValue(family: PatientEditHistoryFamily, field: string, value: PatientEditHistoryChange['fields'][number]['old']): string {
  if (value === null || value === undefined || value === '') return 'empty';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'empty';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (field === 'weekday') return WEEKDAYS[value] ?? String(value);
    if (family === 'weight' && field === 'weight') return `${value.toFixed(1)} lbs`;
    if (family === 'profile' && /Weight$/.test(field)) return `${value.toFixed(1)} lbs`;
    if (family === 'measurement' && field !== 'dateKey') return `${value} in`;
    return String(value);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function actorLabel(change: Pick<PatientEditHistoryChange, 'actorKind' | 'actorName'>): string {
  if (change.actorKind === 'patient') return 'Patient';
  if (change.actorName) return change.actorKind === 'hq' ? `${change.actorName} (HQ)` : change.actorName;
  if (change.actorKind === 'hq') return 'HQ';
  if (change.actorKind === 'system') return 'System';
  return 'Staff';
}

const KIND_LABELS: Record<PatientEditHistoryChange['changeKind'], string> = { create: 'Added', update: 'Changed', delete: 'Removed' };

const formatWhen = (iso: string) => {
  const value = new Date(iso);
  return `${value.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · ${value.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
};

export function editHistoryQueryKey(office: string | null | undefined, patientId: string, family: PatientEditHistoryFamily | null, offset: number) {
  return ['office-patient-history', office ?? 'own', patientId, family ?? 'all', offset] as const;
}

export function PatientEditHistory({ patientId, office }: { patientId: string; office: string | null }) {
  const [family, setFamily] = useState<PatientEditHistoryFamily | null>(null);
  const [changes, setChanges] = useState<PatientEditHistoryChange[]>([]);
  const [offset, setOffset] = useState(0);
  const page = useQuery({
    queryKey: editHistoryQueryKey(office, patientId, family, offset),
    queryFn: () => fetchOfficePatientEditHistory(patientId, office, { family, limit: EDIT_HISTORY_PAGE_SIZE, offset }),
    // The first page is refreshed like the rest of the record; later pages are stable.
    refetchInterval: offset === 0 ? 30_000 : false,
  });

  // Pages accumulate newest-first; a filter change or first-page refresh restarts the list.
  useEffect(() => {
    if (!page.data) return;
    const loaded = page.data.changes;
    setChanges((current) => (offset === 0 ? loaded : [...current.slice(0, offset), ...loaded]));
  }, [page.data, offset]);

  const selectFamily = (next: PatientEditHistoryFamily | null) => {
    setFamily(next);
    setOffset(0);
    setChanges([]);
  };
  const total = page.data?.total ?? null;
  const nextOffset = page.data?.nextOffset ?? null;
  const showing = offset === 0 && page.data ? page.data.changes : changes;

  return (
    <SectionCard
      title="Edit history"
      sub="Every correction to this record, newest first. Prior values stay on file; to fix a value, make a new edit on the Record tab."
      action={total === null ? undefined : <span className={CHIP_COBALT} data-testid="text-history-total">{total} change{total === 1 ? '' : 's'}</span>}
    >
      <div className="p-5">
        <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filter history by record family">
          <button type="button" onClick={() => selectFamily(null)} aria-pressed={family === null} className={`${family === null ? BTN_PRIMARY : BTN_SECONDARY} h-8 px-3`} data-testid="filter-history-all">All</button>
          {FAMILY_ORDER.map((key) => (
            <button key={key} type="button" onClick={() => selectFamily(key)} aria-pressed={family === key} className={`${family === key ? BTN_PRIMARY : BTN_SECONDARY} h-8 px-3`} data-testid={`filter-history-${key}`}>{FAMILY_LABELS[key]}</button>
          ))}
        </div>
        {page.isError && <p role="alert" className="text-sm text-destructive" data-testid="text-history-error">{page.error instanceof Error ? page.error.message : 'The edit history could not be loaded.'}</p>}
        {page.isLoading && showing.length === 0 && <p className="text-xs text-muted-foreground">Loading edit history…</p>}
        {!page.isLoading && !page.isError && showing.length === 0 && (
          <p className="rounded-md border border-dashed border-border bg-secondary p-6 text-center text-xs text-muted-foreground" data-testid="text-history-empty">
            {family ? `No ${FAMILY_LABELS[family].toLowerCase()} changes have been recorded.` : 'No changes have been recorded for this patient yet.'}
          </p>
        )}
        {showing.length > 0 && (
          <ol className="divide-y divide-border" data-testid="list-history">
            {showing.map((change) => (
              <li key={change.changeId} className="py-3 first:pt-0 last:pb-0" data-testid={`history-change-${change.changeId}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className={change.changeKind === 'delete' ? CHIP_WARM : CHIP_COBALT}>{FAMILY_LABELS[change.family]}</span>
                  <span className="text-xs font-semibold text-navy">{KIND_LABELS[change.changeKind]}</span>
                  <span className="text-[11px] text-muted-foreground">
                    <time dateTime={change.createdAt}>{formatWhen(change.createdAt)}</time>
                    {' · '}
                    <span data-testid="text-history-actor">{actorLabel(change)}</span>
                  </span>
                </div>
                <dl className="mt-2 grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[max-content_1fr]">
                  {change.fields.map((field) => (
                    <div key={field.field} className="contents">
                      <dt className={`${MICRO_LABEL} sm:pt-0.5`}>{fieldLabel(field.field)}</dt>
                      <dd className="text-foreground">
                        <span className="text-muted-foreground line-through decoration-muted-foreground/60">{formatHistoryValue(change.family, field.field, field.old)}</span>
                        <span aria-hidden="true" className="mx-2 text-muted-foreground">→</span>
                        <span className="sr-only"> changed to </span>
                        <b className="font-semibold text-navy">{formatHistoryValue(change.family, field.field, field.new)}</b>
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ol>
        )}
        {nextOffset !== null && (
          <button type="button" onClick={() => setOffset(nextOffset)} disabled={page.isFetching} className={`${BTN_SECONDARY} mt-4 h-9 px-4`} data-testid="button-history-more">
            {page.isFetching ? 'Loading…' : `Show older changes (${Math.max(0, (total ?? 0) - showing.length)} more)`}
          </button>
        )}
      </div>
    </SectionCard>
  );
}
