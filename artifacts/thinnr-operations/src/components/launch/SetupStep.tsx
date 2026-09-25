import { forwardRef, type ReactNode } from 'react';
import { Check, Pencil } from 'lucide-react';

/** Fold/unfold duration; the page waits this long before scrolling on. */
export const FOLD_MS = 300;

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface SetupStepProps {
  /** Stable id used as the scroll target (`data-setup-step`). */
  stepId: string;
  /** Serif title shown while the step is open. */
  title: ReactNode;
  sub?: ReactNode;
  /** Folded row label, e.g. "Practice details confirmed". */
  doneLabel: string;
  /** Short muted line under the folded label. */
  doneDetail?: ReactNode;
  folded: boolean;
  /** When present the folded row reopens the step and shows a pencil button. */
  onOpen?: () => void;
  /** Accessible name of the pencil button. */
  editLabel?: string;
  children?: ReactNode;
}

/**
 * Practice setup step card: open like a Heritage section card, folded into a
 * single "done" row with a blue circled check. The body collapses by height
 * (grid rows 1fr → 0fr) and stays mounted so drafts survive a fold; while
 * folded it is inert. Reduced motion folds instantly.
 */
export const SetupStep = forwardRef<HTMLElement, SetupStepProps>(function SetupStep(
  { stepId, title, sub, doneLabel, doneDetail, folded, onOpen, editLabel, children },
  ref,
) {
  return (
    <section
      ref={ref}
      data-setup-step={stepId}
      data-state={folded ? 'folded' : 'open'}
      className="scroll-mt-4 overflow-hidden rounded-lg border border-card-border bg-card shadow-soft"
    >
      {folded ? (
        <div
          data-testid={`setup-step-${stepId}-folded`}
          className={`flex items-center gap-3 px-5 py-4 ${onOpen ? 'cursor-pointer hover:bg-accent/40' : ''}`}
          onClick={onOpen}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground" aria-hidden="true">
            <Check size={14} strokeWidth={3} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-serif text-base font-bold leading-snug tracking-[.01em] text-navy">{doneLabel}</h2>
            {doneDetail && <p className="mt-0.5 text-xs text-muted-foreground">{doneDetail}</p>}
          </div>
          {onOpen && (
            <button
              type="button"
              aria-label={editLabel ?? `Edit ${doneLabel.toLowerCase()}`}
              data-testid={`button-setup-step-${stepId}-edit`}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => { event.stopPropagation(); onOpen(); }}
            >
              <Pencil size={14} />
            </button>
          )}
        </div>
      ) : (
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-serif text-base font-bold leading-snug tracking-[.01em] text-navy">{title}</h2>
          {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
        </div>
      )}
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${folded ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'}`}
        aria-hidden={folded || undefined}
        inert={folded || undefined}
      >
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </section>
  );
});
