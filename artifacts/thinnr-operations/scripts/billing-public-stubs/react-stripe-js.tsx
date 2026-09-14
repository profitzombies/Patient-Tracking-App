import React, { type ReactNode } from 'react';

export function Elements({ children, options }: { children: ReactNode; stripe: unknown; options: { clientSecret?: string } }) {
  const state = globalThis as typeof globalThis & { __billingElementsSecret?: string };
  state.__billingElementsSecret = options.clientSecret;
  return <div data-testid="elements-stub">{children}</div>;
}

export function PaymentElement() {
  return <div data-testid="payment-element-stub" />;
}

export function useStripe() {
  return { confirmPayment: async () => ({}) };
}

export function useElements() {
  return {};
}