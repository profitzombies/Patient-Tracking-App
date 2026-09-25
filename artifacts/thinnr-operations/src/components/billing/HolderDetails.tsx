/**
 * The cardholder / account-holder name and email for an office payment method.
 *
 * Both start as the practice's details (the server sends them with the
 * SetupIntent) and stay editable. They are sent to Stripe with the
 * confirmation, so the saved card or bank carries a name in THINNR's Stripe
 * dashboard instead of an anonymous "•••• 4242".
 */
import { useState } from 'react';

export interface HolderDetails { name: string; email: string }

const FIELD = 'mt-1.5 h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground shadow-xs focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function useHolderDetails(defaults?: { name: string | null; email: string | null } | null) {
  const [details, setDetails] = useState<HolderDetails>({ name: defaults?.name ?? '', email: defaults?.email ?? '' });
  return [details, setDetails] as const;
}

/** Why the details cannot be sent yet, or null when they can. */
export function holderProblem(details: HolderDetails, kind: 'card' | 'bank'): string | null {
  if (!details.name.trim()) return kind === 'bank' ? 'Enter the name on the bank account.' : 'Enter the name on the card.';
  if (!EMAIL.test(details.email.trim())) return 'Enter an email address for payment receipts and notices.';
  return null;
}

/** The billing_details Stripe saves on the payment method. */
export function holderBillingDetails(details: HolderDetails) {
  return { name: details.name.trim(), email: details.email.trim() };
}

export function HolderDetailsFields({ kind, details, onChange, disabled, idPrefix }: {
  kind: 'card' | 'bank'; details: HolderDetails; onChange: (next: HolderDetails) => void; disabled?: boolean; idPrefix: string;
}) {
  return <div className="grid gap-3 sm:grid-cols-2" data-testid={`${idPrefix}-holder`}>
    <label className="block text-xs font-semibold text-navy" htmlFor={`${idPrefix}-holder-name`}>
      {kind === 'bank' ? 'Account holder name' : 'Name on card'}
      <input id={`${idPrefix}-holder-name`} className={FIELD} value={details.name} disabled={disabled} autoComplete={kind === 'card' ? 'cc-name' : 'name'}
        onChange={(event) => onChange({ ...details, name: event.target.value })} />
    </label>
    <label className="block text-xs font-semibold text-navy" htmlFor={`${idPrefix}-holder-email`}>
      Billing email
      <input id={`${idPrefix}-holder-email`} type="email" className={FIELD} value={details.email} disabled={disabled} autoComplete="email"
        onChange={(event) => onChange({ ...details, email: event.target.value })} />
    </label>
  </div>;
}
