import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLaunchWrite, type LaunchState } from '@/hooks/use-launch';
import { useOfficeAccessMutations } from '@/hooks/use-office-access';
import { LINK_ACTION } from '@/components/patient/heritage';
import type { OfficeAccessSnapshot } from '@/lib/billing-types';
import { missingSetupItems, type SetupTarget } from '@/lib/setup-checklist';
import { agreementTitle, chargeDay, connectSubmitted, firstCharge, instrumentFor, money, planPriceCents, type WizardStepId } from './steps';
import { InlineError, StepFrame, WizardFooter, readable } from './ui';

export function ReviewStep({ launch, access, readOnly, onBack, onEdit, onActivated }: {
  launch: LaunchState; access: OfficeAccessSnapshot; readOnly: boolean;
  onBack: () => void; onEdit: (step: WizardStepId) => void; onActivated: () => void;
}) {
  const writes = useOfficeAccessMutations();
  const complete = useLaunchWrite('complete');
  const client = useQueryClient();
  const acknowledged = access.disclosure.acknowledgedAt !== null;
  const [agreed, setAgreed] = useState(acknowledged);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const plan = access.plan.selected;
  const charge = firstCharge(access);
  const bank = instrumentFor(access, 'bank');
  const primary = instrumentFor(access, 'card_primary');
  const backup = instrumentFor(access, 'card_backup');
  // Stripe still verifying (pending) is enough to finish setup; patient charging turns on once Stripe enables it.
  const paymentsReady = connectSubmitted(launch);
  // What the server checks before activating, minus what this screen settles
  // itself: ticking the box records the terms on Activate, and the wizard has
  // no products step (suggested prices are confirmed for the office).
  const missing = missingSetupItems(launch, access)
    .filter((item) => item.id !== 'products' && !(item.id === 'disclosure' && agreed));

  const activate = async () => {
    if (readOnly || lock.current) return;
    lock.current = true;
    setError(''); setBusy(true);
    try {
      if (!acknowledged) await writes.disclosure.mutateAsync(access.disclosure.version);
      const result = await complete.save({ expectedVersion: launch.version }, launch.billingScope);
      if (result?.completedAt) {
        // Activation starts the free period; the payment snapshot now carries the real first-charge date.
        void client.invalidateQueries({ predicate: (query) => !query.queryKey.includes('launch') && (query.queryKey[0] === 'office' || (query.queryKey[0] === 'billing' && query.queryKey[1] === 'office')) });
        onActivated();
      }
    } catch (failure) { setError(readable(failure, 'Setup could not be activated. Try again.')); }
    finally { lock.current = false; setBusy(false); }
  };

  const rows: Array<{ label: string; value: string; step: WizardStepId }> = [
    { label: 'Plan', value: plan ? `${plan === 'monthly' ? 'Monthly' : 'Yearly'} · ${money(planPriceCents(access, plan))} ${plan === 'monthly' ? 'a month' : 'a year'}` : 'Not chosen', step: 'plan' },
    { label: 'Free access', value: `${access.plan.includedPeriodDays} days`, step: 'plan' },
    {
      label: 'First charge',
      value: charge.elapsed
        ? `After activation (free access ended ${chargeDay(charge.at)})`
        : `${chargeDay(charge.at)}${charge.estimated ? ' (if you activate today)' : ''}`,
      step: 'plan',
    },
    { label: 'Bank account', value: bank ? `${bank.bankName || 'Bank'} ending in ${bank.last4}` : 'Not added', step: 'payment' },
    { label: 'First card', value: primary ? `${cardName(primary.brand)} ending in ${primary.last4}` : 'Not added', step: 'payment' },
    { label: 'Backup card', value: backup ? `${cardName(backup.brand)} ending in ${backup.last4}` : 'Not added', step: 'payment' },
  ];

  const waiting = !paymentsReady ? 'Finish connecting Stripe before you activate.'
    : !agreed ? 'Check the box to accept the terms.' : missing.length ? 'Finish the items above to activate.' : null;

  return <StepFrame testId="wizard-step-review" eyebrow="Step 6" title="Review and activate"
    sub="Check your choices, read the terms, and activate your practice.">
    <dl className="divide-y divide-border overflow-hidden rounded-lg border border-card-border bg-card shadow-soft" data-testid="wizard-review-summary">
      {rows.map((row) => <div key={row.label} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3 text-sm">
        <dt className="text-muted-foreground">{row.label}</dt>
        <dd className="flex items-center gap-3 font-semibold text-navy">{row.value}
          {!readOnly && <button type="button" className={LINK_ACTION} onClick={() => onEdit(row.step)} aria-label={`Change ${row.label.toLowerCase()}`}>Change</button>}</dd>
      </div>)}
    </dl>
    <div className="rounded-lg border border-card-border bg-card shadow-soft">
      <p className="border-b border-border px-5 py-3 text-[11px] font-bold uppercase tracking-[.14em] text-muted-foreground" data-testid="wizard-disclosure-title">{agreementTitle(access)}</p>
      <div className="max-h-64 overflow-y-auto whitespace-pre-wrap px-5 py-4 text-sm leading-relaxed text-foreground" data-testid="wizard-disclosure" tabIndex={0}>{access.disclosure.text}</div>
    </div>
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card px-4 py-3.5 text-sm">
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#315eae]" checked={agreed || acknowledged} disabled={readOnly || acknowledged || busy}
        data-testid="wizard-acknowledge" onChange={(event) => setAgreed(event.target.checked)} />
      <span>I have read and accept these terms for {launch.office.officeName}, including the plan and payment details above.</span>
    </label>
    {!readOnly && missing.length > 0 && <div className="rounded-lg border border-border bg-card px-5 py-4 text-sm" data-testid="wizard-missing">
      <p className="font-semibold text-navy">Still needed before you can activate:</p>
      <ul className="mt-2 space-y-1">{missing.map((item) => <li key={item.id}>
        {item.id === 'disclosure'
          ? <span data-testid="wizard-missing-disclosure">{item.label}</span>
          : <button type="button" className={LINK_ACTION} data-testid={`wizard-missing-${item.id}`} onClick={() => onEdit(wizardStepFor(item.id))}>{item.label}</button>}
      </li>)}</ul>
    </div>}
    {error && <InlineError message={error} />}
    <WizardFooter onBack={onBack} onContinue={() => void activate()} busy={busy} busyLabel="Activating…" testId="wizard-activate"
      canContinue={!readOnly && paymentsReady && (agreed || acknowledged) && missing.length === 0} continueLabel="Activate" hint={readOnly ? 'Only the practice owner can activate.' : waiting} />
  </StepFrame>;
}

function wizardStepFor(target: SetupTarget): WizardStepId {
  if (target === 'details' || target === 'security' || target === 'plan') return target;
  if (target === 'payments') return 'connect';
  return 'payment';
}

function cardName(brand: string | null) {
  return brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : 'Card';
}
