import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import { livePatientQueryKey } from '@/components/office/LivePatientEdits';
import {
  OfficeRosterError,
  addPatientMedication,
  fetchPatientMedications,
  updatePatientMedication,
  type OfficePatientDetail,
  type OfficePatientMedications,
} from '@/lib/office-roster';
import {
  MEDICATION_FORMS,
  MEDICATION_FORM_LABELS,
  WEEKDAY_LABELS,
  adherenceSummary,
  describeSchedule,
  medicationLine,
  parseClockLabel,
  validateMedicationInput,
  type MedicationForm,
  type MedicationInput,
  type MedicationRecord,
} from '@/lib/medication-schedule';

type Draft = {
  name: string;
  form: MedicationForm;
  dose: string;
  scheduleKind: 'daily' | 'weekly';
  times: string[];
  weekday: number;
  notes: string;
  startDate: string;
  stopDate: string;
};

const VALIDATION_ID = '00000000-0000-4000-8000-000000000000';
const EDITABLE = ['name', 'form', 'dose', 'scheduleKind', 'times', 'weekday', 'notes', 'startDate', 'stopDate'] as const;

function draftFor(medication: MedicationRecord | null, today: string): Draft {
  return medication ? {
    name: medication.name,
    form: medication.form,
    dose: medication.dose ?? '',
    scheduleKind: medication.scheduleKind,
    times: medication.times.map((time) => time),
    weekday: medication.weekday ?? 0,
    notes: medication.notes ?? '',
    startDate: medication.startDate,
    stopDate: medication.stopDate ?? '',
  } : {
    name: '',
    form: 'tablet',
    dose: '',
    scheduleKind: 'daily',
    times: [''],
    weekday: 0,
    notes: '',
    startDate: today,
    stopDate: '',
  };
}

