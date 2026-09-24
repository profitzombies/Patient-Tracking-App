import React, { type ReactNode } from 'react';
export function Elements({ children }: { children: ReactNode }) { return <>{children}</>; }
export function PaymentElement() { return <div>Secure Stripe Payment Element</div>; }
export function useElements() { return {}; }
export function useStripe() {
  return { confirmSetup: async () => ({ setupIntent: { payment_method: 'pm_fixture' } }) };
}