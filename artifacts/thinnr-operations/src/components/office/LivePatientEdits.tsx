/**
 * Write actions on a LIVE patient record: profile edits, activation status,
 * staff-only provider notes, and staff-recorded weigh-ins.
 *
 * Every action calls the office-scoped API (server-audited); after a
 * successful write the detail and roster queries are invalidated so the trend,
 * loss figures, and roster badges follow immediately. A stale save comes back
 * as a `record_changed` conflict and is surfaced as "reload", never retried
 * against the newer record. The guided demo never renders these components.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Edit2, FileText, RefreshCw, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, LINK_ACTION, MICRO_LABEL, PANEL_LABEL } from '@/components/patient/heritage';
import { useSession } from '@/contexts/session';
import { useToast } from '@/hooks/use-toast';
import {
  OfficeRosterError,
  RECORD_CHANGED_MESSAGE,
  addProviderNote,
  deleteProviderNote,
  deleteStaffWeight,
  formatUsPhoneInput,
  recordStaffWeight,
  setPatientStatus,
  updatePatientProfile,
  updateStaffWeight,
  type OfficePatientDetail,
  type OfficeProviderNote,
  type OfficeStaffWeight,
  type PatientActivationStatus,
  type PatientProfilePatch,
} from '@/lib/office-roster';
import { officeRosterQueryKey } from '@/components/office/LiveRoster';

export function livePatientQueryKey(office: string | null, id: string) {
  return ['office-patient', office ?? 'own-office', id] as const;
}

/**
 * Who may write to a live record from this browser: office staff (the server
 * scopes them to their own office) and HQ admins holding provider_manage.
 * The server is authoritative — this only decides whether to show controls.
 */
export function useCanEditLiveRecord(patient?: Pick<OfficePatientDetail['patient'], 'closure'>): boolean {
  const { authStatus, authRole, hqRole, claimedWorkspace } = useSession();
  if (patient?.closure) return false;
  if (authStatus !== 'signed-in') return false;
  if (authRole === 'provider_staff') return true;
  // Claimed office logins have no profile role but are office staff.
  if (claimedWorkspace?.kind === 'provider' || claimedWorkspace?.kind === 'team_member') return true;
  return authRole === 'hq_admin' && (hqRole === 'Super Admin' || hqRole === 'Admin');
}

