/**
 * Claim your account — web twin of the mobile flow. Providers and office
 * staff from the migrated THINNR rolls enter the email (or mobile number)
 * the clinic has on file, prove it with a one-time code, and set a password;
 * they're signed straight in. Running it again for an already-claimed login
 * simply resets the password, so this page doubles as "forgot password".
 *
 * The page never confirms whether an identifier exists — every identify
 * answer looks identical. Until SMS/email delivery goes live the server runs
 * in dev mode and returns the code in the response; we show it inline.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft, CheckCircle2, Circle, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSession } from '@/contexts/session';
import { normalizePhone } from '@/lib/supabase';

type Phase = 'identify' | 'code' | 'birthday' | 'password' | 'manual-signin';

interface ClaimResponse {
  status: number;
  json: Record<string, unknown> | null;
}

async function claimApi(path: string, body: unknown): Promise<ClaimResponse> {
  const response = await fetch(`/api/claim/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

function errorFrom(result: ClaimResponse, fallback: string): string {
  const message = typeof result.json?.error === 'string' ? (result.json.error as string) : '';
  if (message) return message;
  if (result.status === 429) return 'Too many attempts — give it a minute, then try again.';
  if (result.status >= 500) return 'Something went wrong on our side. Try again in a moment.';
  return fallback;
}

/** MM/DD/YYYY as-you-type mask. */
function formatBirthdayInput(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

function birthdayToIso(value: string): string | null {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, mm, dd, yyyy] = match;
  const iso = `${yyyy}-${mm}-${dd}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCMonth() + 1 !== Number(mm) || date.getUTCDate() !== Number(dd)) return null;
  return iso;
}

const PASSWORD_RULES = [
  { key: 'length', label: 'At least 8 characters', test: (p: string) => p.length >= 8 },
  { key: 'upper', label: 'An uppercase letter', test: (p: string) => /[A-Z]/.test(p) },
  { key: 'lower', label: 'A lowercase letter', test: (p: string) => /[a-z]/.test(p) },
  { key: 'symbol', label: 'A symbol (like ! or #)', test: (p: string) => /[^A-Za-z0-9]/.test(p) },
] as const;

export default function ClaimAccount() {
  const { signInWithPassword, supabaseEnabled } = useSession();
  const [, navigate] = useLocation();

  const [phase, setPhase] = useState<Phase>('identify');
  const [identifier, setIdentifier] = useState('');
  const [sentIdentifier, setSentIdentifier] = useState('');
  const [requestId, setRequestId] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [claimToken, setClaimToken] = useState('');
  const [masked, setMasked] = useState<string | null>(null);
  const [claimMode, setClaimMode] = useState<'create' | 'reset' | null>(null);
  const [birthday, setBirthday] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [signInMethod, setSignInMethod] = useState<'email' | 'phone' | null>(null);
  const [signInIdentifier, setSignInIdentifier] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dead, setDead] = useState(false); // clinic dead-end — only a restart helps

  const passwordChecks = useMemo(
    () => PASSWORD_RULES.map((rule) => ({ ...rule, met: rule.test(password) })),
    [password],
  );
  const passwordReady = passwordChecks.every((rule) => rule.met) && password.length <= 72;
  const confirmMatches = passwordConfirm.length > 0 && passwordConfirm === password;

  const resetFlow = () => {
    setPhase('identify');
    setRequestId('');
    setDevCode(null);
    setCode('');
    setClaimToken('');
    setMasked(null);
    setClaimMode(null);
    setBirthday('');
    setPassword('');
    setPasswordConfirm('');
    setError(null);
    setNotice(null);
    setDead(false);
  };

  const startIdentify = async (event: FormEvent | null, silentResend = false) => {
    event?.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    const raw = (silentResend ? sentIdentifier : identifier).trim();
    let payload = raw;
    if (!raw) {
      setError('Enter the email or mobile number your clinic has on file.');
      return;
    }
    if (!raw.includes('@')) {
      const normalized = normalizePhone(raw);
      if (!normalized || normalized.replace(/\D/g, '').length < 8) {
        setError('That doesn’t look like an email or a mobile number. Check it and try again.');
        return;
      }
      payload = normalized;
    }
    setBusy(true);
    try {
      const result = await claimApi('identify', { identifier: payload });
      if (result.status !== 200 || typeof result.json?.requestId !== 'string') {
        setError(errorFrom(result, 'We couldn’t start verification. Try again.'));
        return;
      }
      setSentIdentifier(payload);
      setRequestId(result.json.requestId as string);
      setDevCode(typeof result.json.devCode === 'string' ? (result.json.devCode as string) : null);
      setCode('');
      if (silentResend) setNotice('We sent a fresh code.');
      else setPhase('code');
    } catch {
      setError('Couldn’t reach THINNR. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    if (code.trim().length !== 6) {
      setError('Enter the 6-digit code.');
      return;
    }
    setBusy(true);
    try {
      const result = await claimApi('verify', { requestId, code: code.trim() });
      if (result.status === 409) {
        setDead(true);
        setError(errorFrom(result, 'We couldn’t verify your account automatically.'));
        return;
      }
      if (result.status !== 200 || typeof result.json?.claimToken !== 'string') {
        setError(errorFrom(result, 'That code didn’t match. Check it and try again.'));
        return;
      }
      setClaimToken(result.json.claimToken as string);
      setMasked(typeof result.json.masked === 'string' ? (result.json.masked as string) : null);
      if (result.json.next === 'birthday') {
        setPhase('birthday');
      } else {
        setClaimMode(result.json.mode === 'reset' ? 'reset' : 'create');
        setPhase('password');
      }
    } catch {
      setError('Couldn’t reach THINNR. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitBirthday = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const iso = birthdayToIso(birthday);
    if (!iso) {
      setError('Enter your date of birth as MM/DD/YYYY.');
      return;
    }
    setBusy(true);
    try {
      const result = await claimApi('birthday', { claimToken, birthday: iso });
      if (result.status === 409) {
        setDead(true);
        setError(errorFrom(result, 'We couldn’t verify your account automatically.'));
        return;
      }
      if (result.status !== 200) {
        setError(errorFrom(result, 'That didn’t work. Start over and try again.'));
        return;
      }
      setClaimMode(result.json?.mode === 'reset' ? 'reset' : 'create');
      setPhase('password');
    } catch {
      setError('Couldn’t reach THINNR. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (!passwordReady) {
      setError('Your password needs everything on the checklist.');
      return;
    }
    if (!confirmMatches) {
      setError('Both password boxes need to match.');
      return;
    }
    setBusy(true);
    try {
      const result = await claimApi('complete', { claimToken, password, passwordConfirm });
      if (result.status !== 200) {
        setError(errorFrom(result, 'We couldn’t finish setting up. Try again.'));
        return;
      }
      const signIn = result.json?.signIn as { method?: string; identifier?: string } | undefined;
      if (!signIn?.method || !signIn.identifier) {
        setPhase('manual-signin');
        return;
      }
      const credentials =
        signIn.method === 'phone'
          ? { phone: signIn.identifier, password }
          : { email: signIn.identifier, password };
      const { error: signInError } = await signInWithPassword(credentials);
      if (signInError) {
        setSignInMethod(signIn.method === 'phone' ? 'phone' : 'email');
        setSignInIdentifier(signIn.identifier);
        setPhase('manual-signin');
        return;
      }
      // Signed in — the session router takes over from the workspace root.
      navigate('/', { replace: true });
    } catch {
      setError('Couldn’t reach THINNR. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const errorBox = error && (
    <p
      role="alert"
      data-testid="text-claim-error"
      className="rounded-md border border-destructive-border bg-destructive/10 px-3 py-2 text-xs font-medium leading-relaxed text-destructive"
    >
      {error}
    </p>
  );

  const devCodeBox = devCode && phase === 'code' && (
    <p
      data-testid="text-claim-dev-code"
      className="flex items-start gap-2 rounded-md border border-border bg-accent px-3 py-2 text-xs font-medium leading-relaxed text-foreground"
    >
      <Wrench size={14} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
      <span>Test mode — delivery isn’t switched on yet, so your code is {devCode}.</span>
    </p>
  );

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background font-sans text-foreground">
      <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col justify-center px-5 py-10">
        <header className="mb-8 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-md bg-navy text-brand-foreground shadow-soft">
            <span className="text-sm font-bold tracking-[.04em]">TH</span>
          </span>
          <h1 className="mt-4 font-serif text-[30px] font-bold leading-tight tracking-[-.02em] text-navy">
            {phase === 'identify'
              ? 'Claim your account'
              : phase === 'code'
                ? 'Enter your code'
                : phase === 'birthday'
                  ? 'One more check'
                  : phase === 'password'
                    ? claimMode === 'reset'
                      ? 'Set a new password'
                      : 'Create your password'
                    : 'Password saved'}
          </h1>
          {phase === 'identify' && (
            <p className="mx-auto mt-2 max-w-[48ch] text-sm leading-relaxed text-muted-foreground">
              Providers and office staff on the THINNR program: verify the contact your clinic has
              on file and set your password. This is also how you reset a forgotten one.
            </p>
          )}
        </header>

        <section className="mx-auto w-full max-w-[430px] rounded-lg border border-card-border bg-card p-6 shadow-soft">
          {!supabaseEnabled && (
            <p
              role="alert"
              className="mb-4 rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-xs font-medium leading-relaxed text-warn"
            >
              Real sign-in isn’t configured in this environment — browse the demo from the sign-in
              page instead.
            </p>
          )}

          {phase === 'identify' && (
            <form onSubmit={(event) => void startIdentify(event)} noValidate>
              <div className="space-y-4">
                <div>
                  <Label htmlFor="claim-identifier" className="text-xs font-semibold text-navy">
                    Email or mobile number
                  </Label>
                  <Input
                    id="claim-identifier"
                    data-testid="input-claim-identifier"
                    className="mt-1.5"
                    autoComplete="username"
                    placeholder="you@yourclinic.com or +1 555 123 4567"
                    value={identifier}
                    onChange={(event) => setIdentifier(event.target.value)}
                    disabled={busy || !supabaseEnabled}
                    autoFocus
                  />
                </div>
                {errorBox}
                <Button
                  type="submit"
                  data-testid="button-claim-identify"
                  className="h-10 w-full"
                  disabled={busy || !supabaseEnabled}
                >
                  {busy ? 'Sending…' : 'Send my code'}
                </Button>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  For your privacy we never confirm whether an email or number is on file. Codes
                  expire after ten minutes.
                </p>
              </div>
            </form>
          )}

          {phase === 'code' && (
            <form onSubmit={(event) => void submitCode(event)} noValidate>
              <p className="text-xs leading-relaxed text-muted-foreground">
                If those details match an account, a 6-digit code is on its way to{' '}
                <span className="font-semibold text-foreground">{sentIdentifier}</span>.
              </p>
              <div className="mt-4 space-y-4">
                {devCodeBox}
                <div>
                  <Label htmlFor="claim-code" className="sr-only">
                    6-digit verification code
                  </Label>
                  <Input
                    id="claim-code"
                    data-testid="input-claim-code"
                    className="text-center text-lg font-semibold tracking-[.4em]"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                    disabled={busy || dead}
                    autoFocus
                  />
                </div>
                {errorBox}
                {notice && (
                  <p
                    data-testid="text-claim-notice"
                    className="rounded-md border border-border bg-accent px-3 py-2 text-xs font-medium leading-relaxed text-foreground"
                  >
                    {notice}
                  </p>
                )}
                {dead ? (
                  <Button
                    type="button"
                    data-testid="button-claim-start-over"
                    variant="outline"
                    className="h-10 w-full"
                    onClick={resetFlow}
                  >
                    Start over
                  </Button>
                ) : (
                  <>
                    <Button
                      type="submit"
                      data-testid="button-claim-verify"
                      className="h-10 w-full"
                      disabled={busy}
                    >
                      {busy ? 'Checking…' : 'Verify code'}
                    </Button>
                    <div className="flex items-center justify-center gap-4">
                      <button
                        type="button"
                        data-testid="button-claim-resend"
                        onClick={() => void startIdentify(null, true)}
                        disabled={busy}
                        className="text-xs font-semibold text-primary underline-offset-2 hover:underline"
                      >
                        Resend code
                      </button>
                      <button
                        type="button"
                        data-testid="button-claim-restart"
                        onClick={resetFlow}
                        className="text-xs font-semibold text-muted-foreground underline-offset-2 hover:underline"
                      >
                        Different email or number
                      </button>
                    </div>
                  </>
                )}
              </div>
            </form>
          )}

          {phase === 'birthday' && (
            <form onSubmit={(event) => void submitBirthday(event)} noValidate>
              <p className="text-xs leading-relaxed text-muted-foreground">
                That number is shared by more than one THINNR account, so we need your date of
                birth to find yours. You get one try — if it doesn’t match, your clinic can set you
                up instead.
              </p>
              <div className="mt-4 space-y-4">
                <div>
                  <Label htmlFor="claim-birthday" className="text-xs font-semibold text-navy">
                    Date of birth (MM/DD/YYYY)
                  </Label>
                  <Input
                    id="claim-birthday"
                    data-testid="input-claim-birthday"
                    className="mt-1.5"
                    inputMode="numeric"
                    placeholder="04/23/1975"
                    maxLength={10}
                    value={birthday}
                    onChange={(event) => setBirthday(formatBirthdayInput(event.target.value))}
                    disabled={busy || dead}
                    autoFocus
                  />
                </div>
                {errorBox}
                {dead ? (
                  <Button
                    type="button"
                    data-testid="button-claim-back-signin"
                    variant="outline"
                    className="h-10 w-full"
                    onClick={() => navigate('/', { replace: true })}
                  >
                    Back to sign in
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    data-testid="button-claim-birthday"
                    className="h-10 w-full"
                    disabled={busy}
                  >
                    {busy ? 'Checking…' : 'Continue'}
                  </Button>
                )}
              </div>
            </form>
          )}

          {phase === 'password' && (
            <form onSubmit={(event) => void submitPassword(event)} noValidate>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {claimMode === 'reset'
                  ? `Pick a new password for ${masked ?? 'your account'}.`
                  : `Almost done — pick a password for ${masked ?? 'your account'}.`}
              </p>
              <div className="mt-4 space-y-4">
                <div>
                  <Label htmlFor="claim-password" className="text-xs font-semibold text-navy">
                    {claimMode === 'reset' ? 'New password' : 'Password'}
                  </Label>
                  <Input
                    id="claim-password"
                    data-testid="input-claim-password"
                    className="mt-1.5"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={busy}
                    autoFocus
                  />
                </div>
                <div>
                  <Label htmlFor="claim-password-confirm" className="text-xs font-semibold text-navy">
                    {claimMode === 'reset' ? 'Confirm new password' : 'Confirm password'}
                  </Label>
                  <Input
                    id="claim-password-confirm"
                    data-testid="input-claim-password-confirm"
                    className="mt-1.5"
                    type="password"
                    autoComplete="new-password"
                    value={passwordConfirm}
                    onChange={(event) => setPasswordConfirm(event.target.value)}
                    disabled={busy}
                  />
                  {passwordConfirm.length > 0 && !confirmMatches && (
                    <p className="mt-1.5 text-xs text-muted-foreground" data-testid="text-confirm-mismatch">
                      These don’t match yet.
                    </p>
                  )}
                </div>
                <ul className="space-y-1.5" aria-label="Password requirements">
                  {passwordChecks.map((rule) => (
                    <li
                      key={rule.key}
                      data-testid={`rule-${rule.key}`}
                      className="flex items-center gap-2 text-xs"
                    >
                      {rule.met ? (
                        <CheckCircle2 size={14} className="text-active" aria-hidden="true" />
                      ) : (
                        <Circle size={14} className="text-muted-foreground" aria-hidden="true" />
                      )}
                      <span className={rule.met ? 'font-medium text-foreground' : 'text-muted-foreground'}>
                        {rule.label}
                      </span>
                    </li>
                  ))}
                </ul>
                {errorBox}
                <Button
                  type="submit"
                  data-testid="button-claim-complete"
                  className="h-10 w-full"
                  disabled={busy || !passwordReady || !confirmMatches}
                >
                  {busy ? 'Setting up…' : claimMode === 'reset' ? 'Save and sign in' : 'Finish and sign in'}
                </Button>
              </div>
            </form>
          )}

          {phase === 'manual-signin' && (
            <div className="text-center" data-testid="panel-claim-manual">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Your password is saved{signInIdentifier ? ` for ${signInIdentifier}` : ''}
                {signInMethod === 'phone' ? ' (sign in with your phone number)' : ''}. Head back to
                the sign-in page and use it there.
              </p>
              <Button
                type="button"
                data-testid="button-claim-to-signin"
                className="mt-5 h-10 w-full"
                onClick={() => navigate('/', { replace: true })}
              >
                Go to sign in
              </Button>
            </div>
          )}
        </section>

        <div className="mt-6 text-center">
          <button
            type="button"
            data-testid="button-claim-back"
            onClick={() => navigate('/', { replace: true })}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground transition hover:text-foreground"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Back to sign in
          </button>
        </div>

        <p className="mt-6 text-center text-[11px] text-muted-foreground">
          Need help? Contact your clinic and they’ll get you set up.
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
