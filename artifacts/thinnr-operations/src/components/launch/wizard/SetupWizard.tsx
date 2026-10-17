import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { HelpCircle, LogOut, PartyPopper } from 'lucide-react';
import { BTN_PRIMARY, BTN_SECONDARY } from '@/components/patient/heritage';
import { prefersReducedMotion } from '@/components/launch/SetupStep';
import { useOfficeBillingStatus } from '@/hooks/use-billing';
import type { LaunchState } from '@/hooks/use-launch';
import { useOfficeAccessSetup } from '@/hooks/use-office-access';
import { useLiveOfficeScope } from '@/hooks/use-live-office-scope';
import { ConnectStep, type OAuthReturn } from './ConnectStep';
import { DetailsStep } from './DetailsStep';
import { PaymentStep } from './PaymentStep';
import { PlanStep } from './PlanStep';
import { ReviewStep } from './ReviewStep';
import { SecurityStep } from './SecurityStep';
import { WIZARD_STEPS, chargeDay, firstCharge, firstUnfinishedStep, money, nextStep, planPriceCents, previousStep, stepDone, type WizardFacts, type WizardStepId } from './steps';
import { BrandedLoader, DoneMark, InlineError, ReadOnlyNote, readable } from './ui';

/**
 * Stripe's existing-account sign-in returns to Get paid with `?connected=1`
 * or `?error=…`. During first-time setup the wizard owns every path, so it
 * reads that answer wherever it lands and reopens the connect step.
 */
export function readOAuthReturn(search: string): OAuthReturn {
  const params = new URLSearchParams(search);
  if (params.get('connected') === '1') return { kind: 'connected' };
  const error = params.get('error');
  return error ? { kind: 'error', message: error } : null;
}

