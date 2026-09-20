import { AsyncLocalStorage } from "node:async_hooks";

export type StripeMode = "test" | "live";
export interface BillingIdentity { mode: StripeMode; platformAccountId: string }
const context = new AsyncLocalStorage<BillingIdentity>();

/** Pin a request/job to its original identity, even if the global mode changes. */
export function runWithBillingIdentity<T>(identity: BillingIdentity, fn: () => T): T {
  return context.run(Object.freeze({ ...identity }), fn);
}
export function currentBillingIdentity(): BillingIdentity | undefined {
  return context.getStore();
}