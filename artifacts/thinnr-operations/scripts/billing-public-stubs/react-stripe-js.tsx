import React, { type ReactNode } from 'react';

type ElementsOptions = { clientSecret?: string; amount?: number; mode?: string; paymentMethodCreation?: string };
type StubState = typeof globalThis & { __billingElementsSecret?: string; __billingElementsAmount?: number; __billingElementsOptions?: ElementsOptions };

export function Elements({ children, options }: { children: ReactNode; stripe: unknown; options: ElementsOptions }) {
  const state = globalThis as StubState;
  state.__billingElementsSecret = options.clientSecret;
  state.__billingElementsAmount = options.amount;
  state.__billingElementsOptions = options;
  return <div data-testid="elements-stub">{children}</div>;
}

export function PaymentElement() {
  return <div data-testid="payment-element-stub" />;
}

export function useStripe() {
  return {
    confirmPayment: async () => ({}),
    // Real Stripe rejects createPaymentMethod({ elements }) unless the Elements
    // instance was created in deferred mode with paymentMethodCreation: 'manual'.
    createPaymentMethod: async () => {
      const options = (globalThis as StubState).__billingElementsOptions;
      if (options?.mode !== 'payment' || options.paymentMethodCreation !== 'manual') {
        return { error: { message: "To use createPaymentMethod with the Payment Element, your elements instance must be created with paymentMethodCreation: 'manual'." } };
      }
      return { paymentMethod: { id: 'pm_test_staff_sale' } };
    },
    handleNextAction: async () => ({}),
  };
}

export function useElements() {
  return { submit: async () => ({}) };
}