/**
 * The front door — passwordless staff sign-in.
 *
 * Staff accounts are keyed on business email: enter the address, we email a
 * 6-digit code, the code becomes a real Supabase session. There is no
 * password anywhere, no signup form, and no forgot-password path — a wrong
 * or unknown address gets the same neutral "code is on its way" reply, so
 * the screen never confirms whether an account exists.
 */
import { useEffect } from 'react';
import { INACTIVITY_SIGN_OUT_REASON_KEY } from '@/hooks/useIdleTimeout';
import { Utensils } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useStaffPasswordlessSignIn } from '@/hooks/useStaffPasswordlessSignIn';
import { timeOfDayGreeting } from '@/lib/local-time';

export default function SignIn() {
  const {
    phase, email, setEmail, otp, setOtp, phone, setPhone, smsCode, setSmsCode,
    smsRequestId, phoneStep, pendingEmail, devCode, error, notice, setNotice, busy,
    submitEmail, submitCode, submitPhone, resendCode, sendPhoneCode,
    changePhoneNumber, backToEmail, supabaseEnabled,
  } = useStaffPasswordlessSignIn();

  useEffect(() => {
    try {
      const reason = window.sessionStorage.getItem(INACTIVITY_SIGN_OUT_REASON_KEY);
      window.sessionStorage.removeItem(INACTIVITY_SIGN_OUT_REASON_KEY);
      if (reason === 'inactivity') {
        setNotice('You were signed out after a period of inactivity. Sign in again to continue.');
      }
    } catch {
      // Storage is best-effort; sign-in remains available.
    }
  }, []);

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background font-sans text-foreground">
      <header className="mx-auto flex w-full max-w-[1060px] items-center justify-between px-8 pt-7">
        <span className="font-serif text-[26px] text-navy">THINNR</span>
        <span className="text-xs font-semibold text-muted-foreground">Need access? Ask your office admin</span>
      </header>
      <main className="mx-auto flex w-full max-w-[1060px] flex-1 items-center px-5 py-8">
        <section className="grid w-full overflow-hidden rounded-lg border border-card-border bg-card shadow-lifted lg:min-h-[540px] lg:grid-cols-2">
          <div className="relative hidden overflow-hidden lg:block">
            <img
              src="/home-hero.jpg"
              alt="Grilled chicken bowl with greens"
              className="absolute inset-0 h-full w-full object-cover object-center"
            />
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(245,247,249,.15)_0%,rgba(245,247,249,0)_35%,rgba(253,252,249,.92)_100%)]" />
            <div className="absolute inset-x-0 bottom-0 p-7">
              <span className="inline-flex items-center gap-1.5 rounded-sm border border-warn-border bg-warn-bg px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-warn">
                <Utensils size={11} aria-hidden="true" />
                Approved list
              </span>
              <p className="mt-2 font-serif text-[24px] leading-tight text-navy">
                {timeOfDayGreeting()} — grilled chicken, greens, and a plate off the approved list.
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                From the restaurant guide your patients see on the Today tab.
              </p>
            </div>
          </div>
          <div className="flex flex-col justify-center p-6 sm:p-10">
        <header className="mb-6 text-left">
          <span className="grid h-11 w-11 place-items-center rounded-md bg-navy text-brand-foreground shadow-soft">
            <span className="text-sm font-bold tracking-[.04em]">TH</span>
          </span>
          <p className="mt-6 text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">Staff sign-in</p>
          <h1 className="mt-2 font-serif text-[32px] font-bold leading-tight tracking-[-.02em] text-navy">
            THINNR Operations
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Sign in with your work email — we’ll send a one-time code.
          </p>
        </header>

        <section className="w-full">
          {!supabaseEnabled && (
            <p
              role="alert"
              className="mb-4 rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-xs font-medium leading-relaxed text-warn"
            >
              Sign-in isn’t available right now. Please try again later.
            </p>
          )}

          {notice && !error && (
            <p
              role="status"
              data-testid="text-auth-notice"
              className="mb-4 rounded-md border border-border bg-accent px-3 py-2 text-xs font-medium leading-relaxed text-foreground"
            >
              {notice}
            </p>
          )}

          {phase === 'email' && (
            <form onSubmit={submitEmail} noValidate>
              <div className="space-y-4">
                <div>
                  <Label htmlFor="auth-email" className="text-xs font-semibold text-navy">
                    Work email
                  </Label>
                  <Input
                    id="auth-email"
                    data-testid="input-auth-email"
                    className="mt-1.5"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    placeholder="you@yourclinic.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={busy || !supabaseEnabled}
                    autoFocus
                  />
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    We’ll email you a 6-digit sign-in code. No password needed.
                  </p>
                </div>

                {error && (
                  <p
                    role="alert"
                    data-testid="text-auth-error"
                    className="rounded-md border border-destructive-border bg-destructive/10 px-3 py-2 text-xs font-medium leading-relaxed text-destructive"
                  >
                    {error}
                  </p>
                )}

                <Button
                  type="submit"
                  data-testid="button-auth-submit"
                  className="h-10 w-full"
                  disabled={busy || !supabaseEnabled}
                >
                  {busy ? 'Sending code…' : 'Email me a code'}
                </Button>
              </div>
            </form>
          )}

          {phase === 'code' && (
            <form onSubmit={submitCode} noValidate>
              <h2 className="font-serif text-lg font-bold tracking-[-.01em] text-navy">
                Enter the code we emailed
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                If <span className="font-semibold text-foreground">{pendingEmail}</span> has an
                account, a 6-digit code is on its way. It expires in 10 minutes.
              </p>
              <div className="mt-4">
                <Label htmlFor="auth-otp" className="sr-only">
                  6-digit sign-in code
                </Label>
                <Input
                  id="auth-otp"
                  data-testid="input-auth-otp"
                  className="text-center text-lg font-semibold tracking-[.4em]"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  autoComplete="one-time-code"
                  value={otp}
                  onChange={(event) => setOtp(event.target.value.replace(/\D/g, ''))}
                  disabled={busy}
                  autoFocus
                />
              </div>

              {devCode && (
                <p
                  data-testid="text-auth-devcode"
                  className="mt-4 rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-xs font-medium leading-relaxed text-warn"
                >
                  Dev delivery mode — your code is {devCode}.
                </p>
              )}
              {error && (
                <p
                  role="alert"
                  data-testid="text-auth-error"
                  className="mt-4 rounded-md border border-destructive-border bg-destructive/10 px-3 py-2 text-xs font-medium leading-relaxed text-destructive"
                >
                  {error}
                </p>
              )}
              <Button type="submit" data-testid="button-auth-verify" className="mt-4 h-10 w-full" disabled={busy}>
                {busy ? 'Verifying…' : 'Verify and sign in'}
              </Button>
              <div className="mt-3 flex items-center justify-center gap-4">
                <button
                  type="button"
                  data-testid="button-auth-resend"
                  onClick={resendCode}
                  disabled={busy}
                  className="text-xs font-semibold text-primary underline-offset-2 hover:underline"
                >
                  Send a fresh code
                </button>
                <button
                  type="button"
                  data-testid="button-auth-back"
                  onClick={backToEmail}
                  className="text-xs font-semibold text-muted-foreground underline-offset-2 hover:underline"
                >
                  Use a different email
                </button>
              </div>
            </form>
          )}

          {phase === 'phone' && phoneStep && (
            <form onSubmit={submitPhone} noValidate>
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
                  <Label htmlFor="staff-phone">Mobile number</Label>
                  <Input
                    id="staff-phone"
                    type="tel"
                    autoComplete="tel-national"
                    placeholder="(555) 000-0000"
                    maxLength={14}
                    data-testid="input-staff-phone"
                    className="mt-1.5"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    disabled={busy}
                    autoFocus
                  />
                </div>
              ) : (
                <div className="mt-4">
                  <Label htmlFor="staff-sms-code" className="sr-only">6-digit texted code</Label>
                  <Input
                    id="staff-sms-code"
                    data-testid="input-staff-sms-code"
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

              {devCode && (
                <p data-testid="text-auth-devcode" className="mt-4 rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-xs font-medium leading-relaxed text-warn">
                  Dev delivery mode — your code is {devCode}.
                </p>
              )}
              {error && (
                <p role="alert" data-testid="text-auth-error" className="mt-4 rounded-md border border-destructive-border bg-destructive/10 px-3 py-2 text-xs font-medium leading-relaxed text-destructive">
                  {error}
                </p>
              )}

              <Button
                type="submit"
                data-testid={smsRequestId ? 'button-staff-sms-verify' : 'button-staff-phone-send'}
                className="mt-4 h-10 w-full"
                disabled={busy}
              >
                {busy ? 'Working…' : smsRequestId ? 'Verify and sign in' : 'Text me a code'}
              </Button>
              {smsRequestId && (
                <div className="mt-3 flex items-center justify-center gap-4">
                  <button
                    type="button"
                    data-testid="button-staff-sms-resend"
                    onClick={() => void sendPhoneCode(phoneStep.mode === 'enroll' ? phone.trim() : undefined)}
                    disabled={busy}
                    className="text-xs font-semibold text-primary underline-offset-2 hover:underline"
                  >
                    Resend text
                  </button>
                  {phoneStep.mode === 'enroll' && (
                    <button
                      type="button"
                      data-testid="button-staff-phone-change"
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
        </section>

        <p className="mt-6 text-left text-[11px] text-muted-foreground">
          Staff sign in with a one-time email code. Patients sign in with their cell phone in the
          THINNR mobile app.
        </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-sidebar px-5 py-2 text-center">
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Not Medical Advice
        </p>
      </footer>
    </div>
  );
}
