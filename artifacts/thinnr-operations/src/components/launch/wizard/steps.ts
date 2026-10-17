import type { LaunchState } from '@/hooks/use-launch';
import type { OfficeAccessSlot, OfficeAccessSnapshot } from '@/lib/billing-types';

/**
 * First-time office setup, one task per screen. Order is the order the office
 * walks; "done" comes only from server state so leaving and coming back (on
 * any device) resumes at the same place.
 */
export const WIZARD_STEPS = [
  { id: 'details', label: 'Practice details', short: 'Details' },
  { id: 'security', label: 'Account security', short: 'Security' },
  { id: 'connect', label: 'Connect payments', short: 'Payments' },
  { id: 'plan', label: 'Choose your plan', short: 'Plan' },
  { id: 'payment', label: 'Payment details', short: 'Billing' },
  { id: 'review', label: 'Review & activate', short: 'Activate' },
] as const;
export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'] | 'done';

export interface WizardFacts {
  launch: LaunchState;
  access: OfficeAccessSnapshot;
}

export function instrumentFor(access: OfficeAccessSnapshot, slot: OfficeAccessSlot) {
  return access.instruments.find((item) => item.slot === slot);
}

/**
 * Stripe is "far enough" to move on once the office has submitted its details
 * (pending = Stripe is verifying). Activation itself still waits for ready.
 */
export function connectSubmitted(launch: LaunchState) {
  return launch.payments.state === 'pending' || launch.payments.state === 'ready';
}

/** A bank on file counts, even while its test deposits are being verified — unless the window has run out. */
export function paymentDetailsDone(access: OfficeAccessSnapshot) {
  return Boolean(instrumentFor(access, 'bank') && !access.bank.overdue
    && instrumentFor(access, 'card_primary') && instrumentFor(access, 'card_backup'));
}

export function stepDone(id: WizardStepId, { launch, access }: WizardFacts): boolean {
  switch (id) {
    case 'details': return launch.detailsConfirmed;
    case 'security': return launch.security.ready;
    case 'connect': return connectSubmitted(launch);
    case 'plan': return access.plan.selected !== null;
    case 'payment': return paymentDetailsDone(access);
    case 'review': return launch.completedAt !== null;
    case 'done': return launch.completedAt !== null;
  }
}

/** Where a returning office picks up: the first step the server does not report finished. */
export function firstUnfinishedStep(facts: WizardFacts): WizardStepId {
  return WIZARD_STEPS.find((step) => !stepDone(step.id, facts))?.id ?? 'done';
}

export function nextStep(id: WizardStepId, facts: WizardFacts, readOnly: boolean): WizardStepId {
  const index = WIZARD_STEPS.findIndex((step) => step.id === id);
  for (let i = index + 1; i < WIZARD_STEPS.length; i++) {
    const step = WIZARD_STEPS[i].id;
    // Security that is already in place is never a stop going forward.
    if (!readOnly && step === 'security' && stepDone('security', facts)) continue;
    return step;
  }
  return 'done';
}

export function previousStep(id: WizardStepId): WizardStepId | null {
  if (id === 'done') return null;
  const index = WIZARD_STEPS.findIndex((step) => step.id === id);
  return index > 0 ? WIZARD_STEPS[index - 1].id : null;
}

export const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
export const longDate = (value: string | Date) => new Intl.DateTimeFormat('en-US', { dateStyle: 'long' }).format(new Date(value));
/**
 * A billing boundary as the calendar day billing uses. Included periods and
 * charge dates are UTC instants (an agreement-anchored period ends at UTC
 * midnight), so the day is read in UTC: a Pacific browser must name the same
 * day as the HQ card and the charger, not the evening before.
 */
export const chargeDay = (value: string | Date) => new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(value));

/**
 * When the first charge lands. The server states the date once the included
 * period is anchored — at the owner's first sign-in, or earlier for a THINNR
 * reseller whose agreement date HQ recorded; until then we state what today
 * would give. `elapsed` is the server's date already behind us (a reseller
 * agreement signed more than a period ago): the first charge then runs at the
 * next billing pass once payment setup is complete, not on a future day.
 */
export function firstCharge(access: OfficeAccessSnapshot, now = new Date()) {
  if (access.plan.firstChargeAt) {
    const at = Date.parse(access.plan.firstChargeAt);
    return { at: access.plan.firstChargeAt, estimated: false, elapsed: Number.isFinite(at) && at <= now.getTime() };
  }
  return { at: new Date(now.getTime() + access.plan.includedPeriodDays * 86_400_000).toISOString(), estimated: true, elapsed: false };
}

/** "Your first charge of $200 is on April 5, 2027." — or, for an elapsed period, when it actually runs. */
export function firstChargeSentence(access: OfficeAccessSnapshot, plan: 'monthly' | 'yearly', now = new Date()) {
  const charge = firstCharge(access, now);
  const amount = money(planPriceCents(access, plan));
  if (charge.elapsed) return `Your free access ended on ${chargeDay(charge.at)}, so your first charge of ${amount} runs as soon as your payment setup is complete.`;
  return `Your first charge of ${amount} ${charge.estimated ? 'would be' : 'is'} on ${chargeDay(charge.at)}${charge.estimated ? ' if you activate today' : ''}.`;
}

export function planPriceCents(access: OfficeAccessSnapshot, plan: 'monthly' | 'yearly') {
  // Once chosen, the server's price for this office is the one that will be charged.
  if (access.plan.selected === plan) return access.plan.priceCents;
  return plan === 'monthly' ? access.plan.monthlyPriceCents : access.plan.yearlyPriceCents;
}

export function yearlySavings(access: OfficeAccessSnapshot) {
  const twelve = access.plan.monthlyPriceCents * 12;
  const cents = Math.max(0, twelve - access.plan.yearlyPriceCents);
  return { cents, percent: twelve > 0 ? Math.round((cents / twelve) * 100) : 0 };
}

/**
 * How the setup screens title the agreement: the reseller access disclosure
 * or the software agreement, by the kind the server chose for this office.
 */
export function agreementTitle(access: OfficeAccessSnapshot): string {
  return access.disclosure.kind === 'software' ? 'Software agreement' : 'Access terms';
}

/** "Free access: 365 days. Your first charge of $2,000 is on April 5, 2027." */
export function freePeriodSentence(access: OfficeAccessSnapshot, plan: 'monthly' | 'yearly', now = new Date()) {
  const days = access.plan.includedPeriodDays;
  return `Free access: ${days} ${days === 1 ? 'day' : 'days'}. ${firstChargeSentence(access, plan, now)}`;
}
