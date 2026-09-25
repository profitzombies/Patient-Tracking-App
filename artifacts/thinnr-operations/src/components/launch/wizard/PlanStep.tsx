import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { useOfficeAccessMutations } from '@/hooks/use-office-access';
import type { OfficeAccessSnapshot } from '@/lib/billing-types';
import { freePeriodSentence, money, yearlySavings } from './steps';
import { InlineError, StepFrame, WizardFooter, readable } from './ui';

type Plan = 'monthly' | 'yearly';

export function PlanStep({ access, readOnly, onBack, onNext }: {
  access: OfficeAccessSnapshot; readOnly: boolean; onBack: () => void; onNext: () => void;
}) {
  const writes = useOfficeAccessMutations();
  // The office's pick shows at once; the server write follows and a failure puts the old choice back.
  const [choice, setChoice] = useState<Plan | null>(access.plan.selected);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!saving) setChoice(access.plan.selected); }, [access.plan.selected, saving]);
  const savings = yearlySavings(access);
  const canChoose = !readOnly && access.canChoosePlan;
  const pick = async (plan: Plan) => {
    if (!canChoose || plan === choice) return;
    const previous = choice;
    setChoice(plan); setError(''); setSaving(true);
    try { await writes.plan.mutateAsync(plan); }
    catch (failure) { setChoice(previous); setError(readable(failure, 'Your plan could not be saved. Try again.')); }
    finally { setSaving(false); }
  };
  const confirmed = choice !== null && choice === access.plan.selected;
  const days = access.plan.includedPeriodDays;
  const cards: Array<{ plan: Plan; title: string; price: number; per: string; lines: string[] }> = [
    { plan: 'monthly', title: 'Monthly', price: access.plan.monthlyPriceCents, per: '/ month',
      lines: [`${money(access.plan.monthlyPriceCents * 12)} over a year`, 'Billed every month after your free access ends'] },
    { plan: 'yearly', title: 'Yearly', price: access.plan.yearlyPriceCents, per: '/ year',
      lines: [`Works out to ${money(Math.round(access.plan.yearlyPriceCents / 12))} a month`, 'Billed once a year after your free access ends'] },
  ];
  return <StepFrame testId="wizard-step-plan" eyebrow="Step 4" title="Choose your plan"
    sub={`Every plan starts with ${days} ${days === 1 ? 'day' : 'days'} of free access. You pick how you'd like to pay once it ends.`}>
    <div className="grid gap-4 md:grid-cols-2" role="radiogroup" aria-label="Plan">
      {cards.map((card) => {
        const selected = choice === card.plan;
        return <button key={card.plan} type="button" role="radio" aria-checked={selected} disabled={!canChoose}
          data-testid={`wizard-plan-${card.plan}`} data-selected={selected ? 'true' : 'false'} onClick={() => void pick(card.plan)}
          className={`relative flex flex-col gap-4 rounded-lg border-2 p-5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none disabled:cursor-default ${selected ? 'border-primary bg-accent shadow-md' : 'border-card-border bg-card shadow-soft hover:border-primary/50'}`}>
          <span className="flex items-center justify-between">
            <span className="font-serif text-xl font-bold text-navy">{card.title}</span>
            <span className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card'}`} aria-hidden="true">
              {selected && <Check size={14} strokeWidth={3} />}
            </span>
          </span>
          {card.plan === 'yearly' && savings.cents > 0 && <span className="self-start rounded-full bg-primary px-2.5 py-1 text-[11px] font-bold text-primary-foreground" data-testid="wizard-plan-savings">
            Save {money(savings.cents)} a year{savings.percent > 0 ? ` (${savings.percent}%)` : ''}
          </span>}
          <span><span className="font-serif text-3xl font-bold text-navy">{money(card.price)}</span> <span className="text-sm text-muted-foreground">{card.per}</span></span>
          <ul className="space-y-1.5 text-sm text-muted-foreground">
            {card.lines.map((line) => <li key={line} className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />{line}</li>)}
          </ul>
        </button>;
      })}
    </div>
    <div className="rounded-lg border border-card-border bg-card px-5 py-4 text-sm shadow-soft" aria-live="polite" data-testid="wizard-plan-terms">
      {choice
        ? <p className="font-semibold text-navy">{freePeriodSentence(access, choice)}</p>
        : <p className="text-muted-foreground">Free access: {days} {days === 1 ? 'day' : 'days'}. Choose a plan to see your first charge date.</p>}
      <p className="mt-1 text-xs text-muted-foreground">Nothing is charged during your free access.</p>
    </div>
    {!canChoose && <p className="text-xs text-muted-foreground">Only the practice owner can choose the plan.</p>}
    {error && <InlineError message={error} />}
    <WizardFooter onBack={onBack} onContinue={onNext} busy={saving} canContinue={readOnly || confirmed}
      hint="Choose a plan to continue." />
  </StepFrame>;
}
