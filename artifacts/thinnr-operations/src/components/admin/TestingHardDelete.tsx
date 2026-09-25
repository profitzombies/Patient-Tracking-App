/**
 * HQ testing override: permanently erase an office or a patient.
 *
 * Temporary and NOT HIPAA compliant — it exists only while THINNR is being
 * tested and is self-contained so it can be removed in one go (this file,
 * lib/testing-hard-delete.ts, the two mounts, and the server routes). The
 * compliant offboarding and deletion-request flows are untouched.
 *
 * The delete button enables only after the preview loads, the exact name is
 * typed back, and a fresh sign-in code is confirmed.
 */
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BTN_SECONDARY, INPUT_CLASS } from '@/components/patient/heritage';
import { useSession } from '@/contexts/session';
import { requestReauth, ReauthRequiredError } from '@/lib/reauth';
import {
  describeStripeOutcome,
  fetchHardDeletePreview,
  HardDeleteRequestError,
  namesMatch,
  performHardDelete,
  type HardDeleteKind,
  type HardDeletePreview,
  type HardDeleteResult,
  type StripeOutcome,
} from '@/lib/testing-hard-delete';

const DANGER_BUTTON =
  'h-8 rounded-md border border-destructive bg-card px-3 text-xs font-semibold text-destructive transition-colors hover:bg-destructive hover:text-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-card disabled:hover:text-destructive';
const DANGER_SOLID =
  'h-9 rounded-md bg-destructive px-4 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40';

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** HQ admins with provider-management permission (Super Admin / Admin). */
export function useCanHardDelete(): boolean {
  const { authStatus, authRole, hqRole } = useSession();
  return authStatus === 'signed-in' && authRole === 'hq_admin' && (hqRole === 'Super Admin' || hqRole === 'Admin');
}

function stripeLine(account: { accountId: string; origin: string; archived: boolean }): string {
  const label = account.archived ? `Earlier Stripe account ${account.accountId}` : `Stripe account ${account.accountId}`;
  if (account.origin === 'created') return `${label} — created by THINNR, will be deleted in Stripe (if Stripe allows).`;
  if (account.origin === 'oauth') return `${label} — the office's own account, will be disconnected from THINNR.`;
  return `${label} — will be deleted in Stripe if THINNR created it, otherwise disconnected.`;
}

function PreviewList({ preview }: { preview: HardDeletePreview }) {
  const items: string[] = [];
  if (preview.kind === 'provider') {
    items.push(`The office “${preview.name}” and all of its settings, orders, conversations, files, billing and access records.`);
    items.push(`${plural(preview.staffLogins, 'staff login')} (owner and staff) — names, emails and phone numbers.`
      + (preview.hqMembersKept > 0 ? ` ${plural(preview.hqMembersKept, 'HQ team member')} keep their HQ login and only lose this office.` : ''));
    items.push(`${plural(preview.patients, 'patient')} and all of their data (${plural(preview.patientLogins, 'patient login')}).`);
    if (preview.stripeAccounts.length === 0) items.push('No Stripe account is connected.');
    for (const account of preview.stripeAccounts) items.push(stripeLine(account));
    if (preview.accessPlan) {
      items.push(`THINNR plan (${preview.accessPlan.state}) cancelled and ${plural(preview.accessPlan.savedPaymentMethods, 'saved card or bank record')} removed.`);
    }
  } else {
    items.push(`The patient “${preview.name}”${preview.officeName ? ` at ${preview.officeName}` : ''} and all of their data, photos, documents, orders and conversations.`);
    items.push(preview.hasLogin
      ? (preview.hqMemberKept ? 'Their login is kept because they are on the HQ team.' : 'Their login, email and phone number.')
      : 'They have no login.');
    if (preview.activeSubscriptions > 0) items.push(`${plural(preview.activeSubscriptions, 'active subscription')} cancelled in Stripe.`);
  }
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-navy" data-testid="list-hard-delete-preview">
      {items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  );
}

