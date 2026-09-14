import type { BillingConnectedAccountRow } from "./store";
import { update } from "./store";
import type { resolvePayer } from "./links";
import { connectedOpts, getStripe, isStripeMissing } from "./stripe-client";
import type { ShippingAddress } from "./types";

type Payer = Awaited<ReturnType<typeof resolvePayer>>;

/**
 * Returns a Stripe Customer id for the payer on the office's CURRENT connected
 * account. Customer ids only exist on the account they were created on: when
 * an office reconnects a different Stripe account, the stored id is stale and
 * Stripe answers `resource_missing`, so a fresh customer is created there and
 * the payer row is repointed. Any other Stripe failure is surfaced.
 */
export async function ensureCustomer(payer: Payer, address: ShippingAddress, account: BillingConnectedAccountRow): Promise<string> {
  const stripe = await getStripe();
  const acct = account.stripe_account_id;
  const profile = {
    name: payer.name, email: payer.email ?? undefined, phone: payer.phone ?? undefined,
    shipping: { name: address.name, phone: address.phone ?? undefined, address: {
      line1: address.line1, line2: address.line2 ?? undefined, city: address.city, state: address.state,
      postal_code: address.postal_code, country: address.country,
    } },
  };
  if (payer.stripe_customer_id) {
    try {
      await stripe.customers.update(payer.stripe_customer_id, profile, connectedOpts(acct));
      return payer.stripe_customer_id;
    } catch (error) {
      if (!isStripeMissing(error)) throw error;
    }
  }
  const customer = await stripe.customers.create(
    { ...profile, metadata: { thinnr_payer_id: payer.id } },
    connectedOpts(acct, `customer:${payer.id}:${acct}`),
  );
  await update("billing_payers", `id=eq.${encodeURIComponent(payer.id)}`, { stripe_customer_id: customer.id });
  return customer.id;
}
