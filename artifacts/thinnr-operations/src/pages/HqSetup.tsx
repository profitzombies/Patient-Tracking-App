/**
 * The page behind the "Set up your THINNR account" button in an HQ
 * invitation email.
 *
 * The emailed token is the only credential here, and all it buys is a
 * greeting: the invitee's name, their role, and the address they were
 * invited at. Signing in is the ordinary passwordless staff flow against
 * that address — a one-time email code, plus the texted-code step where
 * policy requires it — and accepting the invitation happens server-side at
 * that moment. A dead or unrecognised token gets its own message and never
 * reveals whether it belonged to anybody.
 */
import { useEffect, useState } from 'react';
import { useSearch } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useStaffPasswordlessSignIn } from '@/hooks/useStaffPasswordlessSignIn';
import { lookupHqInvitation, type HqInvitationLookup } from '@/lib/hq-team';

type LookupState = { status: 'loading' } | { status: 'ready'; result: HqInvitationLookup };

/** What each dead-end token state says, all of them ending in the same advice. */
const DEAD_END: Record<'used' | 'cancelled' | 'expired' | 'unknown' | 'unavailable', { title: string; body: string }> = {
  used: {
    title: 'This setup link has already been used',
    body: 'The account it created is active. Sign in with your work email from the THINNR Operations sign-in page.',
  },
  cancelled: {
    title: 'This invitation was cancelled',
    body: 'Your administrator withdrew it. Ask them to send a new invitation if you still need access.',
  },
  expired: {
    title: 'This setup link has expired',
    body: 'Setup links are short-lived for security. Ask your administrator to resend your invitation.',
  },
  unknown: {
    title: 'This setup link isn’t valid',
    body: 'It may have been mistyped, truncated by an email client, or replaced by a newer invitation. Ask your administrator to resend it.',
  },
  unavailable: {
    title: 'We couldn’t check that setup link',
    body: 'Something went wrong on our side. Try the link again in a moment, or ask your administrator to resend your invitation.',
  },
};

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-background font-sans text-foreground">
      <header className="mx-auto flex w-full max-w-[640px] items-center justify-between px-8 pt-7">
        <span className="font-serif text-[26px] text-navy">THINNR</span>
        <span className="text-xs font-semibold text-muted-foreground">Account setup</span>
      </header>
      <main className="mx-auto flex w-full max-w-[640px] flex-1 items-center px-5 py-8">
        <section className="w-full rounded-lg border border-card-border bg-card p-6 shadow-lifted sm:p-10">
          {children}
        </section>
      </main>
    </div>
  );
}

