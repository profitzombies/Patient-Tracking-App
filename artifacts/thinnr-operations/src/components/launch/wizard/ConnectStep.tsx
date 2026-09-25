import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ArrowRight, Building2, KeyRound, Lock } from 'lucide-react';
import { ConnectEmbed, ConnectOnboarding } from '@/components/billing/ConnectEmbed';
import { BTN_PRIMARY, BTN_SECONDARY, LINK_ACTION } from '@/components/patient/heritage';
import type { LaunchState } from '@/hooks/use-launch';
import { BillingApiError, officeBilling } from '@/lib/billing-api';
import type { OfficeBillingStatus } from '@/lib/billing-types';
import { BrandedLoader, DoneRow, InlineError, StepFrame, WizardFooter, readable } from './ui';

export type OAuthReturn = { kind: 'connected' } | { kind: 'error'; message: string } | null;

/** Stripe hosts: warm the connections as soon as this step opens. */
const STRIPE_ORIGINS = ['https://connect-js.stripe.com', 'https://api.stripe.com', 'https://b.stripecdn.com'];
function useStripePreconnect() {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const added = STRIPE_ORIGINS.filter((href) => !document.head.querySelector(`link[rel="preconnect"][href="${href}"]`)).map((href) => {
      const link = document.createElement('link');
      link.rel = 'preconnect'; link.href = href; link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
      return link;
    });
    return () => { added.forEach((link) => link.remove()); };
  }, []);
}

type Busy = null | 'create' | 'oauth' | 'switch-existing' | 'switch-new';

