/**
 * The front door — real Supabase sign-in, with the demo chooser one click away.
 *
 * Email + password works today; phone + password is fully wired and lights up
 * the moment Twilio Verify is connected in the Supabase dashboard (until then
 * the server declines and we explain that in plain words). Accounts on the
 * pre-approved list land as HQ admin or provider staff; everyone else becomes
 * a patient and is pointed at the mobile app.
 */
import { useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { ArrowRight, Building2, ChevronDown, MailCheck, Stethoscope } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSession, type Persona } from '@/contexts/session';
import { normalizePhone } from '@/lib/supabase';

type AuthMethod = 'email' | 'phone';
type AuthMode = 'sign-in' | 'sign-up';
type Phase = 'credentials' | 'verify-phone' | 'check-email';

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
  const {
    signIn,
    signInWithPassword,
    signUpWithPassword,
    verifyPhoneCode,
    resendPhoneCode,
    supabaseEnabled,
  } = useSession();
  const [, navigate] = useLocation();

  const [method, setMethod] = useState<AuthMethod>('email');
  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [phase, setPhase] = useState<Phase>('credentials');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [pendingPhone, setPendingPhone] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDemo, setShowDemo] = useState(false);

  const chooseDemo = (persona: Persona) => {
    signIn(persona);
    navigate(persona === 'hq-admin' ? '/admin' : '/', { replace: true });
  };

  const switchMethod = (next: AuthMethod) => {
    setMethod(next);
    setError(null);
    setNotice(null);
  };

  const submitCredentials = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !supabaseEnabled) return;
    setError(null);
    setNotice(null);

    let identifier: { email: string } | { phone: string };
    if (method === 'email') {
      const trimmed = email.trim();
      if (!trimmed) {
        setError('Enter your email.');
        return;
      }
      identifier = { email: trimmed };
    } else {
      const normalized = normalizePhone(phone);
      if (!normalized) {
        setError('Enter your mobile number, including the country code.');
        return;
      }
      identifier = { phone: normalized };
    }
    if (!password) {
      setError('Enter your password.');
      return;
    }
    if (mode === 'sign-up' && password.length < 6) {
      setError('Passwords need at least 6 characters.');
      return;
    }

    setBusy(true);
    try {
      if (mode === 'sign-in') {
        const result = await signInWithPassword({ ...identifier, password });
        if (result.error) setError(result.error);
        // Success: the session listener re-routes to the right workspace.
      } else {
        const result = await signUpWithPassword({
          ...identifier,
          password,
          displayName: displayName.trim(),
        });
        if (result.error) {
          setError(result.error);
        } else if (result.outcome === 'confirm-email') {
          setPendingEmail('email' in identifier ? identifier.email : '');
          setPhase('check-email');
        } else if (result.outcome === 'verify-phone') {
          setPendingPhone('phone' in identifier ? identifier.phone : '');
          setOtp('');
          setPhase('verify-phone');
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const submitOtp = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    if (otp.trim().length < 6) {
      setError('Enter the 6-digit code from the text message.');
      return;
    }
    setBusy(true);
    try {
      const result = await verifyPhoneCode({ phone: pendingPhone, token: otp.trim() });
      if (result.error) setError(result.error);
      // Success: verified codes sign the account in automatically.
    } finally {
      setBusy(false);
    }
  };

  const resendCode = async () => {
    if (busy) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await resendPhoneCode({ phone: pendingPhone });
      if (result.error) setError(result.error);
      else setNotice('We sent a fresh code.');
    } finally {
      setBusy(false);
    }
  };

  const backToCredentials = () => {
    setPhase('credentials');
    setOtp('');
    setError(null);
    setNotice(null);
  };

  const methodButton = (value: AuthMethod, label: string, testId: string) => {
    const active = method === value;
    return (
      <button
        type="button"
        aria-pressed={active}
        data-testid={testId}
        onClick={() => switchMethod(value)}
        className={
          active
            ? 'h-8 rounded-[5px] bg-navy text-xs font-semibold text-brand-foreground shadow-xs transition'
            : 'h-8 rounded-[5px] text-xs font-semibold text-muted-foreground transition hover:text-foreground'
        }
      >
        {label}
      </button>
    );
  };

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background font-sans text-foreground">
      <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center px-5 py-10">
        <header className="mb-8 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-md bg-navy text-brand-foreground shadow-soft">
            <span className="text-sm font-bold tracking-[.04em]">TH</span>
          </span>
          <h1 className="mt-4 font-serif text-[34px] font-bold leading-tight tracking-[-.02em] text-navy">
            THINNR Operations
          </h1>
          <p className="mx-auto mt-2 max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
            Sign in to your workspace. HQ admins land on the umbrella overview; office teams land on
            today’s desk.
          </p>
        </header>

        <section className="mx-auto w-full max-w-[430px] rounded-lg border border-card-border bg-card p-6 shadow-soft">
          {!supabaseEnabled && (
            <p
              role="alert"
              className="mb-4 rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-xs font-medium leading-relaxed text-warn"
            >
              Real sign-in isn’t configured in this environment — browse the demo below.
            </p>
          )}

          {phase === 'credentials' && (
            <form onSubmit={submitCredentials} noValidate>
              <div
                role="group"
                aria-label="Sign-in method"
                className="grid grid-cols-2 gap-1 rounded-md border border-border bg-background p-1"
              >
                {methodButton('email', 'Email', 'tab-auth-email')}
                {methodButton('phone', 'Phone', 'tab-auth-phone')}
              </div>

              <div className="mt-5 space-y-4">
                {mode === 'sign-up' && (
                  <div>
                    <Label htmlFor="auth-name" className="text-xs font-semibold text-navy">
                      Name <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    <Input
                      id="auth-name"
                      data-testid="input-auth-name"
                      className="mt-1.5"
                      autoComplete="name"
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      disabled={busy || !supabaseEnabled}
                    />
                  </div>
                )}

                {method === 'email' ? (
                  <div>
                    <Label htmlFor="auth-email" className="text-xs font-semibold text-navy">
                      Email
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
                  </div>
                ) : (
                  <div>
                    <Label htmlFor="auth-phone" className="text-xs font-semibold text-navy">
                      Mobile number
                    </Label>
                    <Input
                      id="auth-phone"
                      data-testid="input-auth-phone"
                      className="mt-1.5"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      placeholder="+1 555 123 4567"
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                      disabled={busy || !supabaseEnabled}
                      autoFocus
                    />
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      Include the country code — ten digits are treated as US.
                      {mode === 'sign-up' && ' We’ll text you a 6-digit code.'}
                    </p>
                  </div>
                )}

                <div>
                  <Label htmlFor="auth-password" className="text-xs font-semibold text-navy">
                    Password
                  </Label>
                  <Input
                    id="auth-password"
                    data-testid="input-auth-password"
                    className="mt-1.5"
                    type="password"
                    autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={busy || !supabaseEnabled}
                  />
                  {mode === 'sign-up' && (
                    <p className="mt-1.5 text-[11px] text-muted-foreground">At least 6 characters.</p>
                  )}
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
                  {busy
                    ? mode === 'sign-in'
                      ? 'Signing in…'
                      : 'Creating account…'
                    : mode === 'sign-in'
                      ? 'Sign in'
                      : 'Create account'}
                </Button>

                <p className="text-center">
                  <button
                    type="button"
                    data-testid="button-toggle-mode"
                    onClick={() => {
                      setMode((current) => (current === 'sign-in' ? 'sign-up' : 'sign-in'));
                      setError(null);
                      setNotice(null);
                    }}
                    className="text-xs font-semibold text-primary underline-offset-2 hover:underline"
                  >
                    {mode === 'sign-in'
                      ? 'New here? Create an account'
                      : 'Already have an account? Sign in'}
                  </button>
                </p>
              </div>
            </form>
          )}

          {phase === 'verify-phone' && (
            <form onSubmit={submitOtp} noValidate>
              <h2 className="font-serif text-lg font-bold tracking-[-.01em] text-navy">
                Enter the code we texted
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                A 6-digit code is on its way to {pendingPhone}.
              </p>
              <div className="mt-4">
                <Label htmlFor="auth-otp" className="sr-only">
                  6-digit verification code
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

              {error && (
                <p
                  role="alert"
                  data-testid="text-auth-error"
                  className="mt-4 rounded-md border border-destructive-border bg-destructive/10 px-3 py-2 text-xs font-medium leading-relaxed text-destructive"
                >
                  {error}
                </p>
              )}
              {notice && (
                <p
                  data-testid="text-auth-notice"
                  className="mt-4 rounded-md border border-border bg-accent px-3 py-2 text-xs font-medium leading-relaxed text-foreground"
                >
                  {notice}
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
                  Resend code
                </button>
                <button
                  type="button"
                  data-testid="button-auth-back"
                  onClick={backToCredentials}
                  className="text-xs font-semibold text-muted-foreground underline-offset-2 hover:underline"
                >
                  Back
                </button>
              </div>
            </form>
          )}

          {phase === 'check-email' && (
            <div className="text-center" data-testid="panel-check-email">
              <span className="mx-auto grid h-10 w-10 place-items-center rounded-md bg-accent text-primary" aria-hidden="true">
                <MailCheck size={20} />
              </span>
              <h2 className="mt-4 font-serif text-lg font-bold tracking-[-.01em] text-navy">
                Confirm your email
              </h2>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                We sent a confirmation link to <span className="font-semibold text-foreground">{pendingEmail}</span>.
                Open it, then come back here and sign in. The demo mailer can take a few minutes.
              </p>
              <Button
                type="button"
                data-testid="button-auth-back"
                variant="outline"
                className="mt-5 h-10 w-full"
                onClick={() => {
                  backToCredentials();
                  setMode('sign-in');
                }}
              >
                Back to sign in
              </Button>
            </div>
          )}
        </section>

        <div className="mt-6 text-center">
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

        <p className="mt-6 text-center text-[11px] text-muted-foreground">
          New accounts start as patients unless they’re on the pre-approved staff list. Patients use
          the THINNR mobile app.
        </p>
      </main>

      <footer className="border-t border-border bg-sidebar px-5 py-2 text-center">
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Synthetic Demo Data • Not Medical Advice
        </p>
      </footer>
    </div>
  );
}
