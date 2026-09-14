export interface Stripe {
  confirmPayment(options: unknown): Promise<{ error?: { message?: string } }>;
}

export interface StripeElementsOptions {
  clientSecret?: string;
  appearance?: unknown;
}

export function loadStripe(publishableKey: string, options?: { stripeAccount?: string }): PromiseLike<Stripe | null> {
  const state = globalThis as typeof globalThis & {
    __billingStripeLoad?: { publishableKey: string; stripeAccount?: string };
  };
  state.__billingStripeLoad = { publishableKey, stripeAccount: options?.stripeAccount };
  return Promise.resolve({
    confirmPayment: async () => ({}),
  });
}