export function ConnectStep({ launch, status, statusLoading, oauthReturn, readOnly, office, onBack, onNext }: {
  launch: LaunchState;
  status: OfficeBillingStatus | null;
  statusLoading: boolean;
  oauthReturn: OAuthReturn;
  readOnly: boolean;
  office: string | null;
  onBack: () => void;
  onNext: () => void;
}) {
  useStripePreconnect();
  const client = useQueryClient();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const [lockedMessage, setLockedMessage] = useState<string | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState<null | 'existing' | 'new'>(null);
  const [signInFailed, setSignInFailed] = useState<string | null>(oauthReturn?.kind === 'error' ? oauthReturn.message : null);
  const [createdHere, setCreatedHere] = useState(false);

  const state = launch.payments.state;
  const account = status?.account ?? null;
  const submitted = state === 'pending' || state === 'ready';
  const hasAccount = state !== 'not_started' || createdHere;
  const origin = account?.origin ?? (createdHere ? 'created' : null);
  const oauthAvailable = Boolean(status?.oauth_available);

  const refreshAll = () => client.invalidateQueries({ predicate: (query) =>
    query.queryKey[0] === 'office' || (query.queryKey[0] === 'billing' && query.queryKey[1] === 'office') });

  const run = async (kind: Exclude<Busy, null>, work: () => Promise<void>) => {
    setBusy(kind); setError('');
    try { await work(); }
    catch (failure) {
      if (failure instanceof BillingApiError && failure.status === 409 && kind.startsWith('switch')) {
        setLockedMessage(failure.message);
      } else setError(readable(failure));
    } finally { setBusy(null); setConfirmSwitch(null); }
  };
  const createAccount = async () => {
    await officeBilling.createAccount(launch.billingScope, office);
    setCreatedHere(true); setSignInFailed(null);
    await refreshAll();
  };
  const signInToStripe = async () => {
    const { url } = await officeBilling.oauthStart(launch.billingScope, office);
    window.location.assign(url);
    // Keep the busy state: the page is leaving for Stripe.
    await new Promise(() => {});
  };
  const restart = async () => {
    await officeBilling.restartConnect(launch.billingScope, office);
    setCreatedHere(false);
    await refreshAll();
  };

  const locked = submitted || lockedMessage !== null;
  const lockNote = <div className="flex items-start gap-3 rounded-md border border-border bg-secondary px-4 py-3 text-xs text-muted-foreground" data-testid="wizard-connect-locked">
    <Lock size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
    <p>{lockedMessage ?? 'This Stripe account has been submitted, so it can no longer be swapped here.'} To use a different Stripe account, <Link href="/ai-support" className={LINK_ACTION}>contact THINNR support</Link>.</p>
  </div>;

  let body: ReactNode;
  if (state === 'ready') {
    body = <div className="space-y-4"><DoneRow testId="wizard-connect-done" title="Stripe account connected" detail={account?.business_name ? `${account.business_name} is ready to take patient payments.` : 'Your practice is ready to take patient payments.'} />{lockNote}</div>;
  } else if (state === 'pending') {
    body = <div className="space-y-4">
      <div className="rounded-lg border border-accent-border bg-accent px-4 py-3.5 text-sm" data-testid="wizard-connect-pending">
        <p className="font-semibold text-navy">Stripe is reviewing your details</p>
        <p className="mt-0.5 text-xs text-muted-foreground">This usually takes a few minutes. You can keep going and finish setup now; charging patients turns on once Stripe finishes verifying.</p>
      </div>{lockNote}</div>;
  } else if (busy === 'create' || busy === 'switch-new') {
    body = <BrandedLoader title="Creating your Stripe account" detail="Setting up a secure account for your practice…" />;
  } else if (busy === 'oauth' || busy === 'switch-existing') {
    body = <BrandedLoader title="Opening Stripe sign-in" detail="You'll come right back here after signing in." />;
  } else if (!hasAccount) {
    body = signInFailed
      ? <div className="space-y-4 rounded-lg border border-card-border bg-card p-5 shadow-soft" data-testid="wizard-connect-signin-failed">
        <div><p className="font-serif text-lg font-bold text-navy">We couldn't connect your Stripe account</p>
          <p className="mt-1 text-sm text-muted-foreground">{signInFailed}</p></div>
        <p className="text-sm">Can't sign in? You can create a new Stripe account instead, right here.</p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <button className={`${BTN_PRIMARY} h-11 px-4 text-sm`} disabled={readOnly} data-testid="wizard-connect-create-instead" onClick={() => void run('create', createAccount)}>Create a new account instead</button>
          <button className={`${BTN_SECONDARY} h-11 px-4 text-sm`} disabled={readOnly || !oauthAvailable} data-testid="wizard-connect-retry-signin" onClick={() => void run('oauth', signInToStripe)}>Try signing in again</button>
        </div>
      </div>
      : <div className="grid gap-4 md:grid-cols-2" role="group" aria-label="How do you want to connect payments?">
        <ChoiceCard testId="wizard-connect-new" icon={<Building2 size={20} aria-hidden="true" />} title="Create a new Stripe account"
          body="Set up a free Stripe account without leaving THINNR. Stripe asks for your business, owner and bank details." cta="Create account" recommended
          disabled={readOnly || statusLoading} onClick={() => void run('create', createAccount)} />
        <ChoiceCard testId="wizard-connect-existing" icon={<KeyRound size={20} aria-hidden="true" />} title="I already have a Stripe account"
          body={oauthAvailable ? 'Sign in to Stripe once to connect the account your practice already uses. You\'ll come right back here.' : 'Connecting an existing account is not available yet. Create a new account to continue.'}
          cta="Sign in to Stripe" disabled={readOnly || statusLoading || !oauthAvailable} onClick={() => void run('oauth', signInToStripe)} />
      </div>;
  } else if (!account && !createdHere && statusLoading) {
    body = <BrandedLoader title="Checking your Stripe account" />;
  } else if (origin === 'oauth') {
    body = <div className="space-y-4">
      <div className="rounded-lg border border-card-border bg-card p-5 shadow-soft">
        <p className="font-serif text-lg font-bold text-navy">Stripe needs a few more details</p>
        <p className="mt-1 text-sm text-muted-foreground">Your existing account is linked. Finish what Stripe asks for below.</p>
        <div className="mt-4"><EmbeddedOnboarding office={office} onExit={() => void refreshAll()} /></div>
      </div>
      {!readOnly && <SwitchPanel confirm={confirmSwitch === 'new'} onAsk={() => setConfirmSwitch('new')} onCancel={() => setConfirmSwitch(null)}
        question="Can't finish with this account?" ask="Create a new account instead"
        warning="This disconnects the account you signed in with, then creates a new Stripe account for your practice here."
        confirmLabel="Disconnect and create new" testId="wizard-connect-switch-new"
        onConfirm={() => void run('switch-new', async () => { await restart(); await createAccount(); })}
        extra={oauthAvailable ? <button className={`${BTN_SECONDARY} h-10 px-4`} data-testid="wizard-connect-retry-signin" onClick={() => void run('oauth', signInToStripe)}>Try signing in again</button> : null} />}
    </div>;
  } else {
    body = <div className="space-y-4">
      <EmbeddedOnboarding office={office} onExit={() => void refreshAll()} />
      {!readOnly && oauthAvailable && <SwitchPanel confirm={confirmSwitch === 'existing'} onAsk={() => setConfirmSwitch('existing')} onCancel={() => setConfirmSwitch(null)}
        question="Already have a Stripe account after all?" ask="Use my existing account"
        warning="This cancels the unfinished new account and takes you to Stripe to sign in."
        confirmLabel="Cancel new account and sign in" testId="wizard-connect-switch-existing"
        onConfirm={() => void run('switch-existing', async () => { await restart(); await signInToStripe(); })} />}
    </div>;
  }

  return <StepFrame testId="wizard-step-connect" eyebrow="Step 3" title="Connect payments"
    sub="THINNR uses Stripe to take patient payments and pay your practice. Choose how you want to connect.">
    {oauthReturn?.kind === 'connected' && !signInFailed && hasAccount && <DoneRow testId="wizard-connect-returned" title="You're back from Stripe" detail="Your Stripe account is linked to THINNR." />}
    {launch.payments.sandbox && <p className="text-xs text-muted-foreground">Test mode: nothing here moves real money.</p>}
    {body}
    {lockedMessage !== null && !submitted && lockNote}
    {error && <InlineError message={error} />}
    <WizardFooter onBack={onBack} onContinue={onNext} canContinue={submitted || readOnly}
      hint={hasAccount ? 'Finish the Stripe form to continue.' : 'Choose how to connect Stripe.'} />
  </StepFrame>;
}

