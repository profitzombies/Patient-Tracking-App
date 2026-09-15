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
import { useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
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
  formatUsPhoneInput,
  invitePatient,
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

/**
 * Invitation state chip. Verified is the normal case and gets no badge: the
 * roster's status chip already speaks for the patient. Only a pending or
 * failed invitation earns a chip, so the Status column shows one chip per row.
 */
export function InvitationChip({ patient }: { patient: OfficePatient }) {
  if (!patient.invitation || patient.invitation.state !== 'pending') return null;
  const failed = patient.invitation.emailStatus === 'failed';
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border px-2 py-1 text-[9px] font-bold uppercase tracking-[.05em] ${
        failed ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-[#e8b47c] bg-[#fff4e6] text-[#b65c22]'
      }`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {failed ? 'Delivery failed' : 'Invite pending'}
    </span>
  );
}
