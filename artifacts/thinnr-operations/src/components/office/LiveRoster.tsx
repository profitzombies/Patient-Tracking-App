/**
 * Live office roster + patient invitation UI for the Patient Roster page.
 *
 * Renders ONLY for authenticated live scopes — a signed-in provider office
 * (server derives the office from the bearer token) or an HQ drill-in on an
 * explicitly scoped account. The demo persona never mounts these, so the
 * seeded roster demo stays byte-identical.
 *
 * Invitation state derives from the row itself: pending until the patient's
 * first phone-verified sign-in links a login (verified). A failed email is a
 * durable state on the row and surfaces a Resend action here.
 */
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, MailWarning, RefreshCw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, PANEL_LABEL } from '@/components/patient/heritage';
import {
  fetchOfficeRoster,
  formatUsPhoneInput,
  invitePatient,
  resendInvitation,
  validateInviteForm,
  OfficeRosterError,
  type InvitationEmailOutcome,
  type InvitePatientInput,
  type OfficePatient,
} from '@/lib/office-roster';

export function officeRosterQueryKey(office: string | null) {
  return ['office-roster', office ?? 'own-office'] as const;
}

function emailOutcomeToast(
  toast: ReturnType<typeof useToast>['toast'],
  name: string,
  outcome: InvitationEmailOutcome,
  verb: 'sent' | 'resent',
) {
  if (outcome === 'sent') {
    toast({
      variant: 'success',
      title: `Invitation ${verb} to ${name}`,
      description: 'They sign in to the THINNR app with the invited phone number to get connected.',
    });
  } else {
    toast({
      variant: 'destructive',
      title: `${name} was added, but the email didn’t go out`,
      description:
        outcome === 'not_configured'
          ? 'Email delivery isn’t configured in this environment. Use Resend once it is.'
          : 'Use Resend on the live roster to try the email again.',
    });
  }
}

const EMPTY_FORM: InvitePatientInput = { firstName: '', lastName: '', email: '', phone: '' };

