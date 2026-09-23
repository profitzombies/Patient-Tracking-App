/**
 * Registers every billing webhook handler exactly once. Imported by the
 * webhook route (and by tests that want the full handler set).
 *
 * Each module exports a `register<Area>WebhookHandlers()` that calls
 * `onStripeEvent` for the types it owns. Add new modules here.
 */
let registered = false;

export async function registerBillingWebhookHandlers(): Promise<void> {
  if (registered) return;
  registered = true;
  // accounts.ts — account.updated, capability.updated, account.application.deauthorized
  const accounts = await import("./accounts");
  accounts.registerAccountWebhookHandlers();
  // orders.ts — invoice.paid, invoice.payment_failed, payment_intent.payment_failed, charge.refunded, charge.dispute.*
  const orders = await import("./orders");
  orders.registerOrderWebhookHandlers();
  // subscriptions.ts — invoice.created (renewal fee), customer.subscription.updated/deleted
  const subscriptions = await import("./subscriptions");
  subscriptions.registerSubscriptionWebhookHandlers();
  // payouts.ts — payout.paid, payout.failed
  const payouts = await import("./payouts");
  payouts.registerPayoutWebhookHandlers();
  // office-access/webhooks.ts — platform-side access charges: ACH settlement
  // and late failures, card outcomes, disputes, bank verification.
  const officeAccess = await import("./office-access/webhooks");
  officeAccess.registerOfficeAccessWebhookHandlers();
}

/** Test seam: allow a suite to re-register after resetStripeEventHandlers(). */
export function resetBillingWebhookHandlerRegistration(): void {
  registered = false;
}