const formatStamp = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const formatDay = (dateKey: string) =>
  new Date(`${dateKey}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export interface RecordContext {
  id: string;
  office: string | null;
  version: string | null;
}

/**
 * Shared outcome handling for every write: field errors land beside their
 * input, a conflict shows the reload state, permission denials explain
 * themselves, and everything else is a plain toast.
 */
export function useRecordWrite(ctx: RecordContext) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [conflict, setConflict] = useState(false);
  const [forbidden, setForbidden] = useState<string | null>(null);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: livePatientQueryKey(ctx.office, ctx.id) }),
      queryClient.invalidateQueries({ queryKey: officeRosterQueryKey(ctx.office) }),
    ]);
  };

  const reload = async () => {
    setConflict(false);
    await refresh();
  };

  const run = async <T,>(
    work: () => Promise<T>,
    options: { success: string; failure: string; onField?: (field: string, message: string) => void },
  ): Promise<T | null> => {
    setForbidden(null);
    try {
      const result = await work();
      await refresh();
      toast({ variant: 'success', title: options.success });
      return result;
    } catch (error) {
      if (error instanceof OfficeRosterError) {
        if (error.isConflict) { setConflict(true); return null; }
        if (error.isForbidden) { setForbidden(error.message); return null; }
        if (error.field && options.onField) { options.onField(error.field, error.message); return null; }
      }
      toast({ variant: 'destructive', title: options.failure, description: error instanceof Error ? error.message : 'Try again.' });
      return null;
    }
  };

  return { run, conflict, forbidden, reload };
}

export function ConflictNotice({ onReload, testId }: { onReload: () => void | Promise<void>; testId: string }) {
  return (
    <div role="alert" data-testid={testId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[#e8b47c] bg-[#fff4e6] px-3 py-2 text-xs text-[#b65c22]">
      <span>{RECORD_CHANGED_MESSAGE}</span>
      <button type="button" onClick={() => void onReload()} className={`${BTN_SECONDARY} h-8 px-3`}>
        <RefreshCw size={13} aria-hidden="true" />Reload record
      </button>
    </div>
  );
}

export function ForbiddenNotice({ message }: { message: string }) {
  return <p role="alert" className="rounded-md border border-[#d5a7a7] bg-[#fff0f0] px-3 py-2 text-xs text-destructive">{message}</p>;
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <p id={id} role="alert" className="mt-1 text-[11px] font-medium text-destructive">{message}</p> : null;
}

// ── Profile ──────────────────────────────────────────────────────────────────

type ProfileForm = {
  firstName: string; lastName: string; email: string; phone: string; dateOfBirth: string;
  heightFeet: string; heightInches: string; goalWeight: string; programStartDate: string; timezone: string;
};
type ProfileErrors = Partial<Record<keyof ProfileForm | 'form', string>>;

const TIMEZONE_OPTIONS = [
  ['', 'Not recorded'],
  ['America/New_York', 'Eastern (ET)'],
  ['America/Chicago', 'Central (CT)'],
  ['America/Denver', 'Mountain (MT)'],
  ['America/Phoenix', 'Arizona (no DST)'],
  ['America/Los_Angeles', 'Pacific (PT)'],
  ['America/Anchorage', 'Alaska (AKT)'],
  ['Pacific/Honolulu', 'Hawaii (HT)'],
] as const;

function profileFormFrom(patient: OfficePatientDetail['patient']): ProfileForm {
  const identity = patient.identity;
  const inches = identity.heightInches ?? null;
  const parts = identity.name.trim().split(/\s+/);
  return {
    firstName: identity.firstName ?? parts[0] ?? '',
    lastName: identity.lastName ?? parts.slice(1).join(' '),
    email: identity.email ?? '',
    phone: identity.phoneDisplay ?? identity.phone ?? '',
    dateOfBirth: identity.dateOfBirth ?? '',
    heightFeet: inches == null ? '' : String(Math.floor(inches / 12)),
    heightInches: inches == null ? '' : String(Math.round((inches % 12) * 10) / 10),
    goalWeight: patient.program.goalWeight == null ? '' : String(patient.program.goalWeight),
    programStartDate: patient.program.startDate ?? '',
    timezone: identity.timezone ?? '',
  };
}

/** Only fields that actually changed are sent, so the audit field summary is honest. */
function profilePatch(initial: ProfileForm, form: ProfileForm): { patch: PatientProfilePatch; errors: ProfileErrors } {
  const patch: PatientProfilePatch = {};
  const errors: ProfileErrors = {};
  if (form.firstName !== initial.firstName) {
    if (!form.firstName.trim()) errors.firstName = 'First name is required.'; else patch.firstName = form.firstName.trim();
  }
  if (form.lastName !== initial.lastName) {
    if (!form.lastName.trim()) errors.lastName = 'Last name is required.'; else patch.lastName = form.lastName.trim();
  }
  if (form.email !== initial.email) {
    if (!form.email.trim()) errors.email = 'Email is required.'; else patch.email = form.email.trim();
  }
  if (form.phone !== initial.phone) {
    if (!form.phone.trim()) errors.phone = 'Phone number is required.'; else patch.phone = form.phone.trim();
  }
  if (form.dateOfBirth !== initial.dateOfBirth) patch.dateOfBirth = form.dateOfBirth || null;
  if (form.heightFeet !== initial.heightFeet || form.heightInches !== initial.heightInches) {
    if (!form.heightFeet && !form.heightInches) patch.heightInches = null;
    else {
      const total = Number(form.heightFeet || 0) * 12 + Number(form.heightInches || 0);
      if (!Number.isFinite(total) || total < 24 || total > 96) errors.heightInches = 'Height must be between 2\u2032 and 8\u2032.';
      else patch.heightInches = Math.round(total * 10) / 10;
    }
  }
  if (form.goalWeight !== initial.goalWeight) {
    if (!form.goalWeight) patch.goalWeight = null;
    else {
      const goal = Number(form.goalWeight);
      if (!Number.isFinite(goal) || goal < 40 || goal > 1500) errors.goalWeight = 'Goal weight must be between 40 and 1500 lbs.';
      else patch.goalWeight = goal;
    }
  }
  if (form.programStartDate !== initial.programStartDate) patch.programStartDate = form.programStartDate || null;
  if (form.timezone !== initial.timezone) patch.timezone = form.timezone || null;
  return { patch, errors };
}

export function EditPatientProfile({ patient, office }: { patient: OfficePatientDetail['patient']; office: string | null }) {
  const ctx: RecordContext = { id: patient.identity.id, office, version: patient.version };
  const write = useRecordWrite(ctx);
  const [open, setOpen] = useState(false);
  const [initial, setInitial] = useState<ProfileForm>(() => profileFormFrom(patient));
  const [form, setForm] = useState<ProfileForm>(initial);
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [pending, setPending] = useState(false);

  const openEditor = () => {
    const next = profileFormFrom(patient);
    setInitial(next);
    setForm(next);
    setErrors({});
    setOpen(true);
  };
  const close = () => { if (!pending) setOpen(false); };
  const set = (key: keyof ProfileForm) => (value: string) => {
    setForm((current) => ({ ...current, [key]: key === 'phone' ? formatUsPhoneInput(value) : value }));
    setErrors((current) => ({ ...current, [key]: undefined, form: undefined }));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { patch, errors: nextErrors } = profilePatch(initial, form);
    if (Object.keys(nextErrors).length) { setErrors(nextErrors); return; }
    if (Object.keys(patch).length === 0) { setErrors({ form: 'Nothing has changed yet.' }); return; }
    setPending(true);
    const result = await write.run(
      () => updatePatientProfile(ctx.id, patch, ctx.version, office),
      {
        success: 'Patient profile updated',
        failure: 'Profile not saved',
        onField: (field, message) => setErrors({ [field === 'heightInches' ? 'heightInches' : field]: message }),
      },
    );
    setPending(false);
    if (result) setOpen(false);
  };

  const field = (key: keyof ProfileForm, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="block">
      <span className={PANEL_LABEL}>{label}</span>
      <input
        {...props}
        className={`${INPUT_CLASS} mt-1 h-9 w-full ${props.className ?? ''}`}
        value={form[key]}
        onChange={(event) => set(key)(event.target.value)}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={errors[key] ? `edit-patient-${key}-error` : undefined}
        data-testid={`input-edit-patient-${key}`}
      />
      <FieldError id={`edit-patient-${key}-error`} message={errors[key]} />
    </label>
  );

  return (
    <>
      <button type="button" onClick={openEditor} className={`${BTN_SECONDARY} h-9 px-4`} data-testid="button-edit-patient">
        <Edit2 size={14} className="text-primary" aria-hidden="true" />Edit patient
      </button>
      {write.conflict && !open && <div className="mt-4"><ConflictNotice onReload={write.reload} testId="notice-profile-conflict" /></div>}
      {write.forbidden && !open && <div className="mt-4"><ForbiddenNotice message={write.forbidden} /></div>}
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Edit patient details</DialogTitle>
            <DialogDescription>Changes save to the live record and are recorded in the office audit log.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void submit(event)} noValidate>
            <div className="space-y-4">
              {write.conflict && <ConflictNotice onReload={async () => { await write.reload(); setOpen(false); }} testId="notice-profile-conflict" />}
              {write.forbidden && <ForbiddenNotice message={write.forbidden} />}
              <div className="grid grid-cols-2 gap-3">
                {field('firstName', 'First name', { autoComplete: 'off' })}
                {field('lastName', 'Last name', { autoComplete: 'off' })}
              </div>
              {field('email', 'Email', { type: 'email', inputMode: 'email' })}
              {field('phone', 'US mobile number', { type: 'tel', inputMode: 'tel' })}
              <div className="grid grid-cols-2 gap-3">
                {field('dateOfBirth', 'Date of birth', { type: 'date' })}
                {field('programStartDate', 'Program start date', { type: 'date' })}
              </div>
              <div className="grid grid-cols-3 gap-3">
                <fieldset className="col-span-2">
                  <legend className={PANEL_LABEL}>Height</legend>
                  <div className="mt-1 grid grid-cols-2 gap-2">
                    <input aria-label="Height feet" type="number" min={2} max={8} step={1} inputMode="numeric" className={`${INPUT_CLASS} h-9 w-full font-mono`} value={form.heightFeet} onChange={(event) => set('heightFeet')(event.target.value)} placeholder="ft" aria-invalid={errors.heightInches ? true : undefined} data-testid="input-edit-patient-heightFeet" />
                    <input aria-label="Height inches" type="number" min={0} max={11.9} step={0.1} inputMode="decimal" className={`${INPUT_CLASS} h-9 w-full font-mono`} value={form.heightInches} onChange={(event) => set('heightInches')(event.target.value)} placeholder="in" aria-invalid={errors.heightInches ? true : undefined} aria-describedby={errors.heightInches ? 'edit-patient-heightInches-error' : undefined} data-testid="input-edit-patient-heightInches" />
                  </div>
                  <FieldError id="edit-patient-heightInches-error" message={errors.heightInches} />
                </fieldset>
                {field('goalWeight', 'Goal weight (lbs)', { type: 'number', min: 40, max: 1500, step: 0.1, inputMode: 'decimal', className: 'font-mono' })}
              </div>
              <label className="block">
                <span className={PANEL_LABEL}>Timezone</span>
                <select className={`${INPUT_CLASS} mt-1 h-9 w-full px-2`} value={form.timezone} onChange={(event) => set('timezone')(event.target.value)} data-testid="select-edit-patient-timezone">
                  {TIMEZONE_OPTIONS.map(([value, label]) => <option key={value || 'none'} value={value}>{label}</option>)}
                  {form.timezone && !TIMEZONE_OPTIONS.some(([value]) => value === form.timezone) && <option value={form.timezone}>{form.timezone}</option>}
                </select>
                <FieldError id="edit-patient-timezone-error" message={errors.timezone} />
              </label>
              <FieldError id="edit-patient-form-error" message={errors.form} />
            </div>
            <DialogFooter className="mt-5">
              <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={close}>Cancel</button>
              <button type="submit" className={`${BTN_PRIMARY} h-9 px-3.5`} disabled={pending} data-testid="button-edit-patient-save">{pending ? 'Saving…' : 'Save changes'}</button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Activation status ────────────────────────────────────────────────────────

const STATUS_LABEL: Record<PatientActivationStatus, string> = { activated: 'Active', paused: 'Paused', discharged: 'Discharged' };

export function currentActivation(status: string | null): PatientActivationStatus | null {
  if (status === 'paused' || status === 'discharged') return status;
  if (status === 'activated' || status === 'active') return 'activated';
  return null;
}

export function PatientStatusControl({ patient, office }: { patient: OfficePatientDetail['patient']; office: string | null }) {
  const ctx: RecordContext = { id: patient.identity.id, office, version: patient.version };
  const write = useRecordWrite(ctx);
  const current = currentActivation(patient.identity.activationStatus);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<PatientActivationStatus>(current ?? 'activated');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!current) return null; // Invited / unconnected patients have no program status yet.

  const openDialog = () => {
    setStatus(current === 'activated' ? 'paused' : 'activated');
    setReason('');
    setError(null);
    setOpen(true);
  };
  const close = () => { if (!pending) setOpen(false); };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === current) { setError(`This patient is already ${STATUS_LABEL[status].toLowerCase()}.`); return; }
    if (status !== 'activated' && !reason.trim()) { setError('Give a reason so the care team knows why.'); return; }
    setPending(true);
    const result = await write.run(
      () => setPatientStatus(ctx.id, reason.trim() ? { status, reason: reason.trim() } : { status }, ctx.version, office),
      { success: `Patient marked ${STATUS_LABEL[status].toLowerCase()}`, failure: 'Status not changed', onField: (_field, message) => setError(message) },
    );
    setPending(false);
    if (result) setOpen(false);
  };

  return (
    <div className="space-y-3" data-testid="section-activation-status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className={MICRO_LABEL}>Program status</p>
          <p className="mt-1 text-sm font-semibold text-foreground" data-testid="text-activation-status">{STATUS_LABEL[current]}</p>
          {patient.identity.activationReason && current !== 'activated' && (
            <p className="mt-1 text-xs leading-5 text-muted-foreground" data-testid="text-activation-reason">{patient.identity.activationReason}</p>
          )}
          {patient.identity.activationUpdatedAt && <p className="mt-1 text-[10px] text-muted-foreground">Updated {formatStamp(patient.identity.activationUpdatedAt)}</p>}
        </div>
        <button type="button" onClick={openDialog} className={`${BTN_SECONDARY} h-8 px-3`} data-testid="button-change-status">Change status</button>
      </div>
      {write.conflict && !open && <ConflictNotice onReload={write.reload} testId="notice-status-conflict" />}
      {write.forbidden && !open && <ForbiddenNotice message={write.forbidden} />}
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Change program status</DialogTitle>
            <DialogDescription>Paused and discharged patients stay in the roster but drop out of needs-attention outreach signals.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void submit(event)} noValidate>
            <div className="space-y-4">
              {write.conflict && <ConflictNotice onReload={async () => { await write.reload(); setOpen(false); }} testId="notice-status-conflict" />}
              {write.forbidden && <ForbiddenNotice message={write.forbidden} />}
              <fieldset>
                <legend className={PANEL_LABEL}>New status</legend>
                <div className="mt-2 space-y-2">
                  {(Object.keys(STATUS_LABEL) as PatientActivationStatus[]).map((value) => (
                    <label key={value} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs ${status === value ? 'border-primary bg-accent text-navy' : 'border-border text-foreground'}`}>
                      <input type="radio" name="activation-status" value={value} checked={status === value} onChange={() => { setStatus(value); setError(null); }} disabled={value === current} data-testid={`radio-status-${value}`} />
                      <span className="font-semibold">{STATUS_LABEL[value]}</span>
                      {value === current && <span className="text-[10px] text-muted-foreground">(current)</span>}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="block">
                <span className={PANEL_LABEL}>Reason{status === 'activated' ? ' (optional)' : ''}</span>
                <textarea value={reason} onChange={(event) => { setReason(event.target.value); setError(null); }} maxLength={500} className={`${INPUT_CLASS} mt-1 min-h-20 w-full resize-y p-3`} placeholder={status === 'activated' ? 'e.g. Back from travel' : 'e.g. Travelling for a month'} aria-invalid={error ? true : undefined} aria-describedby={error ? 'status-reason-error' : undefined} data-testid="input-status-reason" />
                <FieldError id="status-reason-error" message={error ?? undefined} />
              </label>
            </div>
            <DialogFooter className="mt-5">
              <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={close}>Cancel</button>
              <button type="submit" className={`${BTN_PRIMARY} h-9 px-3.5`} disabled={pending} data-testid="button-status-save">{pending ? 'Saving…' : 'Save status'}</button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Provider notes ───────────────────────────────────────────────────────────

