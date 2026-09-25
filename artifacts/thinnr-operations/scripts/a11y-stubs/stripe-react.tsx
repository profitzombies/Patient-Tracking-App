import React, { type ReactNode } from 'react';
export function Elements({ children }: { children: ReactNode }) { return <>{children}</>; }
export function PaymentElement() { return <div>Secure Stripe Payment Element</div>; }
export function CardNumberElement() { return <div>Card number field</div>; }
export function CardExpiryElement() { return <div>Card expiry field</div>; }
export function CardCvcElement() { return <div>Card security code field</div>; }
/** Suites may swap what the next Stripe confirmation returns. */
export const __stripeStub = {
  paymentMethod: 'pm_fixture',
  cardSetups: [] as Array<{ clientSecret: string }>,
};
export function useElements() { return { getElement: () => ({ element: 'card' }) }; }
export function useStripe() {
  return {
    confirmSetup: async () => ({ setupIntent: { payment_method: __stripeStub.paymentMethod } }),
    confirmCardSetup: async (clientSecret: string) => {
      __stripeStub.cardSetups.push({ clientSecret });
      return { setupIntent: { payment_method: __stripeStub.paymentMethod } };
    },
  };
}