function ResultSummary({ result }: { result: HardDeleteResult }) {
  const rows = Object.values(result.rows).reduce((sum, n) => sum + (Number(n) || 0), 0);
  return (
    <div className="space-y-3 text-xs leading-relaxed text-navy" data-testid="hard-delete-result">
      <p className="font-semibold">“{result.name}” was permanently deleted.</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>{plural(rows, 'database record')} erased.</li>
        <li>
          {plural(result.logins.deleted + result.logins.alreadyGone, 'login')} removed
          {result.logins.keptHqMembers > 0 ? `; ${plural(result.logins.keptHqMembers, 'HQ team member')} kept their HQ login` : ''}.
        </li>
        <li>{plural(result.files.deleted, 'stored file')} deleted.</li>
        {result.stripe.map((outcome, index) => <li key={index} data-testid="hard-delete-stripe-outcome">{describeStripeOutcome(outcome)}</li>)}
      </ul>
      {(result.logins.failed.length > 0 || result.files.failed.length > 0) && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-[#fff0f0] px-3 py-2 text-destructive">
          {result.logins.failed.length > 0 && `${plural(result.logins.failed.length, 'login')} could not be removed. `}
          {result.files.failed.length > 0 && `${plural(result.files.failed.length, 'file')} could not be deleted from storage.`}
        </p>
      )}
    </div>
  );
}

export interface TestingHardDeleteProps {
  kind: HardDeleteKind;
  targetId: string;
  /** Shown before the preview loads. */
  label: string;
  /** Called after the HQ user closes the result; navigate away here. */
  onDeleted: () => void;
}

