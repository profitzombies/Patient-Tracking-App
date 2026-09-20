import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getStripe, connectedOpts, getStripeCredentials } from "../src/billing/stripe-client";
import { runWithBillingIdentity } from "../src/billing/stripe-environment";
import { selectMany, selectOne, update } from "../src/billing/store";
import { refundOrder } from "../src/billing/orders";
import { cancelSubscription } from "../src/billing/subscriptions";
import { liveBillingEffectsAllowed } from "../src/billing/lifecycle-scopes";

const STATE_PATH = resolve(process.cwd(), "../../.local/state/stripe-app-e2e.json");
const RESULT_PATH = resolve(process.cwd(), "../../.local/state/stripe-app-e2e-result.json");
const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as {
  provider_id: string; account_id: string; product_id: string; link_token: string;
  identity: { mode: "test"; platformAccountId: string };
};
const origin = "http://localhost";
const result: Record<string, unknown> = { started_at: new Date().toISOString(), orders: [] as unknown[] };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function safeError(error: unknown): string {
  const value = error as { type?: string; code?: string; message?: string };
  return [value?.type, value?.code, value?.message ?? "Unknown error"].filter(Boolean).join(" · ")
    .replace(/\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9]+\b/g, "[redacted key]")
    .replace(/\bwhsec_\S+/g, "[redacted secret]");
}