const AUTHOR_KIND_LABEL: Record<OfficeProviderNote['authorKind'], string> = { provider: 'Provider', team_member: 'Office staff', hq: 'THINNR HQ' };

export function ProviderNotes({ patient, notes, office, canEdit }: { patient: OfficePatientDetail['patient']; notes: OfficeProviderNote[]; office: string | null; canEdit: boolean }) {
  const ctx: RecordContext = { id: patient.identity.id, office, version: patient.version };
  const write = useRecordWrite(ctx);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const ordered = [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) { setError('Write the note before saving.'); return; }
    setPending(true);
    const result = await write.run(
      () => addProviderNote(ctx.id, body, office),
      { success: 'Provider note added', failure: 'Note not saved', onField: (_field, message) => setError(message) },
    );
    setPending(false);
    if (result) { setDraft(''); setOpen(false); }
  };

  const remove = async (note: OfficeProviderNote) => {
    if (!window.confirm('Remove this provider note from the record?')) return;
    setRemoving(note.id);
    await write.run(() => deleteProviderNote(ctx.id, note.id, office), { success: 'Provider note removed', failure: 'Note not removed' });
    setRemoving(null);
  };

  return (
    <div className="p-5" data-testid="section-provider-notes">
      <p className="mb-3 text-[10px] leading-4 text-muted-foreground">Staff-only. Provider notes never appear in the patient's app.</p>
      {write.forbidden && <div className="mb-3"><ForbiddenNotice message={write.forbidden} /></div>}
      {canEdit && (open ? (
        <form className="mb-4 rounded-md border border-border bg-secondary p-3" onSubmit={(event) => void submit(event)} noValidate>
          <label className={PANEL_LABEL}>Provider note
            <textarea value={draft} onChange={(event) => { setDraft(event.target.value); setError(null); }} maxLength={4000} placeholder="Add a concise internal note" className={`${INPUT_CLASS} mt-1 min-h-20 w-full resize-y p-3`} aria-invalid={error ? true : undefined} aria-describedby={error ? 'provider-note-error' : undefined} data-testid="input-provider-note" />
          </label>
          <FieldError id="provider-note-error" message={error ?? undefined} />
          <div className="mt-2 flex items-center gap-3">
            <button type="submit" className={`${BTN_PRIMARY} px-4 py-2`} disabled={pending} data-testid="button-provider-note-save">{pending ? 'Saving…' : 'Save note'}</button>
            <button type="button" onClick={() => { setOpen(false); setError(null); }} className="rounded-sm text-xs font-semibold text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Cancel</button>
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className={`mb-3 inline-flex items-center gap-1 ${LINK_ACTION}`} data-testid="button-add-provider-note"><FileText size={13} aria-hidden="true" />Add note</button>
      ))}
      {ordered.length ? (
        <ul className="divide-y divide-border">
          {ordered.map((note) => (
            <li key={note.id} className="flex gap-3 py-3 first:pt-0 last:pb-0" data-testid={`provider-note-${note.id}`}>
              <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground"><FileText size={15} aria-hidden="true" /></div>
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap text-sm text-foreground">{note.body}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">{formatStamp(note.createdAt)} · {note.authorName} · {AUTHOR_KIND_LABEL[note.authorKind]}</p>
              </div>
              {canEdit && (
                <button type="button" onClick={() => void remove(note)} disabled={removing === note.id} aria-label={`Remove note from ${formatStamp(note.createdAt)}`} className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" data-testid={`button-remove-note-${note.id}`}>
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-muted-foreground">No provider notes have been added.</p>}
    </div>
  );
}

// ── Staff weigh-ins ──────────────────────────────────────────────────────────

type WeightForm = { dateKey: string; weight: string; note: string };
type WeightErrors = Partial<Record<keyof WeightForm, string>>;

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function validateWeightForm(form: WeightForm): WeightErrors {
  const errors: WeightErrors = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.dateKey)) errors.dateKey = 'Choose the day of the weigh-in.';
  else if (form.dateKey > todayKey()) errors.dateKey = 'A weigh-in cannot be in the future.';
  const weight = Number(form.weight);
  if (!form.weight.trim() || !Number.isFinite(weight)) errors.weight = 'Enter the weight in pounds.';
  else if (weight < 40 || weight > 1500) errors.weight = 'Weight must be between 40 and 1500 lbs.';
  if (form.note.length > 500) errors.note = 'Keep the note under 500 characters.';
  return errors;
}

function WeightFields({ form, errors, onChange, prefix }: { form: WeightForm; errors: WeightErrors; onChange: (key: keyof WeightForm, value: string) => void; prefix: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-[150px_140px_1fr]">
      <label className="block">
        <span className={PANEL_LABEL}>Date</span>
        <input type="date" max={todayKey()} value={form.dateKey} onChange={(event) => onChange('dateKey', event.target.value)} className={`${INPUT_CLASS} mt-1 h-9 w-full`} aria-invalid={errors.dateKey ? true : undefined} aria-describedby={errors.dateKey ? `${prefix}-dateKey-error` : undefined} data-testid={`input-${prefix}-dateKey`} />
        <FieldError id={`${prefix}-dateKey-error`} message={errors.dateKey} />
      </label>
      <label className="block">
        <span className={PANEL_LABEL}>Weight (lbs)</span>
        <input type="number" min={40} max={1500} step={0.1} inputMode="decimal" value={form.weight} onChange={(event) => onChange('weight', event.target.value)} className={`${INPUT_CLASS} mt-1 h-9 w-full font-mono`} aria-invalid={errors.weight ? true : undefined} aria-describedby={errors.weight ? `${prefix}-weight-error` : undefined} data-testid={`input-${prefix}-weight`} />
        <FieldError id={`${prefix}-weight-error`} message={errors.weight} />
      </label>
      <label className="block">
        <span className={PANEL_LABEL}>Note (optional)</span>
        <input type="text" maxLength={500} value={form.note} onChange={(event) => onChange('note', event.target.value)} placeholder="e.g. Office scale, clothed" className={`${INPUT_CLASS} mt-1 h-9 w-full`} aria-invalid={errors.note ? true : undefined} data-testid={`input-${prefix}-note`} />
        <FieldError id={`${prefix}-note-error`} message={errors.note} />
      </label>
    </div>
  );
}

export function StaffWeightEntry({ patient, office, open, onClose }: { patient: OfficePatientDetail['patient']; office: string | null; open: boolean; onClose: () => void }) {
  const ctx: RecordContext = { id: patient.identity.id, office, version: patient.version };
  const write = useRecordWrite(ctx);
  const [form, setForm] = useState<WeightForm>({ dateKey: todayKey(), weight: '', note: '' });
  const [errors, setErrors] = useState<WeightErrors>({});
  const [pending, setPending] = useState(false);
  if (!open) return write.forbidden ? <div className="mb-4"><ForbiddenNotice message={write.forbidden} /></div> : null;

  const change = (key: keyof WeightForm, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validateWeightForm(form);
    if (Object.keys(nextErrors).length) { setErrors(nextErrors); return; }
    setPending(true);
    const result = await write.run(
      () => recordStaffWeight(ctx.id, { dateKey: form.dateKey, weight: Number(form.weight), ...(form.note.trim() ? { note: form.note.trim() } : {}) }, office),
      { success: 'Weight recorded', failure: 'Weight not recorded', onField: (field, message) => setErrors({ [field]: message }) },
    );
    setPending(false);
    if (result) { setForm({ dateKey: todayKey(), weight: '', note: '' }); onClose(); }
  };

  return (
    <form className="mb-5 space-y-3 rounded-md border border-border bg-secondary p-3" onSubmit={(event) => void submit(event)} noValidate data-testid="form-staff-weight">
      {write.forbidden && <ForbiddenNotice message={write.forbidden} />}
      <WeightFields form={form} errors={errors} onChange={change} prefix="staff-weight" />
      <div className="flex items-center gap-3">
        <button type="submit" className={`${BTN_PRIMARY} h-9 px-4`} disabled={pending} data-testid="button-staff-weight-save">{pending ? 'Saving…' : 'Add entry'}</button>
        <button type="button" onClick={onClose} className="rounded-sm text-xs font-semibold text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Cancel</button>
      </div>
    </form>
  );
}

/** Correct or remove one staff-entered reading; patient readings are read-only here. */
export function StaffWeightActions({ patient, entry, office }: { patient: OfficePatientDetail['patient']; entry: OfficeStaffWeight; office: string | null }) {
  const ctx: RecordContext = { id: patient.identity.id, office, version: patient.version };
  const write = useRecordWrite(ctx);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<WeightForm>({ dateKey: entry.dateKey, weight: String(entry.weight), note: entry.note ?? '' });
  const [errors, setErrors] = useState<WeightErrors>({});
  const [pending, setPending] = useState(false);

  const openEditor = () => {
    setForm({ dateKey: entry.dateKey, weight: String(entry.weight), note: entry.note ?? '' });
    setErrors({});
    setOpen(true);
  };
  const close = () => { if (!pending) setOpen(false); };
  const change = (key: keyof WeightForm, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validateWeightForm(form);
    if (Object.keys(nextErrors).length) { setErrors(nextErrors); return; }
    const patch: { dateKey?: string; weight?: number; note?: string | null } = {};
    if (form.dateKey !== entry.dateKey) patch.dateKey = form.dateKey;
    if (Number(form.weight) !== entry.weight) patch.weight = Number(form.weight);
    if ((form.note.trim() || null) !== (entry.note ?? null)) patch.note = form.note.trim() || null;
    if (Object.keys(patch).length === 0) { setErrors({ weight: 'Nothing has changed yet.' }); return; }
    setPending(true);
    const result = await write.run(
      () => updateStaffWeight(ctx.id, entry.id, patch, entry.version, office),
      { success: 'Weight corrected', failure: 'Weight not corrected', onField: (field, message) => setErrors({ [field]: message }) },
    );
    setPending(false);
    if (result) setOpen(false);
  };

  const remove = async () => {
    if (!window.confirm(`Remove the ${entry.weight.toFixed(1)} lbs reading from ${formatDay(entry.dateKey)}?`)) return;
    setPending(true);
    const result = await write.run(() => deleteStaffWeight(ctx.id, entry.id, entry.version, office), { success: 'Weight removed', failure: 'Weight not removed' });
    setPending(false);
    if (result) setOpen(false);
  };

  return (
    <>
      <button type="button" onClick={openEditor} className={`${LINK_ACTION} text-[11px]`} aria-label={`Correct the ${formatDay(entry.dateKey)} weigh-in`} data-testid={`button-correct-weight-${entry.id}`}>Correct</button>
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Correct staff weigh-in</DialogTitle>
            <DialogDescription>Recorded by {entry.recordedByName} on {formatStamp(entry.createdAt)}. Corrections are audited.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void submit(event)} noValidate>
            <div className="space-y-3">
              {write.conflict && <ConflictNotice onReload={async () => { await write.reload(); setOpen(false); }} testId="notice-weight-conflict" />}
              {write.forbidden && <ForbiddenNotice message={write.forbidden} />}
              <WeightFields form={form} errors={errors} onChange={change} prefix={`correct-weight`} />
            </div>
            <DialogFooter className="mt-5 sm:justify-between">
              <button type="button" onClick={() => void remove()} disabled={pending} className="inline-flex items-center gap-1 rounded-sm text-xs font-semibold text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" data-testid="button-remove-weight"><Trash2 size={13} aria-hidden="true" />Remove reading</button>
              <div className="flex gap-2">
                <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={close}>Cancel</button>
                <button type="submit" className={`${BTN_PRIMARY} h-9 px-3.5`} disabled={pending} data-testid="button-correct-weight-save">{pending ? 'Saving…' : 'Save correction'}</button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