export function TestingHardDelete({ kind, targetId, label, onDeleted }: TestingHardDeleteProps) {
  const queryClient = useQueryClient();
  const headingId = useId();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [verified, setVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedStripe, setFailedStripe] = useState<StripeOutcome[]>([]);
  const [result, setResult] = useState<HardDeleteResult | null>(null);
  const noun = kind === 'provider' ? 'provider' : 'patient';
  const prefix = `hard-delete-${kind}`;

  const preview = useQuery({
    queryKey: ['hq-testing-delete', kind, targetId],
    queryFn: () => fetchHardDeletePreview(kind, targetId),
    enabled: open && !result,
    staleTime: 0,
    retry: false,
  });

  const expectedName = preview.data?.name ?? '';
  const nameOk = Boolean(preview.data) && namesMatch(typed, expectedName);
  const canDelete = nameOk && verified && !busy && !result;

  const reset = () => {
    setTyped(''); setVerified(false); setVerifying(false); setError(null); setFailedStripe([]);
  };

  const finish = () => {
    setOpen(false);
    setResult(null);
    reset();
    onDeleted();
  };

  const onOpenChange = (next: boolean) => {
    if (busy) return;
    if (!next && result) { finish(); return; }
    setOpen(next);
    if (!next) reset();
  };

  const verify = async () => {
    setError(null);
    setVerifying(true);
    try {
      const ok = await requestReauth();
      setVerified(ok);
      if (!ok) setError('Confirm a fresh sign-in code to continue.');
    } finally {
      setVerifying(false);
    }
  };

  const submit = async () => {
    if (!canDelete) return;
    setBusy(true);
    setError(null);
    setFailedStripe([]);
    try {
      const outcome = await performHardDelete(kind, targetId, typed);
      setResult(outcome);
      // The target is gone: drop its cached views and refresh every list/search.
      queryClient.removeQueries({ queryKey: ['hq-testing-delete', kind, targetId] });
      if (kind === 'provider') queryClient.removeQueries({ queryKey: ['provider-account-detail', targetId] });
      void queryClient.invalidateQueries();
    } catch (cause) {
      if (cause instanceof ReauthRequiredError) {
        setVerified(false);
        setError('Confirm a fresh sign-in code to continue.');
      } else if (cause instanceof HardDeleteRequestError) {
        setError(cause.message);
        setFailedStripe(cause.stripe);
      } else {
        setError('The delete could not be completed. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      className="mt-2 rounded-md border-2 border-dashed border-destructive/60 bg-[#fff0f0]/60 p-4"
      data-testid={`section-${prefix}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle size={14} aria-hidden="true" className="text-destructive" />
        <h4 id={headingId} className="text-xs font-semibold text-destructive">
          Delete {noun} permanently (testing override)
        </h4>
        <span className="rounded-full border border-destructive/40 bg-card px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.12em] text-destructive">
          Testing only · not HIPAA compliant
        </span>
      </div>
      <p className="mb-4 mt-2 max-w-[68ch] text-xs leading-relaxed text-muted-foreground">
        {kind === 'provider'
          ? 'Erases this office and everything tied to it — owner and staff logins, every patient and their data, orders, conversations, files, billing records and the Stripe connection. '
          : 'Erases this patient and everything tied to them — their login, data, photos, documents, orders and conversations. '}
        Nothing is kept, not even a record of the deletion. This bypasses the compliant offboarding and deletion flows and is for test accounts only.
      </p>
      <button type="button" className={DANGER_BUTTON} data-testid={`button-${prefix}`} onClick={() => setOpen(true)}>
        Delete {noun} permanently…
      </button>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg" data-testid={`dialog-${prefix}`}>
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">
              {result ? 'Deleted' : `Permanently delete ${preview.data?.name ?? label}?`}
            </DialogTitle>
            <DialogDescription>
              {result
                ? 'Here is what happened.'
                : 'Testing override — not HIPAA compliant. This cannot be undone and leaves no trace in THINNR.'}
            </DialogDescription>
          </DialogHeader>

          {result ? (
            <ResultSummary result={result} />
          ) : (
            <div className="space-y-4">
              {preview.isPending && <p className="text-xs text-muted-foreground" data-testid={`${prefix}-loading`}>Checking what will be erased…</p>}
              {preview.isError && (
                <p role="alert" className="text-xs text-destructive" data-testid={`${prefix}-preview-error`}>
                  {preview.error instanceof Error ? preview.error.message : 'Could not load what will be erased.'}
                </p>
              )}
              {preview.data && (
                <>
                  <div>
                    <p className="mb-2 text-[11px] font-semibold text-navy">This will erase:</p>
                    <PreviewList preview={preview.data} />
                  </div>
                  <div>
                    <label htmlFor={inputId} className="block text-[11px] font-semibold text-navy">
                      Type <span className="font-bold">{expectedName}</span> to confirm
                    </label>
                    <input
                      id={inputId}
                      className={`${INPUT_CLASS} mt-1.5`}
                      value={typed}
                      onChange={(event) => setTyped(event.target.value)}
                      autoComplete="off"
                      disabled={busy}
                      data-testid={`input-${prefix}-name`}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {verified ? (
                      <span className="inline-flex items-center text-[11px] font-semibold text-navy" data-testid={`${prefix}-verified`}>
                        <Check size={13} aria-hidden="true" className="mr-1 text-emerald-600" />Sign-in code confirmed
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={`${BTN_SECONDARY} h-8 px-3 text-[11px]`}
                        onClick={() => void verify()}
                        disabled={verifying || busy}
                        data-testid={`button-${prefix}-verify`}
                      >
                        {verifying ? 'Waiting for code…' : 'Confirm with a sign-in code'}
                      </button>
                    )}
                  </div>
                </>
              )}
              {error && <p role="alert" className="text-xs text-destructive" data-testid={`${prefix}-error`}>{error}</p>}
              {failedStripe.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-[11px] text-muted-foreground" data-testid={`${prefix}-failed-stripe`}>
                  {failedStripe.map((outcome, index) => <li key={index}>{describeStripeOutcome(outcome)}</li>)}
                </ul>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            {result ? (
              <button type="button" className={`${BTN_SECONDARY} h-9 px-4`} onClick={finish} data-testid={`button-${prefix}-done`}>
                {kind === 'provider' ? 'Back to accounts' : 'Back to patients'}
              </button>
            ) : (
              <>
                <button type="button" className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={() => onOpenChange(false)} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={DANGER_SOLID}
                  onClick={() => void submit()}
                  disabled={!canDelete}
                  data-testid={`button-${prefix}-confirm`}
                >
                  {busy ? 'Deleting…' : `Delete ${noun} permanently`}
                </button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
