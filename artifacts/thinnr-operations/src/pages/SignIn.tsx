/**
 * The front door — passwordless staff sign-in, with the demo chooser one
 * click away.
 *
 * Staff accounts are keyed on business email: enter the address, we email a
 * 6-digit code, the code becomes a real Supabase session. There is no
 * password anywhere, no signup form, and no forgot-password path — a wrong
 * or unknown address gets the same neutral "code is on its way" reply, so
 * the screen never confirms whether an account exists.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { INACTIVITY_SIGN_OUT_REASON_KEY } from '@/hooks/useIdleTimeout';
import { useLocation } from 'wouter';
import { ArrowRight, Building2, ChevronDown, Stethoscope, Utensils } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSession, type Persona } from '@/contexts/session';
import { timeOfDayGreeting } from '@/lib/local-time';

type Phase = 'email' | 'code';

const DEMO_OPTIONS: Array<{
  persona: Persona;
  icon: React.ReactNode;
  title: string;
  description: string;
  cta: string;
  testId: string;
}> = [
  {
    persona: 'hq-admin',
    icon: <Building2 size={18} />,
    title: 'THINNR HQ admin',
    description: 'The umbrella above every office: rollups, provider accounts, and org tools.',
    cta: 'Enter HQ admin',
    testId: 'button-signin-admin',
  },
  {
    persona: 'office',
    icon: <Stethoscope size={18} />,
    title: 'Office staff',
    description: 'Today’s operations desk for the med spa team, exactly as it runs day to day.',
    cta: 'Enter the office',
    testId: 'button-signin-office',
  },
];

export default function SignIn() {
  const { signIn, requestStaffCode, verifyStaffCode, supabaseEnabled } = useSession();
  const [, navigate] = useLocation();

  const [phase, setPhase] = useState<Phase>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDemo, setShowDemo] = useState(false);

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

  const chooseDemo = (persona: Persona) => {
    signIn(persona);
    navigate(persona === 'hq-admin' ? '/admin' : '/', { replace: true });
  };

  const sendCode = async (address: string) => {
    const result = await requestStaffCode(address);
    if (result.error || !result.requestId) {
      setError(result.error ?? 'Could not send a code right now. Try again in a moment.');
      return false;
    }
    setRequestId(result.requestId);
    setPendingEmail(address);
    setDevCode(result.devCode);
    setNotice(result.message ?? 'If that address has an account, a sign-in code is on its way.');
    return true;
  };

  const submitEmail = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !supabaseEnabled) return;
    setError(null);
    setNotice(null);
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes('@')) {
      setError('Enter your work email address.');
      return;
    }
    setBusy(true);
    try {
      if (await sendCode(trimmed)) {
        setOtp('');
        setPhase('code');
      }
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !requestId) return;
    setError(null);
    if (otp.trim().length < 6) {
      setError('Enter the 6-digit code from the email.');
      return;
    }
    setBusy(true);
    try {
      const result = await verifyStaffCode({ requestId, code: otp.trim() });
      if (result.error) setError(result.error);
      // Success: the session listener re-routes to the right workspace.
    } finally {
      setBusy(false);
    }
  };

  const resendCode = async () => {
    if (busy || !pendingEmail) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      setOtp('');
      await sendCode(pendingEmail);
    } finally {
      setBusy(false);
    }
  };

  const backToEmail = () => {
    setPhase('email');
    setOtp('');
    setRequestId(null);
    setDevCode(null);
    setError(null);
    setNotice(null);
  };

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
              Real sign-in isn’t configured in this environment — browse the demo below.
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
        </section>

        <div className="mt-5 border-t border-border pt-4 text-left">
          <button
            type="button"
            data-testid="button-explore-demo"
            onClick={() => setShowDemo((open) => !open)}
            aria-expanded={showDemo}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground transition hover:text-foreground"
          >
            Exploring? Browse the guided demo without an account
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={showDemo ? 'rotate-180 transition-transform' : 'transition-transform'}
            />
          </button>
        </div>

        {showDemo && (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {DEMO_OPTIONS.map((option) => (
              <section
                key={option.persona}
                className="flex flex-col rounded-lg border border-card-border bg-card p-4 shadow-soft"
              >
                <div className="flex items-center gap-2.5">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent text-primary" aria-hidden="true">
                    {option.icon}
                  </span>
                  <h2 className="font-serif text-base font-bold tracking-[-.01em] text-navy">{option.title}</h2>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{option.description}</p>
                <button
                  type="button"
                  data-testid={option.testId}
                  onClick={() => chooseDemo(option.persona)}
                  className="mt-4 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-4 text-xs font-semibold text-foreground transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {option.cta}
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
              </section>
            ))}
          </div>
        )}

        <p className="mt-6 text-left text-[11px] text-muted-foreground">
          Staff sign in with a one-time email code. Patients sign in with their cell phone in the
          THINNR mobile app.
        </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-sidebar px-5 py-2 text-center">
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Synthetic Demo Data • Not Medical Advice
        </p>
      </footer>
    </div>
  );
}