function ChoiceCard({ icon, title, body, cta, onClick, disabled, recommended = false, testId }: {
  icon: ReactNode; title: string; body: string; cta: string; onClick: () => void; disabled: boolean; recommended?: boolean; testId: string;
}) {
  return <button type="button" data-testid={testId} disabled={disabled} onClick={onClick}
    className="group flex h-full flex-col items-start gap-3 rounded-lg border border-card-border bg-card p-5 text-left shadow-soft transition hover:border-primary hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-card-border motion-reduce:transition-none">
    <span className="flex w-full items-center justify-between">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-primary">{icon}</span>
      {recommended && <span className="rounded-full border border-accent-border bg-accent px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">Most offices</span>}
    </span>
    <span className="font-serif text-lg font-bold text-navy">{title}</span>
    <span className="text-sm leading-relaxed text-muted-foreground">{body}</span>
    <span className="mt-auto inline-flex items-center gap-1.5 pt-2 text-sm font-semibold text-primary">{cta}<ArrowRight size={14} className="transition group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" /></span>
  </button>;
}

function SwitchPanel({ confirm, onAsk, onCancel, onConfirm, question, ask, warning, confirmLabel, testId, extra }: {
  confirm: boolean; onAsk: () => void; onCancel: () => void; onConfirm: () => void;
  question: string; ask: string; warning: string; confirmLabel: string; testId: string; extra?: ReactNode;
}) {
  return <div className="rounded-md border border-border bg-secondary px-4 py-3 text-sm" data-testid={testId}>
    {!confirm
      ? <div className="flex flex-wrap items-center gap-3"><span className="text-muted-foreground">{question}</span>
        <button type="button" className={LINK_ACTION} data-testid={`${testId}-ask`} onClick={onAsk}>{ask}</button>{extra}</div>
      : <div className="space-y-3"><p>{warning}</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" className={`${BTN_PRIMARY} h-10 px-4`} data-testid={`${testId}-confirm`} onClick={onConfirm}>{confirmLabel}</button>
          <button type="button" className={`${BTN_SECONDARY} h-10 px-4`} onClick={onCancel}>Keep going here</button>
        </div></div>}
  </div>;
}

function EmbeddedOnboarding({ office, onExit }: { office: string | null; onExit: () => void }) {
  const [drawing, setDrawing] = useState(false);
  // Never leave the office staring at nothing if Stripe's start signal is late.
  useEffect(() => { const timer = setTimeout(() => setDrawing(true), 10_000); return () => clearTimeout(timer); }, []);
  const loader = <BrandedLoader title="Loading secure Stripe setup" detail="Stripe's form will appear here in a moment." />;
  return <div data-testid="wizard-connect-embed">
    <ConnectEmbed components={['account_onboarding']} office={office} loader={loader}>
      {!drawing && loader}
      <div className={drawing ? 'rounded-lg border border-card-border bg-card p-4 shadow-soft sm:p-6' : 'h-0 overflow-hidden'}>
        <ConnectOnboarding onExit={onExit} onLoaderStart={() => setDrawing(true)} onLoadError={() => setDrawing(true)} />
      </div>
    </ConnectEmbed>
  </div>;
}
