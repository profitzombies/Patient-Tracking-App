/**
 * Staff sign-ins for one provider account — where THINNR provisions real
 * office logins from the account page.
 *
 * The list reads from the live training roster (the same rows the office's
 * Team page shows): people filed under this office, with a chip marking who
 * has a working sign-in. The add form files a REAL login through the API
 * server: sign-ins are passwordless, so the server records the staff member
 * under this office and emails an invitation — they sign in right away with
 * a one-time code sent to that email, scoped to this office exactly like
 * the seeded demo staffer.
 *
 * Writes follow the author-write rule: only a real signed-in HQ admin can
 * provision; the demo persona gets the standard sign-in nudge. Session-added
 * demo accounts (browser-only) say honestly that live sign-ins exist for
 * provisioned accounts only.
 */
import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { UserPlus } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CHIP_COBALT,
  INPUT_CLASS,
  MICRO_LABEL,
  PANEL_LABEL,
  SectionCard,
} from '@/components/patient/heritage';
import { useTrainingData } from '@/contexts/training-data';
import {
  provisionStaffLogin,
  StaffProvisioningError,
  type StaffFormField,
} from '@/lib/staff-provisioning';
import type { ProviderAccount, ProviderStaffMember } from '@/data/hq/accounts';

const CHIP_MUTED =
  'inline-flex items-center rounded-full border border-border bg-secondary px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.08em] text-muted-foreground';

const EMPTY_FORM = { firstName: '', lastName: '', email: '' };

type FormState = typeof EMPTY_FORM;

function initialsOf(name: string): string {
  return name
    .split(' ')
    .map((word) => word[0])
    .slice(0, 2)
    .join('');
}