export function SetupWizard({ launch, readOnly, onSignOut, onFinished }: {
  launch: LaunchState;
  readOnly: boolean;
  onSignOut: () => void;
  /** "You're all set" was dismissed: hand the office to the app. */
  onFinished: () => void;
}) {
  const scope = useLiveOfficeScope();
  const accessQuery = useOfficeAccessSetup();
  const statusQuery = useOfficeBillingStatus();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const client = useQueryClient();
  const [oauthReturn] = useState<OAuthReturn>(() => readOAuthReturn(search));
  const [step, setStep] = useState<WizardStepId | null>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const access = accessQuery.data;
  const facts: WizardFacts | null = access ? { launch, access } : null;

  // Clean the Stripe return off the address bar; the wizard lives at /setup.
  useEffect(() => {
    if (oauthReturn) void client.invalidateQueries({ predicate: (query) =>
      query.queryKey[0] === 'office' || (query.queryKey[0] === 'billing' && query.queryKey[1] === 'office') });
    if (oauthReturn || location !== '/setup') navigate('/setup', { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pick the starting screen once the server's saved progress is in.
  useEffect(() => {
    if (step !== null || !facts) return;
    setStep(oauthReturn && !launch.completedAt ? 'connect' : readOnly ? 'details' : firstUnfinishedStep(facts));
  }, [facts, step, oauthReturn, readOnly, launch.completedAt]);

  // Finished on another device (or by this screen): show the finish line.
  useEffect(() => {
    if (launch.completedAt && step !== null && step !== 'done') setStep('done');
  }, [launch.completedAt, step]);

  const go = (target: WizardStepId | null) => {
    if (!target) return;
    setStep(target);
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    // Move focus to the new screen so keyboard and screen reader users follow along.
    setTimeout(() => headingRef.current?.querySelector<HTMLElement>('h1')?.focus?.(), 0);
  };

  if (accessQuery.isError) return <Frame launch={launch} onSignOut={onSignOut} current={null}>
    <InlineError message={readable(accessQuery.error, 'Setup could not be loaded.')} action={<button className="underline" onClick={() => void accessQuery.refetch()}>Try again</button>} />
  </Frame>;
  if (!facts || step === null) return <Frame launch={launch} onSignOut={onSignOut} current={null}>
    <BrandedLoader title="Loading your practice setup" detail="Picking up where you left off…" testId="wizard-loading" />
  </Frame>;

  const next = () => go(nextStep(step, facts, readOnly));
  const back = () => {
    let target = previousStep(step);
    // Going back past an already-finished security screen lands on details.
    if (target === 'security' && stepDone('security', facts) && !readOnly) target = previousStep('security');
    go(target);
  };
  const office = scope.liveOffice;

  let screen: ReactNode;
  switch (step) {
    case 'details': screen = <DetailsStep launch={launch} readOnly={readOnly} onNext={next} />; break;
    case 'security': screen = <SecurityStep launch={launch} readOnly={readOnly} onBack={back} onNext={next} />; break;
    case 'connect': screen = <ConnectStep launch={launch} status={statusQuery.data ?? null} statusLoading={statusQuery.isPending}
      oauthReturn={oauthReturn} readOnly={readOnly} office={office} onBack={back} onNext={next} />; break;
    case 'plan': screen = <PlanStep access={facts.access} readOnly={readOnly} onBack={back} onNext={next} />; break;
    case 'payment': screen = <PaymentStep access={facts.access} readOnly={readOnly} onBack={back} onNext={next} />; break;
    case 'review': screen = <ReviewStep launch={launch} access={facts.access} readOnly={readOnly} onBack={back} onEdit={go} onActivated={() => go('done')} />; break;
    case 'done': screen = <DoneScreen launch={launch} facts={facts} onFinished={onFinished} />; break;
  }

  return <Frame launch={launch} onSignOut={onSignOut} current={step} facts={facts} readOnly={readOnly} onJump={go}>
    {readOnly && step !== 'done' && <div className="mb-6"><ReadOnlyNote hq={Boolean(launch.hqInspection)} /></div>}
    <div ref={headingRef} key={step} className="animate-in fade-in slide-in-from-bottom-2 duration-300 motion-reduce:animate-none [&_h1]:outline-none" tabIndex={-1}>
      {screen}
    </div>
  </Frame>;
}

function Frame({ launch, onSignOut, current, facts, readOnly = false, onJump, children }: {
  launch: LaunchState; onSignOut: () => void; current: WizardStepId | null; facts?: WizardFacts; readOnly?: boolean;
  onJump?: (step: WizardStepId) => void; children: ReactNode;
}) {
  return <div className="min-h-screen bg-background" data-testid="setup-wizard">
    <header className="border-b border-border bg-card/80 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-5 py-3.5">
        <div className="min-w-0">
          <p className="font-serif text-xl font-bold leading-none tracking-[.04em] text-navy">THINNR</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">Setting up {launch.office.officeName}</p>
        </div>
        <nav aria-label="Setup help" className="flex items-center gap-2">
          <Link href="/ai-support" className={`${BTN_SECONDARY} h-9 px-3`}><HelpCircle size={14} aria-hidden="true" /><span className="hidden sm:inline">Help</span></Link>
          <button type="button" className={`${BTN_SECONDARY} h-9 px-3`} onClick={onSignOut}><LogOut size={14} aria-hidden="true" /><span className="hidden sm:inline">Sign out</span></button>
        </nav>
      </div>
      {current && current !== 'done' && facts && <StepIndicator current={current} facts={facts} readOnly={readOnly} onJump={onJump} />}
    </header>
    <main className="mx-auto max-w-3xl px-5 pb-16 pt-8 sm:pt-12">{children}</main>
  </div>;
}

function StepIndicator({ current, facts, readOnly, onJump }: { current: WizardStepId; facts: WizardFacts; readOnly: boolean; onJump?: (step: WizardStepId) => void }) {
  const index = WIZARD_STEPS.findIndex((step) => step.id === current);
  // A step can be reopened once it (and everything before it) is finished, or any time in read-only view.
  const reachable = (i: number) => readOnly || WIZARD_STEPS.slice(0, i).every((step) => stepDone(step.id, facts));
  return <div className="mx-auto max-w-5xl px-5 pb-3">
    <div className="sm:hidden" data-testid="wizard-progress-compact">
      <p className="text-xs font-semibold text-navy">Step {index + 1} of {WIZARD_STEPS.length} · <span className="text-muted-foreground">{WIZARD_STEPS[index].label}</span></p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuemin={1} aria-valuemax={WIZARD_STEPS.length} aria-valuenow={index + 1} aria-label="Setup progress">
        <div className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${((index + 1) / WIZARD_STEPS.length) * 100}%` }} />
      </div>
    </div>
    <ol className="hidden items-center gap-1 sm:flex" aria-label="Setup steps" data-testid="wizard-steps">
      {WIZARD_STEPS.map((step, i) => {
        const done = stepDone(step.id, facts);
        const active = step.id === current;
        const canOpen = !active && reachable(i) && onJump;
        const content = <>
          {done && !active ? <DoneMark size={22} /> : <span className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${active ? 'bg-primary text-primary-foreground' : 'border border-border bg-card text-muted-foreground'}`}>{i + 1}</span>}
          <span className={`truncate text-xs ${active ? 'font-bold text-navy' : 'font-medium text-muted-foreground'}`}>{step.short}</span>
        </>;
        return <li key={step.id} className="flex min-w-0 flex-1 items-center gap-1" aria-current={active ? 'step' : undefined} data-step={step.id} data-done={done ? 'true' : 'false'}>
          {canOpen
            ? <button type="button" className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onJump(step.id)}>{content}</button>
            : <span className="flex min-w-0 items-center gap-2 px-1.5 py-1">{content}</span>}
          {i < WIZARD_STEPS.length - 1 && <span className={`mx-1 h-px flex-1 ${done ? 'bg-primary' : 'bg-border'}`} aria-hidden="true" />}
        </li>;
      })}
    </ol>
  </div>;
}

function DoneScreen({ launch, facts, onFinished }: { launch: LaunchState; facts: WizardFacts; onFinished: () => void }) {
  const plan = facts.access.plan.selected;
  const charge = firstCharge(facts.access);
  return <section className="space-y-6 text-center" data-testid="wizard-step-done" aria-labelledby="wizard-done-title">
    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary text-primary-foreground motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-500">
      <PartyPopper size={28} aria-hidden="true" />
    </div>
    <div className="space-y-2">
      <h1 id="wizard-done-title" className="font-serif text-[32px] font-bold text-navy">You're all set</h1>
      <p className="mx-auto max-w-md text-sm text-muted-foreground">{launch.office.officeName} is ready to invite patients and take payments.</p>
    </div>
    <div className="mx-auto max-w-md space-y-2 rounded-lg border border-card-border bg-card px-5 py-4 text-left text-sm shadow-soft">
      <p className="flex items-center gap-2"><DoneMark size={18} />Suggested prices are saved. Adjust them any time from Products.</p>
      {plan && <p className="flex items-center gap-2"><DoneMark size={18} />{charge.elapsed
        ? `Your free access ended on ${chargeDay(charge.at)}, so your first charge of ${money(planPriceCents(facts.access, plan))} runs at the next billing pass.`
        : `Your first charge of ${money(planPriceCents(facts.access, plan))} is on ${chargeDay(charge.at)}.`}</p>}
    </div>
    <button type="button" className={`${BTN_PRIMARY} h-12 px-6 text-sm`} data-testid="wizard-enter-app" onClick={onFinished}>Go to your dashboard</button>
  </section>;
}
