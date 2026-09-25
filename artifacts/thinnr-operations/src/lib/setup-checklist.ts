import type { LaunchState } from '@/hooks/use-launch';
import type { OfficeAccessSlot, OfficeAccessSnapshot } from '@/lib/billing-types';

/** Every place on the setup page a missing item can send the owner to. */
export type SetupTarget = 'details' | 'security' | 'payments' | 'products' | OfficeAccessSlot | 'plan' | 'disclosure';
export interface MissingSetupItem { id: SetupTarget; label: string }

/** The element id each office-payment section carries so the checklist can jump to it. */
export const setupSectionId = (target: SetupTarget) => `setup-${target}`;

interface AccessFacts { slots: Set<OfficeAccessSlot>; bankOverdue: boolean; planSelected: boolean; disclosureAcknowledged: boolean }

/**
 * The office's own payment facts. The live access snapshot is preferred: it is
 * what every setup write answers with (and what plan and disclosure update
 * optimistically). The launch snapshot's copy covers the moment before the
 * access snapshot has loaded.
 */
function accessFacts(launch: LaunchState, access: OfficeAccessSnapshot | null | undefined): AccessFacts | null {
  if (access) return {
    slots: new Set(access.instruments.map((item) => item.slot)),
    bankOverdue: access.bank.overdue,
    planSelected: access.plan.selected !== null,
    disclosureAcknowledged: access.disclosure.acknowledgedAt !== null,
  };
  const summary = launch.accessSetup;
  if (!summary) return null;
  const all: OfficeAccessSlot[] = ['bank', 'card_primary', 'card_backup'];
  return {
    slots: new Set(all.filter((slot) => !summary.missing.includes(slot))),
    bankOverdue: summary.bankVerificationOverdue,
    planSelected: summary.planSelected,
    disclosureAcknowledged: summary.disclosureAcknowledged,
  };
}

/**
 * What still stands between the owner and "Finish setup", in page order. The
 * same facts the server checks before it will complete setup: details and
 * products (first-time full setup only), account security, a Stripe
 * connection far enough along (Stripe still verifying counts), and the
 * office's own bank account, two cards, plan and accepted terms. An empty
 * list is the only state in which Finish is offered.
 */
export function missingSetupItems(launch: LaunchState, access?: OfficeAccessSnapshot | null): MissingSetupItem[] {
  const items: MissingSetupItem[] = [];
  if (launch.fullSetupRequired && !launch.detailsConfirmed) items.push({ id: 'details', label: 'Confirm your practice details' });
  if (!launch.security.ready) items.push({ id: 'security', label: 'Verify your phone for account security' });
  if (launch.payments.state !== 'ready' && launch.payments.state !== 'pending') {
    items.push({ id: 'payments', label: launch.payments.state === 'not_started' ? 'Connect Stripe payments' : 'Finish Stripe’s steps for your account' });
  }
  if (launch.fullSetupRequired && !launch.productsConfirmed) items.push({ id: 'products', label: 'Confirm your product prices' });
  const facts = accessFacts(launch, access);
  if (facts) {
    if (!facts.slots.has('bank')) items.push({ id: 'bank', label: 'Add your bank account' });
    else if (facts.bankOverdue) items.push({ id: 'bank', label: 'Verify or replace your bank account' });
    if (!facts.slots.has('card_primary')) items.push({ id: 'card_primary', label: 'Add your first card' });
    if (!facts.slots.has('card_backup')) items.push({ id: 'card_backup', label: 'Add your backup card' });
    if (!facts.planSelected) items.push({ id: 'plan', label: 'Choose a billing plan' });
    if (!facts.disclosureAcknowledged) items.push({ id: 'disclosure', label: 'Accept the access terms' });
  }
  return items;
}