export function StaffAccessCard({ account, staff: liveStaff, onCreated }: {
  account: ProviderAccount;
  staff: ProviderStaffMember[];
  onCreated: () => void;
}) {
  const { canEdit, refresh } = useTrainingData();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; field: StaffFormField | null } | null>(null);

  // The office code the roster keys on is account.id ('acct-p1'); providerId
  // ('p1') only marks which accounts are real provisioned offices. Session-
  // added accounts have providerId null — no real office, no sign-ins.
  const officeCode = account.id;

  // Sign-in holders first, then the roster-only rows, both alphabetized —
  // "who can actually get in" is the question this card answers.
  const staff = useMemo(() => {
    return [...liveStaff]
      .sort(
        (a, b) =>
          Number(Boolean(b.authUserId)) - Number(Boolean(a.authUserId)) ||
          a.name.localeCompare(b.name),
      );
  }, [liveStaff]);

  const setField =
    (field: keyof FormState) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setForm((previous) => ({ ...previous, [field]: value }));
    };

  const validate = (): { message: string; field: StaffFormField } | null => {
    if (!form.firstName.trim()) return { message: 'First name is required.', field: 'firstName' };
    if (!form.lastName.trim()) return { message: 'Last name is required.', field: 'lastName' };
    const email = form.email.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { message: 'Enter a valid email address.', field: 'email' };
    }
    return null;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!officeCode || submitting) return;
    if (!canEdit) {
      toast({
        title: 'Sign in to make changes',
        description:
          'The demo persona can browse HQ, but creating staff sign-ins needs a real THINNR HQ sign-in.',
      });
      return;
    }
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const created = await provisionStaffLogin(officeCode, {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim().toLowerCase(),
      });
      toast({
        variant: 'success',
        title: `${created.name} can now sign in`,
        description: 'We emailed them an invitation — a one-time code sent to that address signs them in. No password to share.',
      });
      setForm(EMPTY_FORM);
      setOpen(false);
      refresh();
      onCreated();
    } catch (cause) {
      if (cause instanceof StaffProvisioningError) {
        setError({ message: cause.message, field: cause.field });
      } else {
        setError({ message: 'Something unexpected went wrong — try again.', field: null });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const openAddDialog = () => {
    setForm(EMPTY_FORM);
    setError(null);
    setOpen(true);
  };

  return (
    <>
      <SectionCard
        title="Staff sign-ins"
        sub="Who can open the office side of THINNR for this account"
        action={
          officeCode ? (
            <button
              type="button"
              className={`${BTN_PRIMARY} h-9 px-3.5`}
              onClick={openAddDialog}
              data-testid="button-add-team-member"
            >
              <UserPlus size={14} aria-hidden="true" />
              Add Team Member
            </button>
          ) : undefined
        }
      >
      <div data-testid="section-staff-access">
        {officeCode ? (
          <>
            {staff.length > 0 ? (
              <ul>
                {staff.map((person) => (
                  <li
                    key={person.id}
                    className="flex items-center gap-3 border-b border-border px-5 py-3"
                    data-testid={`row-staff-${person.id}`}
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent text-[10px] font-bold text-primary">
                      {initialsOf(person.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <b className="block truncate text-xs font-semibold text-navy">{person.name}</b>
                      <small className="block truncate text-[10px] text-muted-foreground">
                        {person.email}
                      </small>
                    </span>
                    {person.authUserId ? (
                      <span className={CHIP_COBALT}>Active</span>
                    ) : (
                      <span className={CHIP_MUTED}>{person.activationStatus === 'disabled' ? 'Disabled' : 'Invited'}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p
                className="border-b border-border px-5 py-4 text-xs leading-relaxed text-muted-foreground"
                data-testid="text-staff-empty"
              >
                No staff are filed under this provider account yet — use Add Team Member above to create the first sign-in.
              </p>
            )}
          </>
        ) : (
          <p
            className="px-5 py-6 text-xs leading-relaxed text-muted-foreground"
            data-testid="text-staff-unavailable"
          >
            Live sign-ins are available for provisioned accounts only. This account was added during
            the demo session and lives only in this browser, so there&rsquo;s no real office for a
            login to open yet.
          </p>
        )}
      </div>
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[520px]" data-testid="dialog-add-team-member">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Add Team Member</DialogTitle>
            <DialogDescription>
              Creates a real login for this office. We email them an invitation, and a one-time code
              sent to that address signs them in — no password. They appear on the office training
              roster right away.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={submit}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={MICRO_LABEL}>First name *</span>
                <input
                  className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                  value={form.firstName}
                  onChange={setField('firstName')}
                  autoComplete="off"
                  aria-invalid={error?.field === 'firstName' || undefined}
                  placeholder="e.g. Dana"
                  data-testid="input-staff-first-name"
                />
              </label>
              <label className="block">
                <span className={MICRO_LABEL}>Last name *</span>
                <input
                  className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                  value={form.lastName}
                  onChange={setField('lastName')}
                  autoComplete="off"
                  aria-invalid={error?.field === 'lastName' || undefined}
                  placeholder="e.g. Reyes"
                  data-testid="input-staff-last-name"
                />
              </label>
              <label className="block sm:col-span-2">
                <span className={MICRO_LABEL}>Email *</span>
                <input
                  type="email"
                  className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                  value={form.email}
                  onChange={setField('email')}
                  autoComplete="off"
                  aria-invalid={error?.field === 'email' || undefined}
                  placeholder="name@office.example.com"
                  data-testid="input-staff-email"
                />
                <span className="mt-1 block text-[10px] text-muted-foreground">
                  This is their sign-in: a one-time code goes to this address each time they log in
                  from a new device.
                </span>
              </label>
            </div>
            {error && (
              <p
                role="alert"
                className="mt-3 text-xs font-semibold text-destructive"
                data-testid="text-staff-form-error"
              >
                {error.message}
              </p>
            )}
            <DialogFooter className="mt-5">
              <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type="submit"
                className={`${BTN_PRIMARY} h-9 px-3.5`}
                disabled={submitting}
                data-testid="button-create-staff-login"
              >
                <UserPlus size={14} aria-hidden="true" />
                {submitting ? 'Creating sign-in…' : 'Create sign-in'}
              </button>
            </DialogFooter>
            {!canEdit && (
              <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground" data-testid="text-staff-demo-note">
                Browsing as the demo persona — creating sign-ins needs a real THINNR HQ sign-in.
              </p>
            )}
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
