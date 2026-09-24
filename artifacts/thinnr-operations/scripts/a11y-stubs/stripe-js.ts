export function loadStripe() { return Promise.resolve({}); }
export type Stripe = { confirmSetup: (input: unknown) => Promise<unknown> };