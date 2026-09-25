import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, Loader2 } from 'lucide-react';
import { BTN_PRIMARY, BTN_SECONDARY } from '@/components/patient/heritage';

/** One screen of the wizard: serif title, a single plain sentence, then the task. */
export function StepFrame({ eyebrow, title, sub, children, testId }: {
  eyebrow: string; title: string; sub?: ReactNode; children: ReactNode; testId: string;
}) {
  return <section aria-labelledby={`${testId}-title`} data-testid={testId} className="space-y-6">
    <header className="space-y-2">
      <p className="text-[11px] font-bold uppercase tracking-[.14em] text-primary">{eyebrow}</p>
      <h1 id={`${testId}-title`} className="font-serif text-[28px] font-bold leading-tight text-navy sm:text-[32px]">{title}</h1>
      {sub && <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{sub}</p>}
    </header>
    {children}
  </section>;
}

export function WizardFooter({ onBack, onContinue, canContinue, busy = false, continueLabel = 'Continue', hint, testId = 'wizard-continue' }: {
  onBack?: () => void;
  onContinue: () => void;
  canContinue: boolean;
  busy?: boolean;
  continueLabel?: string;
  /** Why Continue is waiting, shown beside the button. */
  hint?: string | null;
  testId?: string;
}) {
  return <div className="sticky bottom-0 -mx-5 mt-8 flex flex-col-reverse gap-3 border-t border-border bg-background/95 px-5 py-4 backdrop-blur sm:static sm:mx-0 sm:flex-row sm:items-center sm:justify-between sm:bg-transparent sm:px-0 sm:backdrop-blur-none">
    {onBack
      ? <button type="button" className={`${BTN_SECONDARY} h-11 px-4 text-sm`} onClick={onBack} data-testid="wizard-back"><ArrowLeft size={15} aria-hidden="true" />Back</button>
      : <span />}
    <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
      {hint && !canContinue && <p className="text-xs text-muted-foreground sm:text-right" data-testid="wizard-hint">{hint}</p>}
      <button type="button" className={`${BTN_PRIMARY} h-11 px-5 text-sm disabled:cursor-not-allowed disabled:opacity-50`} disabled={!canContinue || busy}
        onClick={onContinue} data-testid={testId}>
        {busy ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
        {continueLabel}{!busy && <ArrowRight size={15} aria-hidden="true" />}
      </button>
    </div>
  </div>;
}

/** The blue check used for anything already finished. */
export function DoneMark({ size = 20 }: { size?: number }) {
  return <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground" style={{ width: size, height: size }} aria-hidden="true">
    <Check size={Math.round(size * 0.62)} strokeWidth={3} />
  </span>;
}

export function DoneRow({ title, detail, testId }: { title: string; detail?: ReactNode; testId?: string }) {
  return <div className="flex items-start gap-3 rounded-lg border border-accent-border bg-accent px-4 py-3.5" data-testid={testId}>
    <DoneMark />
    <div className="min-w-0 text-sm"><p className="font-semibold text-navy">{title}</p>{detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}</div>
  </div>;
}

/** Branded placeholder for waits on Stripe (never a blank box). */
export function BrandedLoader({ title, detail, testId = 'wizard-loader' }: { title: string; detail?: string; testId?: string }) {
  return <div role="status" aria-live="polite" data-testid={testId} className="flex min-h-[260px] flex-col items-center justify-center gap-4 rounded-lg border border-card-border bg-card px-6 py-10 text-center shadow-soft">
    <div className="relative h-12 w-12">
      <span className="absolute inset-0 rounded-full border-2 border-accent-border" />
      <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-primary motion-reduce:animate-none" />
      <span className="absolute inset-0 flex items-center justify-center font-serif text-lg font-bold text-primary">T</span>
    </div>
    <div className="space-y-1"><p className="font-serif text-lg font-bold text-navy">{title}</p>{detail && <p className="text-xs text-muted-foreground">{detail}</p>}</div>
    <div className="w-full max-w-sm space-y-2 pt-2" aria-hidden="true">
      <div className="h-2.5 w-3/4 rounded bg-secondary motion-safe:animate-pulse" />
      <div className="h-2.5 w-full rounded bg-secondary motion-safe:animate-pulse" />
      <div className="h-2.5 w-5/6 rounded bg-secondary motion-safe:animate-pulse" />
    </div>
  </div>;
}

export function InlineError({ message, action }: { message: string; action?: ReactNode }) {
  return <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
    {message}{action && <span className="ml-2">{action}</span>}
  </div>;
}

export function ReadOnlyNote({ hq }: { hq: boolean }) {
  return <p className="rounded-md border border-border bg-secondary px-4 py-3 text-xs text-muted-foreground" data-testid="wizard-read-only">
    {hq ? 'HQ view: read-only. Only the practice owner can make these choices.' : 'Only the practice owner can make these choices. You can review each step.'}
  </p>;
}

export function readable(error: unknown, fallback = 'That did not work. Try again.') {
  return error instanceof Error && error.message ? error.message : fallback;
}
