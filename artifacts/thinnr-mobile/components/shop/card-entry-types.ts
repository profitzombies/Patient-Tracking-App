/**
 * One contract for card entry on every platform. The native build fills it
 * with the Stripe React Native SDK (CardField), the web build with
 * Stripe.js (CardElement); checkout only ever talks to this handle.
 *
 * PaymentMethods are created on the office's CONNECTED account
 * (stripeAccountId): the server confirms against that account and a
 * platform-account PaymentMethod would be rejected.
 */
import type { ShippingAddress } from '@/lib/patient-billing-types';

export interface CardEntryConfig {
  publishableKey: string;
  stripeAccountId: string;
}

export interface CardBillingDetails {
  name: string;
  email: string | null;
  phone: string | null;
  address: Pick<ShippingAddress, 'line1' | 'line2' | 'city' | 'state' | 'postal_code' | 'country'>;
}

export type NextActionOutcome = 'succeeded' | 'processing' | 'requires_payment_method' | 'failed';

export interface CardEntryHandle {
  /** Tokenizes the card the patient typed; rejects with a patient-facing message. */
  createPaymentMethod: (billing: CardBillingDetails) => Promise<{ paymentMethodId: string }>;
  /** Completes 3DS / next-action for a PaymentIntent the server left in requires_action. */
  handleNextAction: (clientSecret: string) => Promise<NextActionOutcome>;
}

export interface CardEntryProps {
  config: CardEntryConfig;
  /** Fires as the patient types; `complete` once every card field validates. */
  onChange?: (complete: boolean) => void;
  /** Loading or configuration failures of the payment SDK itself. */
  onError?: (message: string) => void;
  disabled?: boolean;
  /**
   * Keeps the SDK mounted (so handleNextAction can finish 3DS for a SAVED
   * card) while the input itself is collapsed and hidden from assistive tech.
   */
  hidden?: boolean;
  testID?: string;
}

export const CARD_ENTRY_UNAVAILABLE = 'Card entry couldn’t load. Check your connection and try again.';