export default function HqSetup() {
  const search = useSearch();
  const token = new URLSearchParams(search).get('token') ?? '';
  const [lookup, setLookup] = useState<LookupState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setLookup({ status: 'ready', result: { state: 'unknown' } });
      return;
    }
    setLookup({ status: 'loading' });
    void lookupHqInvitation(token)
      .then((result) => { if (!cancelled) setLookup({ status: 'ready', result }); })
      .catch(() => { if (!cancelled) setLookup({ status: 'ready', result: { state: 'unavailable' } }); });
    return () => { cancelled = true; };
  }, [token]);

  const invitation = lookup.status === 'ready' && lookup.result.state === 'pending' ? lookup.result : null;
  const {
    phase, email, otp, setOtp, phone, setPhone, smsCode, setSmsCode, smsRequestId, phoneStep,
    devCode, error, notice, busy, submitEmail, submitCode, submitPhone, resendCode, sendPhoneCode,
    changePhoneNumber, supabaseEnabled,
  } = useStaffPasswordlessSignIn({ initialEmail: invitation?.email, lockEmail: true });

  if (lookup.status === 'loading') {
    return (
      <Frame>
        <p data-testid="text-setup-loading" className="text-sm text-muted-foreground">Checking your invitation…</p>
      </Frame>
    );
  }

  if (lookup.result.state !== 'pending') {
    const copy = DEAD_END[lookup.result.state];
    return (
      <Frame>
        <h1 data-testid="text-setup-dead-end" className="font-serif text-[26px] font-bold leading-tight tracking-[-.02em] text-navy">
          {copy.title}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{copy.body}</p>
        <p className="mt-6 text-xs text-muted-foreground">
          Already have access? <a className="font-semibold text-primary underline-offset-2 hover:underline" href="/">Go to the sign-in page</a>.
        </p>
      </Frame>
    );
  }

  const live = lookup.result;

  return (
    <Frame>
      <p className="text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">THINNR HQ invitation</p>
      <h1 data-testid="text-setup-greeting" className="mt-2 font-serif text-[30px] font-bold leading-tight tracking-[-.02em] text-navy">
        Welcome, {live.name}
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        You’ve been invited to THINNR HQ as{' '}
        <span data-testid="text-setup-role" className="font-semibold text-foreground">{live.role}</span>
        {live.title ? ` (${live.title})` : ''}. There’s no password to choose — we’ll email a one-time code to{' '}
        <span data-testid="text-setup-email" className="font-semibold text-foreground">{live.email}</span>, and that signs you in.
      </p>

      {!supabaseEnabled && (
        <p role="alert" className="mt-4 rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-xs font-medium leading-relaxed text-warn">
          Sign-in isn’t configured in this environment, so this invitation can’t be completed here.
        </p>
      )}

      {notice && !error && (
        <p role="status" data-testid="text-setup-notice" className="mt-4 rounded-md border border-border bg-accent px-3 py-2 text-xs font-medium leading-relaxed text-foreground">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" data-testid="text-setup-error" className="mt-4 rounded-md border border-destructive-border bg-destructive/10 px-3 py-2 text-xs font-medium leading-relaxed text-destructive">
          {error}
        </p>
      )}
      {devCode && (
        <p data-testid="text-setup-devcode" className="mt-4 rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-xs font-medium leading-relaxed text-warn">
          Dev delivery mode — your code is {devCode}.
        </p>
      )}

      {phase === 'email' && (
        <form className="mt-6" onSubmit={submitEmail} noValidate>
          <Button type="submit" data-testid="button-setup-send-code" className="h-10 w-full" disabled={busy || !supabaseEnabled || !email}>
            {busy ? 'Sending code…' : 'Email me a sign-in code'}
          </Button>
        </form>
      )}

      {phase === 'code' && (
        <form className="mt-6" onSubmit={submitCode} noValidate>
          <Label htmlFor="setup-otp" className="text-xs font-semibold text-navy">6-digit code</Label>
          <Input
            id="setup-otp"
            data-testid="input-setup-otp"
            className="mt-1.5 text-center text-lg font-semibold tracking-[.4em]"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="one-time-code"
            value={otp}
            onChange={(event) => setOtp(event.target.value.replace(/\D/g, ''))}
            disabled={busy}
            autoFocus
          />
          <Button type="submit" data-testid="button-setup-verify" className="mt-4 h-10 w-full" disabled={busy}>
            {busy ? 'Verifying…' : 'Verify and finish setup'}
          </Button>
          <button
            type="button"
            data-testid="button-setup-resend-code"
            onClick={resendCode}
            disabled={busy}
            className="mt-3 w-full text-center text-xs font-semibold text-primary underline-offset-2 hover:underline"
          >
            Send a fresh code
          </button>
        </form>
      )}

      {phase === 'phone' && phoneStep && (
        <form className="mt-6" onSubmit={submitPhone} noValidate>
          <h2 className="font-serif text-lg font-bold tracking-[-.01em] text-navy">
            {phoneStep.mode === 'enroll' && !smsRequestId ? 'Add a sign-in phone' : 'Check your phone'}
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {phoneStep.mode === 'enroll' && !smsRequestId
              ? 'Your role requires a second check at sign-in. Add a mobile number to receive a code by text.'
              : `Enter the code we texted to ${phoneStep.destination ?? 'your mobile number'}.`}
          </p>
          {phoneStep.mode === 'enroll' && !smsRequestId ? (
            <div className="mt-4">
              <Label htmlFor="setup-phone">Mobile number</Label>
              <Input
                id="setup-phone"
                type="tel"
                autoComplete="tel"
                data-testid="input-setup-phone"
                className="mt-1.5"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                disabled={busy}
                autoFocus
              />
            </div>
          ) : (
            <div className="mt-4">
              <Label htmlFor="setup-sms-code" className="sr-only">6-digit texted code</Label>
              <Input
                id="setup-sms-code"
                data-testid="input-setup-sms-code"
                className="text-center text-lg font-semibold tracking-[.4em]"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                autoComplete="one-time-code"
                value={smsCode}
                onChange={(event) => setSmsCode(event.target.value.replace(/\D/g, ''))}
                disabled={busy}
                autoFocus
              />
            </div>
          )}
          <Button
            type="submit"
            data-testid={smsRequestId ? 'button-setup-sms-verify' : 'button-setup-phone-send'}
            className="mt-4 h-10 w-full"
            disabled={busy}
          >
            {busy ? 'Working…' : smsRequestId ? 'Verify and finish setup' : 'Text me a code'}
          </Button>
          {smsRequestId && (
            <div className="mt-3 flex items-center justify-center gap-4">
              <button
                type="button"
                data-testid="button-setup-sms-resend"
                onClick={() => void sendPhoneCode(phoneStep.mode === 'enroll' ? phone.trim() : undefined)}
                disabled={busy}
                className="text-xs font-semibold text-primary underline-offset-2 hover:underline"
              >
                Resend text
              </button>
              {phoneStep.mode === 'enroll' && (
                <button
                  type="button"
                  data-testid="button-setup-phone-change"
                  onClick={changePhoneNumber}
                  disabled={busy}
                  className="text-xs font-semibold text-muted-foreground underline-offset-2 hover:underline"
                >
                  Change number
                </button>
              )}
            </div>
          )}
        </form>
      )}
    </Frame>
  );
}
