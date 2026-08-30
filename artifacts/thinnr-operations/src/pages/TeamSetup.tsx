import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, Circle } from 'lucide-react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  completeHqSetup,
  inspectHqSetup,
  meetsHqPasswordPolicy,
  type HqSetupFailure,
  type HqSetupInvitation,
} from '@/lib/hq-setup';

const PASSWORD_RULES = [
  { label: 'At least 8 characters', matches: (value: string) => value.length >= 8 },
  { label: 'An uppercase letter', matches: (value: string) => /[A-Z]/.test(value) },
  { label: 'A lowercase letter', matches: (value: string) => /[a-z]/.test(value) },
  { label: 'A symbol (like ! or #)', matches: (value: string) => /[^A-Za-z0-9]/.test(value) },
] as const;

const failureCopy: Record<Exclude<HqSetupFailure, 'error'>, { title: string; body: string }> = {
  invalid: { title: 'This setup link is invalid or expired.', body: 'Use the exact link from your THINNR HQ invitation, or ask an administrator for help.' },
  expired: { title: 'This setup link has expired.', body: 'Ask a THINNR HQ administrator to send a new invitation.' },
  used: { title: 'This setup link has already been used.', body: 'Your account may already be ready. Return to sign in, or ask an administrator for help.' },
};

export default function TeamSetup() {
  const [, navigate] = useLocation();
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token')?.trim() ?? '');
  const [invitation, setInvitation] = useState<HqSetupInvitation | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'complete' | HqSetupFailure>(token ? 'loading' : 'invalid');
  const [message, setMessage] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');

  // Keep the one-time secret only in component memory after the initial read;
  // this removes it from the address bar and browser history immediately.
  useEffect(() => {
    if (token) navigate('/team/setup', { replace: true });
  }, [navigate, token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void inspectHqSetup(token).then(
      (next) => {
        if (cancelled) return;
        setInvitation(next);
        setState('ready');
      },
      (error: Error & { failure?: HqSetupFailure }) => {
        if (cancelled) return;
        setState(error.failure ?? 'error');
        setMessage(error.message);
      },
    );
    return () => { cancelled = true; };
  }, [token]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (state !== 'ready') return;
    if (!meetsHqPasswordPolicy(password)) {
      setMessage('Your password needs everything on the checklist.');
      return;
    }
    if (password !== confirmation) {
      setMessage('Both password boxes need to match.');
      return;
    }
    setState('loading');
    setMessage(null);
    try {
      await completeHqSetup(token, password, confirmation);
      setPassword('');
      setConfirmation('');
      setState('complete');
    } catch (error) {
      const setupError = error as Error & { failure?: HqSetupFailure };
      setState(setupError.failure && setupError.failure !== 'error' ? setupError.failure : 'ready');
      setMessage(setupError.message);
    }
  };

  const card = 'w-full max-w-md rounded-xl border border-card-border bg-card p-6 shadow-soft sm:p-8';
  if (state === 'loading') {
    return <main className="grid min-h-[100dvh] place-items-center bg-background px-4"><section className={card} aria-live="polite" data-testid="status-team-setup-loading">Checking your secure setup link…</section></main>;
  }
  if (state === 'complete') {
    return (
      <main className="grid min-h-[100dvh] place-items-center bg-background px-4">
        <section className={card} data-testid="status-team-setup-complete">
          <p className="text-[10px] font-bold uppercase tracking-[.16em] text-primary">THINNR HQ</p>
          <h1 className="mt-2 font-serif text-2xl font-bold text-navy">Your account is ready.</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Your password was set securely. Sign in with your work email to continue.</p>
          <Button className="mt-6 w-full" data-testid="button-team-setup-signin" onClick={() => navigate('/', { replace: true })}>Go to sign in</Button>
        </section>
      </main>
    );
  }
  if (state !== 'ready') {
    const copy = state === 'error' ? { title: 'We couldn’t check this setup link.', body: message ?? 'Check your connection and try the link again.' } : failureCopy[state];
    return (
      <main className="grid min-h-[100dvh] place-items-center bg-background px-4">
        <section className={card} role="alert" data-testid={`status-team-setup-${state}`}>
          <p className="text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">THINNR HQ account setup</p>
          <h1 className="mt-2 font-serif text-2xl font-bold text-navy">{copy.title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.body}</p>
          <Button variant="outline" className="mt-6 w-full" data-testid="button-team-setup-signin" onClick={() => navigate('/', { replace: true })}>Back to sign in</Button>
        </section>
      </main>
    );
  }

  const passwordValid = meetsHqPasswordPolicy(password);
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-background px-4 py-8">
      <section className={card}>
        <p className="text-[10px] font-bold uppercase tracking-[.16em] text-primary">THINNR HQ account setup</p>
        <h1 className="mt-2 font-serif text-2xl font-bold text-navy">Welcome, {invitation?.name}.</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Set a password to activate your secure HQ account.</p>
        <dl className="mt-5 rounded-md border border-border bg-secondary/40 px-4 py-3 text-xs">
          <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Work email</dt><dd className="truncate font-semibold text-navy" data-testid="text-team-setup-email">{invitation?.email}</dd></div>
          <div className="mt-2 flex justify-between gap-3"><dt className="text-muted-foreground">Department role</dt><dd className="font-semibold text-navy" data-testid="text-team-setup-role">{invitation?.role}</dd></div>
        </dl>
        <form className="mt-5 space-y-4" onSubmit={(event) => void submit(event)} noValidate>
          <div><Label htmlFor="team-setup-password">Create password</Label><Input id="team-setup-password" data-testid="input-team-setup-password" className="mt-1.5" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus /></div>
          <div><Label htmlFor="team-setup-confirmation">Confirm password</Label><Input id="team-setup-confirmation" data-testid="input-team-setup-confirmation" className="mt-1.5" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div>
          <ul className="space-y-1" aria-label="Password requirements">{PASSWORD_RULES.map((rule) => { const met = rule.matches(password); return <li key={rule.label} className={`flex items-center gap-2 text-[11px] ${met ? 'text-primary' : 'text-muted-foreground'}`}>{met ? <CheckCircle2 size={13} aria-hidden="true" /> : <Circle size={13} aria-hidden="true" />}{rule.label}</li>; })}</ul>
          {message && <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert" data-testid="status-team-setup-error">{message}</p>}
          <Button type="submit" className="w-full" data-testid="button-team-setup-submit" disabled={!passwordValid || password !== confirmation}>Activate account</Button>
        </form>
      </section>
    </main>
  );
}