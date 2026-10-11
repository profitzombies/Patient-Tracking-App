/**
 * /delete-account — Google Play's required "delete account" URL (Apple
 * reviewers may check it too). Same request the app's "Close my account"
 * button files, reached without the app:
 *
 *   identify (email or mobile) → one-time code → request filed (or the grace
 *   end of a request already pending).
 *
 * The identify step never says whether an account exists; the code step is
 * the only place a match is revealed, and only to whoever holds the inbox or
 * phone.
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, LINK_ACTION } from '@/components/patient/heritage';
import { PublicLegalError, publicLegal, type DeletionVerifyResponse } from '@/lib/legal-api';
import { LegalFrame } from './LegalFrame';

export const GRACE_DAYS = 7;

type Phase =
  | { step: 'identify' }
  | { step: 'code'; requestId: string; identifier: string; devCode: string | null }
  | { step: 'done'; result: DeletionVerifyResponse };

function graceEndLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      {children}
    </p>
  );
}

export default function DeleteAccountPage() {
  const [phase, setPhase] = useState<Phase>({ step: 'identify' });
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitIdentify(event: FormEvent) {
    event.preventDefault();
    const value = identifier.trim();
    if (!value) { setError('Enter the email address or mobile number on your account.'); return; }
    setBusy(true);
    setError(null);
    try {
      const started = await publicLegal.startDeletion(value);
      setCode('');
      setPhase({ step: 'code', requestId: started.requestId, identifier: value, devCode: started.devCode ?? null });
    } catch (caught) {
      setError(caught instanceof PublicLegalError ? caught.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    if (phase.step !== 'code') return;
    const digits = code.replace(/\D/g, '');
    if (digits.length !== 6) { setError('Enter the 6-digit code.'); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await publicLegal.verifyDeletion(phase.requestId, digits);
      setPhase({ step: 'done', result });
    } catch (caught) {
      setError(caught instanceof PublicLegalError ? caught.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    setPhase({ step: 'identify' });
    setCode('');
    setError(null);
  }

  return (
    <LegalFrame
      title="Delete your THINNR account"
      lede="Request deletion without the app. This is the same request as “Close my account” in the app’s Account screen."
      current="/delete-account"
    >
      {phase.step === 'identify' ? (
        <form onSubmit={submitIdentify} className="mt-6 space-y-4" noValidate data-testid="delete-identify-form">
          <div className="space-y-1.5">
            <label htmlFor="delete-identifier" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Email address or mobile number on your account
            </label>
            <input
              id="delete-identifier"
              data-testid="input-delete-identifier"
              className={`${INPUT_CLASS} h-11 w-full text-sm`}
              autoComplete="username"
              inputMode="email"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              disabled={busy}
            />
          </div>
          {error ? <Alert>{error}</Alert> : null}
          <button type="submit" className={`${BTN_PRIMARY} h-11 px-5`} disabled={busy} data-testid="button-delete-send-code">
            {busy ? 'Sending…' : 'Send me a code'}
          </button>
          <p className="text-xs text-muted-foreground">
            If an account matches, we’ll send a one-time code to that email or phone. We never confirm whether an account exists on this page.
          </p>
        </form>
      ) : null}

      {phase.step === 'code' ? (
        <form onSubmit={submitCode} className="mt-6 space-y-4" noValidate data-testid="delete-code-form">
          <p className="text-sm text-foreground/90" data-testid="delete-code-sent">
            If an account matches <strong className="font-semibold">{phase.identifier}</strong>, we’ve sent a 6-digit code. Enter it below within 10 minutes.
          </p>
          {phase.devCode ? (
            <p className="text-xs text-muted-foreground" data-testid="delete-dev-code">Development code: {phase.devCode}</p>
          ) : null}
          <div className="space-y-1.5">
            <label htmlFor="delete-code" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              One-time code
            </label>
            <input
              id="delete-code"
              data-testid="input-delete-code"
              className={`${INPUT_CLASS} h-11 w-full max-w-[220px] text-center text-lg tracking-[.4em]`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              disabled={busy}
            />
          </div>
          {error ? <Alert>{error}</Alert> : null}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className={`${BTN_PRIMARY} h-11 px-5`} disabled={busy} data-testid="button-delete-confirm">
              {busy ? 'Checking…' : 'Confirm and request deletion'}
            </button>
            <button type="button" className={`${BTN_SECONDARY} h-11 px-4`} onClick={startOver} disabled={busy} data-testid="button-delete-start-over">
              Start over
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Confirming schedules your account for deletion after a {GRACE_DAYS}-day grace period. You can cancel during that time.
          </p>
        </form>
      ) : null}

      {phase.step === 'done' ? (
        <section className="mt-6 space-y-4" data-testid="delete-done" aria-live="polite">
          {phase.result.alreadyPending ? (
            <div className="rounded-md border border-border bg-background px-4 py-4">
              <h2 className="font-serif text-[20px] text-navy">A deletion is already scheduled</h2>
              <p className="mt-1 text-sm text-foreground/90" data-testid="delete-pending-grace">
                Your account is already set to be deleted after{' '}
                <strong className="font-semibold">{phase.result.deletion ? graceEndLabel(phase.result.deletion.purgeAfter) : 'the grace period'}</strong>.
                Nothing new was filed.
              </p>
            </div>
          ) : (
            <div className="rounded-md border border-border bg-background px-4 py-4">
              <h2 className="font-serif text-[20px] text-navy">Deletion requested</h2>
              <p className="mt-1 text-sm text-foreground/90" data-testid="delete-filed-grace">
                Your account will be permanently deleted after{' '}
                <strong className="font-semibold">{phase.result.deletion ? graceEndLabel(phase.result.deletion.purgeAfter) : `${GRACE_DAYS} days`}</strong>.
              </p>
            </div>
          )}
          <p className="text-sm text-foreground/90">
            <strong className="font-semibold">Changed your mind?</strong> Sign in to the THINNR app before that date and tap{' '}
            <em>Keep my account</em> under Account → Privacy &amp; data, or email support from the{' '}
            <Link href="~/support" className={LINK_ACTION}>support page</Link>. After the grace period ends the deletion cannot be undone.
          </p>
        </section>
      ) : null}

      <section className="mt-10 border-t border-border pt-6 text-sm leading-6 text-foreground/90">
        <h2 className="font-serif text-[20px] text-navy">What happens when your account is deleted</h2>
        <h3 className="mt-3 text-sm font-semibold text-foreground">Deleted</h3>
        <ul className="mt-1 list-disc space-y-1 pl-6">
          <li>Your sign-in, profile and preferences.</li>
          <li>Food and water diary, check-ins, measurements and progress photos.</li>
          <li>Medication schedules, bloodwork uploads, coach conversations and care-team messages.</li>
          <li>Notification tokens and app usage records tied to you.</li>
        </ul>
        <h3 className="mt-4 text-sm font-semibold text-foreground">Kept by your office, as the law requires</h3>
        <ul className="mt-1 list-disc space-y-1 pl-6">
          <li>Clinical record entries your office is required to retain for the period its state law sets.</li>
          <li>Financial records of purchases: order numbers, amounts, dates and receipts, for the retention period that applies to them.</li>
          <li>An entry in the office’s audit trail that a deletion was requested and completed, without your program data.</li>
        </ul>
        <p className="mt-4 text-xs text-muted-foreground">
          Details are in the <Link href="~/privacy" className={LINK_ACTION}>Privacy Policy</Link>. The grace period is {GRACE_DAYS} days from the request.
        </p>
      </section>
    </LegalFrame>
  );
}