/** Top-right roster action: opens the invite form, refreshes the roster on success. */
export function InvitePatientAction({ office }: { office: string | null }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<InvitePatientInput>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof InvitePatientInput, string>>>({});
  const [pending, setPending] = useState(false);

  const setField = (field: keyof InvitePatientInput) => (value: string) => {
    setForm((prev) => ({ ...prev, [field]: field === 'phone' ? formatUsPhoneInput(value) : value }));
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  };

  const close = () => {
    setOpen(false);
    setForm(EMPTY_FORM);
    setErrors({});
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validateInviteForm(form);
    if (Object.values(found).some(Boolean)) {
      setErrors(found);
      return;
    }
    setPending(true);
    try {
      const result = await invitePatient(
        {
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          email: form.email.trim(),
          phone: form.phone,
        },
        office,
      );
      await queryClient.invalidateQueries({ queryKey: officeRosterQueryKey(office) });
      emailOutcomeToast(toast, result.patient.name, result.invitation, 'sent');
      close();
    } catch (error) {
      if (error instanceof OfficeRosterError && error.field && error.field in EMPTY_FORM) {
        setErrors({ [error.field]: error.message });
      } else {
        toast({
          variant: 'destructive',
          title: 'Invitation not sent',
          description: error instanceof Error ? error.message : 'Try again.',
        });
      }
    } finally {
      setPending(false);
    }
  };

  const field = (
    key: keyof InvitePatientInput,
    label: string,
    props: { placeholder: string; type?: string; inputMode?: 'tel' | 'email' },
  ) => (
    <label className="block">
      <span className={PANEL_LABEL}>{label}</span>
      <input
        className={`${INPUT_CLASS} mt-1 h-9 w-full`}
        value={form[key]}
        type={props.type ?? 'text'}
        inputMode={props.inputMode}
        onChange={(event) => setField(key)(event.target.value)}
        placeholder={props.placeholder}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={errors[key] ? `invite-${key}-error` : undefined}
        data-testid={`input-invite-patient-${key}`}
      />
      {errors[key] && (
        <p id={`invite-${key}-error`} className="mt-1 text-[11px] font-medium text-destructive" role="alert">
          {errors[key]}
        </p>
      )}
    </label>
  );

  return (
    <>
      <button
        type="button"
        className={`${BTN_PRIMARY} h-9 px-3.5`}
        onClick={() => setOpen(true)}
        data-testid="button-invite-patient"
      >
        <UserPlus size={14} aria-hidden="true" className="mr-1.5" />
        Invite Patient
      </button>
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Invite a patient</DialogTitle>
            <DialogDescription>
              They’ll get a THINNR email invitation and connect to this office automatically by
              signing in to the app with this phone number.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void submit(event)} noValidate>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {field('firstName', 'First name', { placeholder: 'e.g. Jordan' })}
                {field('lastName', 'Last name', { placeholder: 'e.g. Ellis' })}
              </div>
              {field('email', 'Email', { placeholder: 'name@example.com', type: 'email', inputMode: 'email' })}
              {field('phone', 'US mobile number', { placeholder: '(555) 201-7788', type: 'tel', inputMode: 'tel' })}
            </div>
            <DialogFooter className="mt-5">
              <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={close}>
                Cancel
              </button>
              <button
                type="submit"
                className={`${BTN_PRIMARY} h-9 px-3.5`}
                disabled={pending}
                data-testid="button-invite-patient-submit"
              >
                {pending ? 'Sending…' : 'Send invitation'}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function InvitationChip({ patient }: { patient: OfficePatient }) {
  if (!patient.invitation) return null;
  const pending = patient.invitation.state === 'pending';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] ${
        pending
          ? 'border-[#e8b47c] bg-[#fff4e6] text-[#b65c22]'
          : 'border-accent-border bg-accent text-primary'
      }`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {pending ? 'Invite pending' : 'Verified'}
    </span>
  );
}

/**
 * The office's live patients, newest first — invited patients appear here
 * the moment the invitation lands, with their verification state.
 */
export function LiveRosterCard({ office }: { office: string | null }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [resending, setResending] = useState<string | null>(null);
  const roster = useQuery({
    queryKey: officeRosterQueryKey(office),
    queryFn: () => fetchOfficeRoster(office),
    refetchInterval: 30_000,
  });

  const resend = async (patient: OfficePatient) => {
    setResending(patient.id);
    try {
      const result = await resendInvitation(patient.id, office);
      await queryClient.invalidateQueries({ queryKey: officeRosterQueryKey(office) });
      emailOutcomeToast(toast, patient.name, result.invitation, 'resent');
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Invitation not resent',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setResending(null);
    }
  };

  return (
    <section
      aria-label="Live roster"
      className="mb-6 overflow-hidden rounded-lg border border-border bg-card shadow-soft"
      data-testid="live-roster"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-paper-alt px-4 py-3">
        <div>
          <h2 className="font-serif text-lg font-bold leading-tight text-navy">Live roster</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {roster.data
              ? `${roster.data.office.officeName} — provider code ${roster.data.office.providerCode}`
              : 'Patients connected to this office, including pending invitations.'}
          </p>
        </div>
        <button
          type="button"
          className={`${BTN_SECONDARY} h-8 px-3`}
          onClick={() => void roster.refetch()}
          disabled={roster.isFetching}
          data-testid="button-live-roster-refresh"
        >
          <RefreshCw size={12} aria-hidden="true" className={`mr-1.5 ${roster.isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>
      {roster.isLoading && (
        <div className="p-6 text-center text-xs text-muted-foreground">Loading the live roster…</div>
      )}
      {roster.isError && (
        <div className="p-6 text-center text-xs text-destructive" role="alert">
          {roster.error instanceof Error ? roster.error.message : 'The live roster could not be loaded.'}
        </div>
      )}
      {roster.data && roster.data.patients.length === 0 && (
        <div className="p-6 text-center text-xs text-muted-foreground">
          No live patients yet. Use Invite Patient to add the first one.
        </div>
      )}
      {roster.data && roster.data.patients.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="border-b border-border bg-secondary text-[10px] uppercase tracking-[.11em] text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Patient</th>
                <th className="px-4 py-2.5 font-semibold">Phone</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5 font-semibold">Invitation email</th>
                <th className="px-4 py-2.5 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {roster.data.patients.map((patient) => (
                <tr key={patient.id} className="border-b border-border last:border-0" data-testid={`live-roster-row-${patient.id}`}>
                  <td className="px-4 py-3">
                    <b className="block font-serif text-sm font-semibold leading-tight text-navy">{patient.name}</b>
                    <span className="text-[10px] text-muted-foreground">{patient.email}</span>
                  </td>
                  <td className="px-4 py-3 font-mono text-foreground/80">{patient.phoneDisplay ?? patient.phone ?? '—'}</td>
                  <td className="px-4 py-3">
                    {patient.invitation ? (
                      <InvitationChip patient={patient} />
                    ) : (
                      <span className="text-foreground/80 capitalize">{patient.activationStatus ?? '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {patient.invitation ? (
                      patient.invitation.emailStatus === 'failed' ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-destructive">
                          <MailWarning size={12} aria-hidden="true" /> Delivery failed
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground capitalize">{patient.invitation.emailStatus}</span>
                      )
                    ) : (
                      <span className="text-[11px] text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {patient.invitation?.state === 'pending' ? (
                      <button
                        type="button"
                        className={`${BTN_SECONDARY} h-8 px-3`}
                        onClick={() => void resend(patient)}
                        disabled={resending === patient.id}
                        data-testid={`button-resend-invite-${patient.id}`}
                      >
                        {resending === patient.id ? 'Resending…' : 'Resend invite'}
                      </button>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