export async function guard(): Promise<void> {
  if (process.env.RUN_STRIPE_APP_E2E !== "authorized") throw new Error("Explicit run authorization is absent.");
  const credentials = await getStripeCredentials("test");
  if (!credentials.secret.startsWith("sk_test_") || !credentials.publishable.startsWith("pk_test_")
      || credentials.account_id !== state.identity.platformAccountId || state.identity.mode !== "test") {
    throw new Error("TEST identity guard failed.");
  }
  const stripe = await getStripe("test");
  if ((await stripe.balance.retrieve()).livemode !== false) throw new Error("Stripe reports live mode.");
  const account = await stripe.accounts.retrieve(state.account_id);
  if (account.deleted || !account.charges_enabled || account.capabilities?.card_payments !== "active") {
    throw new Error("Connected TEST account is not charge-capable.");
  }
  if (account.controller?.fees?.payer !== "account" || account.controller?.losses?.payments !== "stripe"
      || account.controller?.requirement_collection !== "stripe") throw new Error("Controller guard failed.");
  await runWithBillingIdentity(state.identity, async () => {
    if (liveBillingEffectsAllowed()) throw new Error("Outbound effects are not suppressed.");
    const row = await selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(state.provider_id)}`);
    if (!row || row.stripe_account_id !== state.account_id || row.livemode || !row.charges_enabled) {
      throw new Error("Scoped fixture account guard failed.");
    }
  });
  const config = await fetch(`${origin}/api/billing/public/config`);
  if (!config.ok || (await config.json() as { sandbox?: boolean }).sandbox !== true) {
    throw new Error("The running local API does not report sandbox mode.");
  }
}

export async function create(purchase: "one_time" | "subscription") {
  const response = await fetch(`${origin}/api/billing/public/links/${state.link_token}/orders`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [{ product_id: state.product_id, quantity: 1 }],
      purchase,
      payer: { name: "Synthetic Stripe Verification", email: "stripe-app-e2e@example.invalid", phone: "" },
      shipping_address: {
        name: "Synthetic Stripe Verification", line1: "510 Townsend St", line2: null,
        city: "San Francisco", state: "CA", postal_code: "94103", country: "US", phone: null,
      },
    }),
  });
  const body = await response.json() as {
    error?: string; order_id: string; client_secret: string; stripe_account_id: string;
    sandbox: boolean; subscription?: unknown;
  };
  if (!response.ok) throw new Error(`Checkout initialization failed (${response.status}): ${body.error ?? "unknown"}`);
  if (!body.sandbox || body.stripe_account_id !== state.account_id) throw new Error("Checkout returned the wrong Stripe scope.");
  const order = await runWithBillingIdentity(state.identity, () =>
    selectOne("billing_orders", `id=eq.${encodeURIComponent(body.order_id)}`));
  if (!order || order.provider_id !== state.provider_id || order.livemode) throw new Error("Created order scope is invalid.");
  await runWithBillingIdentity(state.identity, () =>
    update("billing_payers", `id=eq.${encodeURIComponent(order.payer_id)}&provider_id=eq.${encodeURIComponent(state.provider_id)}`, {
      // The legacy schema keeps email NOT NULL. Empty string is the only
      // database-valid non-address and `receipts.deliver` returns on `!to`
      // before calling the transport in both the old and guarded builds.
      email: "", phone: null,
    }));
  const payer = await runWithBillingIdentity(state.identity, () =>
    selectOne("billing_payers", `id=eq.${encodeURIComponent(order.payer_id)}`));
  if (!payer || payer.email !== "" || payer.phone !== null) {
    throw new Error("Refusing confirmation: synthetic payer contact could not be made non-deliverable.");
  }
  return { body, order };
}

export async function waitOrder(id: string, statuses: string[], timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  do {
    const row = await runWithBillingIdentity(state.identity, () =>
      selectOne("billing_orders", `id=eq.${encodeURIComponent(id)}`));
    if (row && statuses.includes(row.status)) return row;
    await sleep(2_000);
  } while (Date.now() < end);
  throw new Error(`Timed out waiting for order ${statuses.join("/")}.`);
}

export async function confirm(clientSecret: string, paymentMethod: string) {
  const id = clientSecret.split("_secret_")[0];
  if (!id.startsWith("pi_")) throw new Error("Checkout did not return a PaymentIntent secret.");
  return (await getStripe("test")).paymentIntents.confirm(
    id, { payment_method: paymentMethod }, connectedOpts(state.account_id),
  );
}

if (process.env.STRIPE_APP_E2E_IMPORT_ONLY !== "1") {
await guard();
const stripe = await getStripe("test");
try {
  const success = await create("one_time");
  const paidIntent = await confirm(success.body.client_secret, "pm_card_visa");
  if (paidIntent.livemode || paidIntent.status !== "succeeded") throw new Error("TEST success payment did not succeed.");
  const paid = await waitOrder(success.body.order_id, ["paid"]);
  (result.orders as unknown[]).push({ id: paid.id, kind: "one_time", status: paid.status });
  await runWithBillingIdentity(state.identity, () =>
    refundOrder(paid.id, { amount_cents: paid.total_cents, reason: "Synthetic verification cleanup" }, null));
  const refunded = await waitOrder(paid.id, ["refunded"]);
  (result.orders as unknown[]).push({ id: refunded.id, kind: "one_time_refund", status: refunded.status });

  const decline = await create("one_time");
  try {
    await confirm(decline.body.client_secret, "pm_card_chargeDeclined");
    throw new Error("Decline test unexpectedly succeeded.");
  } catch (error) {
    if ((error as { type?: string }).type !== "StripeCardError") throw error;
    (result as { decline?: unknown }).decline = { stripe: "declined" };
  }
  const failed = await waitOrder(decline.body.order_id, ["failed"]);
  (result.orders as unknown[]).push({ id: failed.id, kind: "decline", status: failed.status });

  const subscription = await create("subscription");
  const subIntent = await confirm(subscription.body.client_secret, "pm_card_visa");
  if (subIntent.livemode || subIntent.status !== "succeeded") throw new Error("TEST subscription payment did not succeed.");
  const subOrder = await waitOrder(subscription.body.order_id, ["paid"]);
  const sub = await runWithBillingIdentity(state.identity, () =>
    selectOne("billing_subscriptions", `id=eq.${encodeURIComponent(subOrder.subscription_id ?? "")}`));
  if (!sub || sub.status !== "active") throw new Error("Paid subscription did not become active.");
  await runWithBillingIdentity(state.identity, () => cancelSubscription(sub.id, { at_period_end: false }));
  await runWithBillingIdentity(state.identity, () =>
    refundOrder(subOrder.id, { amount_cents: subOrder.total_cents, reason: "Synthetic verification cleanup" }, null));
  const subRefund = await waitOrder(subOrder.id, ["refunded"]);
  (result.orders as unknown[]).push({ id: subRefund.id, kind: "subscription_initial", status: subRefund.status, subscription: "canceled" });

  const ids = (result.orders as Array<{ id: string }>).map((row) => row.id);
  const events = await runWithBillingIdentity(state.identity, () =>
    selectMany("billing_webhook_events", `account=eq.${encodeURIComponent(state.account_id)}&received_at=gte.${encodeURIComponent(String(result.started_at))}`));
  const actual = events.filter((event) => event.processed_at && !event.error && [
    "invoice.paid", "payment_intent.payment_failed", "charge.refunded", "customer.subscription.updated",
  ].includes(event.type));
  result.webhooks = { processed_types: [...new Set(actual.map((event) => event.type))].sort(), count: actual.length };
  result.email_claims = (await runWithBillingIdentity(state.identity, () =>
    selectMany("billing_customer_emails", `provider_id=eq.${encodeURIComponent(state.provider_id)}`))).length;
  result.warehouse = (await runWithBillingIdentity(state.identity, () =>
    selectMany("billing_warehouse_submissions", `provider_id=eq.${encodeURIComponent(state.provider_id)}`)))
    .map((row) => ({ state: row.state, reason: row.skipped_reason }));
  result.completed_at = new Date().toISOString();
  result.order_ids = ids;
  writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({
    success: true,
    flows: ["payment", "decline", "refund", "subscription", "subscription_cancel", "subscription_refund"],
    actual_processed_webhook_types: (result.webhooks as { processed_types: string[] }).processed_types,
    email_claims: result.email_claims,
    warehouse: result.warehouse,
    result_path: RESULT_PATH,
  }, null, 2));
} catch (error) {
  result.error = safeError(error);
  result.failed_at = new Date().toISOString();
  writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.error(safeError(error));
  process.exitCode = 1;
}
}