function dateLabel(dateKey: string): string {
  return new Date(`${dateKey}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function MedicationForm({ medication, today, busy, onCancel, onSave }: {
  medication: MedicationRecord | null;
  today: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (value: MedicationInput, original: MedicationRecord | null) => Promise<{ error?: string; field?: string }>;
}) {
  const [draft, setDraft] = useState(() => draftFor(medication, today));
  const [error, setError] = useState<{ message: string; field: string } | null>(null);
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (error?.field === key || (key === 'times' && error?.field === 'times')) setError(null);
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const times = draft.times.map((label) => /^([01]\d|2[0-3]):[0-5]\d$/.test(label.trim()) ? label.trim() : parseClockLabel(label)).filter((time): time is string => Boolean(time));
    if (times.length !== draft.times.length) {
      setError({ message: 'Enter a time like 8:00 AM or 08:00.', field: 'times' });
      return;
    }
    const candidate = {
      id: medication?.id ?? VALIDATION_ID,
      name: draft.name,
      form: draft.form,
      dose: draft.dose || null,
      scheduleKind: draft.scheduleKind,
      times,
      weekday: draft.scheduleKind === 'weekly' ? draft.weekday : null,
      notes: draft.notes || null,
      startDate: draft.startDate,
      stopDate: medication && draft.stopDate ? draft.stopDate : null,
    };
    const valid = validateMedicationInput(candidate);
    if (!valid.ok) {
      setError({ message: valid.error, field: valid.field });
      return;
    }
    const outcome = await onSave(valid.value, medication);
    if (outcome.error) setError({ message: outcome.error, field: outcome.field ?? 'medication' });
  };
  const fieldError = (field: string) => error?.field === field
    ? <p className="mt-1 text-[10px] text-destructive" role="alert" data-testid="medication-form-error">{error.message}</p>
    : null;

  return (
    <form className="mb-5 space-y-4 rounded-md border border-border bg-secondary p-4" data-testid="medication-form" onSubmit={submit}>
      {error && !EDITABLE.includes(error.field as typeof EDITABLE[number]) && error.field !== 'times' && (
        <p role="alert" className="text-xs text-destructive" data-testid="medication-form-error">{error.message}</p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={PANEL_LABEL} htmlFor="medication-name">Name
          <input id="medication-name" data-testid="input-medication-name" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={draft.name} onChange={(e) => change('name', e.target.value)} />
          {fieldError('name')}
        </label>
        <label className={PANEL_LABEL} htmlFor="medication-form-select">Form
          <select id="medication-form-select" data-testid="select-medication-form" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={draft.form} onChange={(e) => change('form', e.target.value as MedicationForm)}>
            {MEDICATION_FORMS.map((form) => <option key={form} value={form}>{MEDICATION_FORM_LABELS[form]}</option>)}
          </select>
          {fieldError('form')}
        </label>
        <label className={PANEL_LABEL} htmlFor="medication-dose">Dose
          <input id="medication-dose" data-testid="input-medication-dose" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={draft.dose} onChange={(e) => change('dose', e.target.value)} />
          {fieldError('dose')}
        </label>
        <fieldset>
          <legend className={PANEL_LABEL}>Schedule</legend>
          <div className="mt-2 flex gap-4 text-xs">
            <label htmlFor="medication-daily"><input id="medication-daily" type="radio" name="medication-schedule" checked={draft.scheduleKind === 'daily'} onChange={() => change('scheduleKind', 'daily')} /> Daily</label>
            <label htmlFor="medication-weekly"><input id="medication-weekly" type="radio" name="medication-schedule" checked={draft.scheduleKind === 'weekly'} onChange={() => change('scheduleKind', 'weekly')} /> Weekly</label>
          </div>
          {fieldError('scheduleKind')}
        </fieldset>
        {draft.scheduleKind === 'weekly' && <label className={PANEL_LABEL} htmlFor="medication-weekday">Weekday
          <select id="medication-weekday" data-testid="select-medication-weekday" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={draft.weekday} onChange={(e) => change('weekday', Number(e.target.value))}>
            {WEEKDAY_LABELS.map((day, index) => <option key={day} value={index}>{day}</option>)}
          </select>
          {fieldError('weekday')}
        </label>}
        <label className={PANEL_LABEL} htmlFor="medication-start-date">Start date
          <input id="medication-start-date" data-testid="input-medication-start-date" type="date" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={draft.startDate} onChange={(e) => change('startDate', e.target.value)} />
          {fieldError('startDate')}
        </label>
        {medication && <label className={PANEL_LABEL} htmlFor="medication-stop-date">Stop date (optional)
          <input id="medication-stop-date" data-testid="input-medication-stop-date" type="date" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={draft.stopDate} onChange={(e) => change('stopDate', e.target.value)} />
          {fieldError('stopDate')}
        </label>}
      </div>
      <fieldset>
        <legend className={PANEL_LABEL}>Reminder times</legend>
        <div className="mt-2 space-y-2">
          {draft.times.map((time, index) => (
            <div className="flex gap-2" key={index}>
              <label className="sr-only" htmlFor={`medication-time-${index}`}>Reminder time {index + 1}</label>
              <input id={`medication-time-${index}`} data-testid={`input-medication-time-${index}`} className={`${INPUT_CLASS} h-9 flex-1`} placeholder="8:00 AM" value={time} onChange={(e) => change('times', draft.times.map((item, i) => i === index ? e.target.value : item))} />
              {draft.times.length > 1 && <button type="button" className={`${BTN_SECONDARY} h-9 px-3`} onClick={() => change('times', draft.times.filter((_, i) => i !== index))}>Remove</button>}
            </div>
          ))}
          {fieldError('times')}
          <button type="button" className={`${BTN_SECONDARY} h-8 px-3`} onClick={() => change('times', [...draft.times, ''])}>Add time</button>
        </div>
      </fieldset>
      <label className={PANEL_LABEL} htmlFor="medication-notes">Notes
        <textarea id="medication-notes" data-testid="input-medication-notes" className={`${INPUT_CLASS} mt-1 min-h-20 w-full py-2`} value={draft.notes} onChange={(e) => change('notes', e.target.value)} />
        {fieldError('notes')}
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" className={`${BTN_SECONDARY} h-9 px-4`} onClick={onCancel}>Cancel</button>
        <button type="submit" className={`${BTN_PRIMARY} h-9 px-4`} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

function MedicationRow({ medication, payload, canEdit, onEdit, onStop, confirming, busy }: {
  medication: MedicationRecord;
  payload: OfficePatientMedications;
  canEdit: boolean;
  onEdit: () => void;
  onStop: () => void;
  confirming: boolean;
  busy: boolean;
}) {
  const mini = adherenceSummary([medication], payload.doseLogs, payload.adherence.fromDate, payload.adherence.toDate, payload.timeZone, new Date());
  const source = medication.source[0].toUpperCase() + medication.source.slice(1);
  return (
    <li className="p-4" data-testid={`medication-row-${medication.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-serif text-sm font-bold text-navy">{medicationLine(medication)}</h3>
          <p className="mt-1 text-xs text-foreground">{MEDICATION_FORM_LABELS[medication.form]} · {describeSchedule(medication)}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">{source} · Started {dateLabel(medication.startDate)}{medication.stopDate ? ` · Stopped ${dateLabel(medication.stopDate)}` : ''}</p>
          {medication.notes && <p className="mt-2 text-xs leading-5 text-muted-foreground">{medication.notes}</p>}
          <p className="mt-2 font-mono text-[10px] text-primary">{mini.taken}/{mini.due} taken in this window</p>
        </div>
        {canEdit && <div className="flex gap-2">
          <button type="button" className={`${BTN_SECONDARY} h-8 px-3`} data-testid={`button-edit-medication-${medication.id}`} onClick={onEdit}>Edit</button>
          {!medication.stopDate && <button type="button" className={`${BTN_SECONDARY} h-8 px-3 text-destructive`} data-testid={`button-stop-medication-${medication.id}`} onClick={onStop}>{confirming ? 'Cancel' : 'Stop'}</button>}
        </div>}
      </div>
      {confirming && <div className="mt-3 rounded-md border border-warn-border bg-warn-bg p-3 text-xs text-warn">
        Stop this medication today?{' '}
        <button type="button" className={`${BTN_SECONDARY} ml-2 h-8 px-3`} disabled={busy} data-testid={`button-confirm-stop-${medication.id}`} onClick={onStop}>Confirm stop</button>
      </div>}
    </li>
  );
}

export function LiveMedications({ patient, office, canEdit }: {
  patient: OfficePatientDetail['patient'];
  office: string | null;
  canEdit: boolean;
}) {
  const patientId = patient.identity.id;
  const client = useQueryClient();
  const queryKey = ['office-patient-medications', patientId, office] as const;
  const query = useQuery({ queryKey, queryFn: () => fetchPatientMedications(patientId, office) });
  const [editing, setEditing] = useState<MedicationRecord | null | 'add'>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [writeNotice, setWriteNotice] = useState<string | null>(null);
  const write = useMutation({
    mutationFn: async ({ value, original }: { value: MedicationInput; original: MedicationRecord | null }) => {
      if (!original) {
        const { id: _id, ...medication } = value;
        return addPatientMedication(patientId, office, medication);
      }
      const patch: Partial<MedicationInput> & { expectedVersion: string | null } = { expectedVersion: original.version };
      for (const key of EDITABLE) {
        if (JSON.stringify(value[key]) !== JSON.stringify(original[key])) (patch as Record<string, unknown>)[key] = value[key];
      }
      return updatePatientMedication(patientId, office, original.id, patch);
    },
    onSuccess: async (payload) => {
      client.setQueryData(queryKey, payload);
      setEditing(null);
      setWriteNotice(null);
      await Promise.all([
        client.invalidateQueries({ queryKey }),
        client.invalidateQueries({ queryKey: livePatientQueryKey(office, patientId) }),
      ]);
    },
  });
  const stop = useMutation({
    mutationFn: (medication: MedicationRecord) => updatePatientMedication(patientId, office, medication.id, { stopDate: query.data!.today, expectedVersion: medication.version }),
    onSuccess: async (payload) => {
      client.setQueryData(queryKey, payload);
      setConfirming(null);
      await Promise.all([
        client.invalidateQueries({ queryKey }),
        client.invalidateQueries({ queryKey: livePatientQueryKey(office, patientId) }),
      ]);
    },
  });
  const handleError = async (error: unknown): Promise<{ error?: string; field?: string }> => {
    if (error instanceof OfficeRosterError && error.isConflict) {
      setWriteNotice('This record changed — reload to see the latest.');
      await query.refetch();
      return { error: 'This record changed — reload to see the latest.', field: 'medication' };
    }
    const message = error instanceof Error ? error.message : 'The medication was not saved.';
    setWriteNotice(message);
    return { error: message, field: error instanceof OfficeRosterError ? error.field ?? undefined : undefined };
  };
  const save = async (value: MedicationInput, original: MedicationRecord | null) => {
    try {
      await write.mutateAsync({ value, original });
      return {};
    } catch (error) {
      return handleError(error);
    }
  };
  const confirmStop = async (medication: MedicationRecord) => {
    if (confirming !== medication.id) { setConfirming(medication.id); return; }
    try {
      await stop.mutateAsync(medication);
    } catch (error) {
      await handleError(error);
    }
  };
  const payload = query.data;
  const active = payload?.medications.filter((medication) => !medication.stopDate) ?? [];
  const stopped = payload?.medications.filter((medication) => medication.stopDate) ?? [];

  return (
    <div data-testid="live-medications">
      <SectionCard
        title="Medications"
        sub="Schedules and the last 30 days of dose logging from the patient app."
        action={canEdit ? <button type="button" className={`${BTN_SECONDARY} h-8 px-3`} data-testid="button-add-medication" onClick={() => setEditing((current) => current === 'add' ? null : 'add')}>{editing === 'add' ? 'Cancel' : 'Add medication'}</button> : undefined}
      >
        <div className="p-5">
          {query.isLoading && <p className="text-xs text-muted-foreground">Loading medications…</p>}
          {query.isError && <p role="alert" className="text-xs text-destructive">Medications could not be loaded: {query.error instanceof Error ? query.error.message : 'Try again.'}</p>}
          {writeNotice && <p role="alert" className="mb-4 rounded-md border border-warn-border bg-warn-bg p-3 text-xs text-warn">{writeNotice}</p>}
          {payload && <>
            {editing && <MedicationForm key={editing === 'add' ? 'add' : editing.id} medication={editing === 'add' ? null : editing} today={payload.today} busy={write.isPending} onCancel={() => setEditing(null)} onSave={save} />}
            {payload.medications.length === 0 ? <div className="rounded-md border border-dashed border-border p-5 text-center text-xs text-muted-foreground">No medications on record.{canEdit && <button type="button" className="ml-2 font-semibold text-primary hover:underline" onClick={() => setEditing('add')}>Add medication</button>}</div> : <>
              <ul className="divide-y divide-border rounded-md border border-border">
                {active.map((medication) => <MedicationRow key={medication.id} medication={medication} payload={payload} canEdit={canEdit} onEdit={() => setEditing(medication)} onStop={() => void confirmStop(medication)} confirming={confirming === medication.id} busy={stop.isPending} />)}
              </ul>
              {stopped.length > 0 && <><h3 className="mt-5 mb-2 font-serif text-sm font-bold text-navy">Stopped</h3><ul className="divide-y divide-border rounded-md border border-border">{stopped.map((medication) => <MedicationRow key={medication.id} medication={medication} payload={payload} canEdit={canEdit} onEdit={() => setEditing(medication)} onStop={() => {}} confirming={false} busy={false} />)}</ul></>}
            </>}
            <div className="mt-5 rounded-md border border-border bg-secondary p-4" data-testid="medication-adherence">
              {payload.adherence.due === 0 ? <p className="font-serif text-sm font-bold text-navy">No doses have come due yet.</p> : <p className="font-serif text-sm font-bold text-navy">Taken {payload.adherence.taken} of {payload.adherence.due} due · {payload.adherence.skipped} skipped · {payload.adherence.missed} missed (30 days) · {payload.adherence.rate}%</p>}
              <div className="mt-3 grid grid-cols-10 gap-1 sm:grid-cols-[repeat(15,minmax(0,1fr))]">
                {payload.adherence.days.map((day) => {
                  const largest = Math.max(day.taken, day.skipped, day.missed);
                  const dominant = largest === 0
                    ? 'bg-card border-border'
                    : day.missed === largest
                      ? 'bg-warn-bg border-warn-border'
                      : day.skipped === largest
                        ? 'bg-secondary border-border'
                        : 'bg-accent border-accent-border';
                  const aria = `${dateLabel(day.dateKey)}: ${day.taken} taken, ${day.skipped} skipped, ${day.missed} missed`;
                  return <div key={day.dateKey} role="img" className={`min-h-9 rounded-sm border p-1 text-center font-mono text-[8px] text-muted-foreground ${dominant}`} aria-label={aria} title={aria}><span aria-hidden="true">{day.due || '·'}</span></div>;
                })}
              </div>
            </div>
          </>}
        </div>
      </SectionCard>
    </div>
  );
}