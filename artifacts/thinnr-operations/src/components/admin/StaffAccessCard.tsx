/**
 * Staff sign-ins for one provider account — where THINNR provisions real
 * office logins from the account page.
 *
 * The list reads from the live training roster (the same rows the office's
 * Team page shows): people filed under this office, with a chip marking who
 * has a working sign-in. The add form provisions a REAL login through the
 * API server: the staff member signs in immediately with this email and the
 * password the admin typed — no forced reset, by explicit decision — scoped
 * to this office exactly like the seeded demo staffer.
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
  BTN_PRIMARY,
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
import type { ProviderAccount } from '@/data/hq/accounts';

const CHIP_MUTED =
  'inline-flex items-center rounded-full border border-border bg-secondary px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.08em] text-muted-foreground';

const EMPTY_FORM = { firstName: '', lastName: '', email: '', phone: '', password: '' };

type FormState = typeof EMPTY_FORM;

function initialsOf(name: string): string {
  return name
    .split(' ')
    .map((word) => word[0])
    .slice(0, 2)
    .join('');
}

export function StaffAccessCard({ account }: { account: ProviderAccount }) {
  const { viewers, canEdit, refresh, status } = useTrainingData();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; field: StaffFormField | null } | null>(null);

  // The office code the roster keys on is account.id ('acct-p1'); providerId
  // ('p1') only marks which accounts are real provisioned offices. Session-
  // added accounts have providerId null — no real office, no sign-ins.
  const officeCode = account.providerId ? account.id : null;

  // Sign-in holders first, then the roster-only rows, both alphabetized —
  // "who can actually get in" is the question this card answers.
  const staff = useMemo(() => {
    if (!officeCode) return [];
    return viewers
      .filter((viewer) => viewer.accountId === officeCode)
      .sort(
        (a, b) =>
          Number(Boolean(b.authUserId)) - Number(Boolean(a.authUserId)) ||
          a.name.localeCompare(b.name),
      );
  }, [viewers, officeCode]);

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
    if (form.password.length < 8) {
      return { message: 'Passwords need at least 8 characters.', field: 'password' };
    }
    if (form.password.length > 72) {
      return { message: 'Passwords max out at 72 characters.', field: 'password' };
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
        phone: form.phone.trim() || undefined,
        password: form.password,
      });
      toast({
        title: `${created.name} can now sign in`,
        description: 'Their email and the password you set work on the office sign-in right away.',
      });
      setForm(EMPTY_FORM);
      refresh();
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

  return (
    <SectionCard title="Staff sign-ins" sub="Who can open the office side of THINNR for this account">
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
                      <span className={CHIP_COBALT}>Sign-in active</span>
                    ) : (
                      <span className={CHIP_MUTED}>Roster only</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p
                className="border-b border-border px-5 py-4 text-xs leading-relaxed text-muted-foreground"
                data-testid="text-staff-empty"
              >
                {status === 'ready'
                  ? 'No staff filed under this office on the training roster yet — create the first sign-in below.'
                  : status === 'error'
                    ? 'The live roster could not be loaded, so this list may be incomplete.'
                    : 'Loading the office roster…'}
              </p>
            )}

            <form onSubmit={submit} className="px-5 py-4">
              <p className={PANEL_LABEL}>Add a staff sign-in</p>
              <p className="mt-1 max-w-[68ch] text-[11px] leading-relaxed text-muted-foreground">
                Creates a real login for this office: they sign in with this email and password
                immediately — no reset required — and appear on the office training roster. Share the
                password with them yourself; THINNR never emails it.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
                <label className="block">
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
                </label>
                <label className="block">
                  <span className={MICRO_LABEL}>Phone (optional)</span>
                  <input
                    type="tel"
                    className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                    value={form.phone}
                    onChange={setField('phone')}
                    autoComplete="off"
                    aria-invalid={error?.field === 'phone' || undefined}
                    placeholder="(555) 000-0000"
                    data-testid="input-staff-phone"
                  />
                </label>
                <label className="block sm:col-span-2">
                  <span className={MICRO_LABEL}>Password *</span>
                  <input
                    type="password"
                    className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                    value={form.password}
                    onChange={setField('password')}
                    autoComplete="new-password"
                    aria-invalid={error?.field === 'password' || undefined}
                    data-testid="input-staff-password"
                  />
                  <span className="mt-1 block text-[10px] text-muted-foreground">
                    At least 8 characters. The staff member keeps using exactly this password.
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
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  className={`${BTN_PRIMARY} h-9 px-3.5`}
                  disabled={submitting}
                  data-testid="button-create-staff-login"
                >
                  <UserPlus size={14} aria-hidden="true" />
                  {submitting ? 'Creating sign-in…' : 'Create sign-in'}
                </button>
                {!canEdit && (
                  <span className="text-[10px] text-muted-foreground" data-testid="text-staff-demo-note">
                    Browsing as the demo persona — creating sign-ins needs a real THINNR HQ sign-in.
                  </span>
                )}
              </div>
            </form>
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
  );
}
