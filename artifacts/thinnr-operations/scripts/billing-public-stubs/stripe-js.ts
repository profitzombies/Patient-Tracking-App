export interface Stripe {
  confirmPayment(options: unknown): Promise<{ error?: { message?: string } }>;
  createPaymentMethod(options: unknown): Promise<{ paymentMethod?: { id: string }; error?: { message?: string } }>;
  handleNextAction(options: unknown): Promise<{ error?: { message?: string } }>;
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
    createPaymentMethod: async () => ({ paymentMethod: { id: 'pm_test_staff_sale' } }),
    handleNextAction: async () => ({}),
  });
}