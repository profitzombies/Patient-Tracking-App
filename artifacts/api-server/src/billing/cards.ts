import { ensureCustomer } from "./customers";
import { resolvePayer } from "./links";
import { connectedOpts, getPublishableKey, getStripe, isSandbox, isStripeMissing } from "./stripe-client";
import { selectMany, selectOne, type BillingConnectedAccountRow, type BillingPaymentLinkRow, type BillingPayerRow } from "./store";
import type { PatientCard, PatientCardList, PatientCardSetup, ShippingAddress } from "./types";

export class BillingCardError extends Error {
  constructor(message: string, readonly status = 400, readonly field?: string) { super(message); }
}

const enc = encodeURIComponent;
const FALLBACK_ADDRESS: ShippingAddress = {
  name: "", line1: "", line2: null, city: "", state: "", postal_code: "", country: "US", phone: null,
};

/** The patient's Stripe customer on the office's connected account, created on first use. */
export async function patientCustomer(patientId: string, providerId: string, account: BillingConnectedAccountRow): Promise<{ payer: BillingPayerRow; customerId: string }> {
  const payer = await resolvePayer(providerId, { patient_id: patientId } as BillingPaymentLinkRow);
  const lastOrder = await selectOne("billing_orders", `patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(providerId)}&order=created_at.desc`);
  const address = (lastOrder?.shipping_address as unknown as ShippingAddress | undefined) ?? { ...FALLBACK_ADDRESS, name: payer.name };
  const customerId = await ensureCustomer(payer, address, account);
  return { payer, customerId };
}

export function cardDto(method: any, defaultId: string | null): PatientCard {
  return {
    id: method.id, brand: method.card?.brand ?? "card", last4: method.card?.last4 ?? "",
    exp_month: Number(method.card?.exp_month ?? 0), exp_year: Number(method.card?.exp_year ?? 0),
    is_default: method.id === defaultId,
  };
}

async function defaultMethodId(stripe: any, customerId: string, acct: string): Promise<string | null> {
  const customer: any = await stripe.customers.retrieve(customerId, {}, connectedOpts(acct));
  const value = customer?.invoice_settings?.default_payment_method;
  return typeof value === "string" ? value : value?.id ?? null;
}

export async function listCards(customerId: string, account: BillingConnectedAccountRow): Promise<PatientCardList> {
  const stripe = await getStripe();
  const acct = account.stripe_account_id;
  const [methods, defaultId] = await Promise.all([
    stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 20 }, connectedOpts(acct)),
    defaultMethodId(stripe, customerId, acct),
  ]);
  const cards = (methods.data as any[]).map((method) => cardDto(method, defaultId));
  return { cards, default_payment_method_id: defaultId };
}

export async function cardSetup(customerId: string, account: BillingConnectedAccountRow, key: string): Promise<PatientCardSetup> {
  const stripe = await getStripe();
  const intent = await stripe.setupIntents.create({
    customer: customerId, usage: "off_session", payment_method_types: ["card"], metadata: { thinnr_customer: customerId },
  }, connectedOpts(account.stripe_account_id, `card-setup:${customerId}:${key}`));
  if (!intent.client_secret) throw new Error("Card setup could not be initialized.");
  return {
    client_secret: intent.client_secret, stripe_account_id: account.stripe_account_id,
    publishable_key: await getPublishableKey(), sandbox: await isSandbox(),
  };
}

/** Attaches a PaymentMethod the app created on the connected account; refuses cards owned by someone else. */
export async function addCard(customerId: string, account: BillingConnectedAccountRow, paymentMethodId: string, setDefault: boolean): Promise<PatientCardList> {
  const stripe = await getStripe();
  const acct = account.stripe_account_id;
  let method: any;
  try { method = await stripe.paymentMethods.retrieve(paymentMethodId, {}, connectedOpts(acct)); }
  catch (error) {
    if (isStripeMissing(error)) throw new BillingCardError("That card could not be found. Enter it again.", 404, "payment_method_id");
    throw error;
  }
  const owner = typeof method.customer === "string" ? method.customer : method.customer?.id ?? null;
  if (owner && owner !== customerId) throw new BillingCardError("That card belongs to a different account.", 403, "payment_method_id");
  if (!owner) {
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId }, connectedOpts(acct, `card:${customerId}:attach:${paymentMethodId}`));
  }
  const current = await defaultMethodId(stripe, customerId, acct);
  if (setDefault || !current) {
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } }, connectedOpts(acct));
  }
  return listCards(customerId, account);
}

async function ownedMethod(stripe: any, customerId: string, acct: string, paymentMethodId: string): Promise<any> {
  let method: any;
  try { method = await stripe.paymentMethods.retrieve(paymentMethodId, {}, connectedOpts(acct)); }
  catch (error) {
    if (isStripeMissing(error)) throw new BillingCardError("Card not found.", 404);
    throw error;
  }
  const owner = typeof method.customer === "string" ? method.customer : method.customer?.id ?? null;
  if (owner !== customerId) throw new BillingCardError("Card not found.", 404);
  return method;
}

export async function setDefaultCard(customerId: string, account: BillingConnectedAccountRow, paymentMethodId: string): Promise<PatientCardList> {
  const stripe = await getStripe();
  const acct = account.stripe_account_id;
  await ownedMethod(stripe, customerId, acct, paymentMethodId);
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } }, connectedOpts(acct));
  return listCards(customerId, account);
}

/**
 * Detaches a saved card. The last card cannot go while a subscription still
 * renews (Stripe would have nothing to charge); a removed default hands the
 * default to the newest remaining card and to every subscription that used it.
 */
export async function removeCard(patientId: string, customerId: string, account: BillingConnectedAccountRow, paymentMethodId: string): Promise<PatientCardList> {
  const stripe = await getStripe();
  const acct = account.stripe_account_id;
  await ownedMethod(stripe, customerId, acct, paymentMethodId);
  const before = await listCards(customerId, account);
  const active = await selectMany("billing_subscriptions",
    `patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(account.provider_id)}&status=in.(active,past_due,unpaid,incomplete)&cancel_at_period_end=eq.false`);
  if (before.cards.length <= 1 && active.length > 0) {
    throw new BillingCardError("Add another card before removing this one; an active subscription still needs a card.", 409);
  }
  const remaining = before.cards.filter((card) => card.id !== paymentMethodId);
  const next = remaining.find((card) => card.id === before.default_payment_method_id)?.id ?? remaining[0]?.id ?? null;
  // Re-point BEFORE detaching: a subscription may name this card explicitly
  // (subscription-level default) even when it is not the customer default.
  if (next) {
    for (const row of active) {
      if (!row.stripe_subscription_id) continue;
      try {
        const current: any = await stripe.subscriptions.retrieve(row.stripe_subscription_id, {}, connectedOpts(acct));
        const pm = typeof current.default_payment_method === "string" ? current.default_payment_method : current.default_payment_method?.id ?? null;
        if (pm === paymentMethodId) {
          await stripe.subscriptions.update(row.stripe_subscription_id, { default_payment_method: next }, connectedOpts(acct));
        }
      } catch (error) { if (!isStripeMissing(error)) throw error; }
    }
    if (before.default_payment_method_id === paymentMethodId) {
      await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: next } }, connectedOpts(acct));
    }
  }
  await stripe.paymentMethods.detach(paymentMethodId, {}, connectedOpts(acct));
  return listCards(customerId, account);
}
