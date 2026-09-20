/**
 * Isolated fixture for genuine Stripe TEST app verification.
 *
 * `prepare` writes only local application rows. It never changes Stripe.
 * `preflight` is read-only. Charging is deliberately a separate future command
 * and must not be added without the explicit safety interlocks documented here.
 */
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type Stripe from "stripe";
import { supabaseAdmin } from "../src/lib/supabase-admin";
import { getStripe, getStripeCredentials } from "../src/billing/stripe-client";
import { runWithBillingIdentity, type BillingIdentity } from "../src/billing/stripe-environment";
import { insert, remove, selectMany, selectOne } from "../src/billing/store";

const STATE_PATH = resolve(process.cwd(), "../../.local/state/stripe-app-e2e.json");
const FIXTURE_PREFIX = "stripe-app-e2e-";

interface State {
  created_at: string;
  provider_id: string;
  account_id: string;
  product_id: string;
  link_id: string;
  link_token: string;
  identity: BillingIdentity;
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown error";
  return error.message
    .replace(/\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9]+\b/g, "[redacted key]")
    .replace(/\bwhsec_\S+/g, "[redacted webhook secret]");
}

function load(): State {
  if (!existsSync(STATE_PATH)) throw new Error("Fixture is not prepared.");
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
}

function save(state: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function identity(): Promise<BillingIdentity> {
  const credentials = await getStripeCredentials("test");
  if (!credentials.secret.startsWith("sk_test_") || !credentials.publishable.startsWith("pk_test_")) {
    throw new Error("Refusing: Stripe TEST credentials are not test keys.");
  }
  return { mode: "test", platformAccountId: credentials.account_id };
}

async function enabledAccount(accountId: string): Promise<Stripe.Account> {
  if (!/^acct_[A-Za-z0-9]+$/.test(accountId)) throw new Error("A valid STRIPE_APP_E2E_ACCOUNT_ID is required.");
  const stripe = await getStripe("test");
  const balance = await stripe.balance.retrieve();
  if (balance.livemode !== false) throw new Error("Refusing: Stripe reports live mode.");
  const account = await stripe.accounts.retrieve(accountId);
  if (account.deleted) throw new Error("The selected TEST connected account is deleted.");
  if (!account.charges_enabled || account.capabilities?.card_payments !== "active") {
    throw new Error("The selected TEST connected account cannot accept card payments.");
  }
  if (account.controller?.fees?.payer !== "account"
      || account.controller?.losses?.payments !== "stripe"
      || account.controller?.requirement_collection !== "stripe") {
    throw new Error("The selected TEST account does not use the product's account-fee / Stripe-loss controller.");
  }
  return account;
}

async function prepare(): Promise<void> {
  if (existsSync(STATE_PATH)) throw new Error("Fixture state already exists; use preflight rather than preparing twice.");
  const accountId = process.env.STRIPE_APP_E2E_ACCOUNT_ID?.trim() ?? "";
  const billingIdentity = await identity();
  const account = await enabledAccount(accountId);
  const suffix = crypto.randomBytes(6).toString("hex");
  const providerId = `${FIXTURE_PREFIX}${suffix}`;
  const linkId = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString("base64url");

  // Provider is not a billing-scoped table. This is the only unscoped fixture
  // write; all financial rows below are stamped by the billing store.
  const provider = await supabaseAdmin("POST", "/rest/v1/providers", [{
    provider_id: providerId,
    provider_name: "Synthetic Stripe Verification",
    office_name: "Synthetic Stripe Verification",
    email: `${providerId}@example.invalid`,
    access_disabled: false,
  }], "return=representation");
  if (provider.status >= 300) throw new Error(`Synthetic provider insert failed (${provider.status}).`);

  try {
    const state = await runWithBillingIdentity(billingIdentity, async (): Promise<State> => {
      const product = await selectOne("billing_products", "active=eq.true&status=eq.active&order=sort_order.asc");
      if (!product) throw new Error("No active shared catalog product is available.");
      await insert("billing_connected_accounts", {
        provider_id: providerId,
        stripe_account_id: account.id,
        origin: "oauth",
        dashboard_type: account.controller?.stripe_dashboard?.type === "none" ? "none" : "full",
        charges_enabled: Boolean(account.charges_enabled),
        payouts_enabled: Boolean(account.payouts_enabled),
        details_submitted: Boolean(account.details_submitted),
        requirements: (account.requirements ?? {}) as unknown as Record<string, unknown>,
        capabilities: (account.capabilities ?? {}) as unknown as Record<string, string>,
        default_currency: account.default_currency ?? "usd",
        business_name: "Synthetic Stripe Verification",
        email: `${providerId}@example.invalid`,
        tax_enabled: false,
        tax_last_checked_at: null,
        oauth_refresh_token: null,
        livemode: false,
        last_synced_at: new Date().toISOString(),
        disconnected_at: null,
        stripe_customer_emails: "unverified",
        stripe_customer_emails_checked_at: null,
        stripe_customer_emails_note: "Synthetic TEST fixture; no customer email is deliverable.",
      });
      await insert("billing_office_prices", {
        provider_id: providerId,
        product_id: product.id,
        sell_price_cents: product.floor_price_cents,
        subscription_enabled: true,
        stripe_product_id: null,
        stripe_price_id: null,
        stripe_shipping_price_id: null,
        stripe_cadence_prices: {},
        updated_by: null,
      });
      await insert("billing_payment_links", {
        id: linkId,
        token,
        provider_id: providerId,
        patient_id: null,
        created_by: crypto.randomUUID(),
        label: "Synthetic Stripe app verification",
        active: true,
        expires_at: null,
        uses: 0,
        last_used_at: null,
        product_id: null,
        max_uses: null,
      });
      return {
        created_at: new Date().toISOString(),
        provider_id: providerId,
        account_id: account.id,
        product_id: product.id,
        link_id: linkId,
        link_token: token,
        identity: billingIdentity,
      };
    });
    save(state);
    console.log(JSON.stringify({
      prepared: true,
      state_path: STATE_PATH,
      provider_id: state.provider_id,
      account_controller: {
        dashboard: account.controller?.stripe_dashboard?.type ?? "unknown",
        fees_payer: account.controller?.fees?.payer ?? "unknown",
        losses: account.controller?.losses?.payments ?? "unknown",
        requirement_collection: account.controller?.requirement_collection ?? "unknown",
      },
      stripe_writes: 0,
      charges: 0,
    }, null, 2));
  } catch (error) {
    // Best-effort reverse-order rollback; this provider id belongs only to this
    // fixture. Cleanup failures are left visible through the original error and
    // can be resolved from the printed provider id in a controlled follow-up.
    await runWithBillingIdentity(billingIdentity, async () => {
      await remove("billing_payment_links", `provider_id=eq.${encodeURIComponent(providerId)}`).catch(() => undefined);
      await remove("billing_office_prices", `provider_id=eq.${encodeURIComponent(providerId)}`).catch(() => undefined);
      await remove("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(providerId)}`).catch(() => undefined);
    });
    await supabaseAdmin("DELETE", `/rest/v1/providers?provider_id=eq.${encodeURIComponent(providerId)}`);
    throw error;
  }
}

async function preflight(): Promise<void> {
  const state = load();
  const billingIdentity = await identity();
  if (state.identity.mode !== "test" || state.identity.platformAccountId !== billingIdentity.platformAccountId) {
    throw new Error("Fixture identity does not match the configured TEST platform.");
  }
  const account = await enabledAccount(state.account_id);
  const result = await runWithBillingIdentity(billingIdentity, async () => {
    const [connected, price, link] = await Promise.all([
      selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(state.provider_id)}`),
      selectOne("billing_office_prices", `provider_id=eq.${encodeURIComponent(state.provider_id)}&product_id=eq.${encodeURIComponent(state.product_id)}`),
      selectOne("billing_payment_links", `id=eq.${encodeURIComponent(state.link_id)}`),
    ]);
    return {
      connected: Boolean(connected?.charges_enabled && connected.livemode === false
        && connected.stripe_mode === "test" && connected.stripe_platform_account_id === billingIdentity.platformAccountId),
      price: Boolean(price?.subscription_enabled),
      link: Boolean(link?.active && !link.expires_at),
    };
  });
  console.log(JSON.stringify({
    "ready_for_safety-review": result.connected && result.price && result.link,
    application_fixture: result,
    stripe: {
      test_mode: true,
      charges_enabled: Boolean(account.charges_enabled),
      card_payments: account.capabilities?.card_payments ?? "unknown",
      controller_matches: true,
    },
    outbound_guard_required_before_charge: true,
    next_step: "Do not charge until the parent confirms the guarded API build is running locally.",
  }, null, 2));
}

async function cleanup(): Promise<void> {
  const state = load();
  const billingIdentity = await identity();
  if (state.identity.mode !== "test" || state.identity.platformAccountId !== billingIdentity.platformAccountId) {
    throw new Error("Refusing cleanup: fixture identity does not match the configured TEST platform.");
  }
  await runWithBillingIdentity(billingIdentity, async () => {
    const order = await selectOne("billing_orders", `provider_id=eq.${encodeURIComponent(state.provider_id)}`);
    if (order) {
      throw new Error("Refusing simple cleanup: financial test rows now exist; use the post-run cleanup plan.");
    }
    await remove("billing_payment_links", `provider_id=eq.${encodeURIComponent(state.provider_id)}`);
    await remove("billing_office_prices", `provider_id=eq.${encodeURIComponent(state.provider_id)}`);
    await remove("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(state.provider_id)}`);
  });
  const provider = await supabaseAdmin("DELETE", `/rest/v1/providers?provider_id=eq.${encodeURIComponent(state.provider_id)}`);
  if (provider.status >= 300) throw new Error(`Synthetic provider cleanup failed (${provider.status}).`);
  unlinkSync(STATE_PATH);
  console.log(JSON.stringify({ cleaned: true, stripe_writes: 0, charges: 0 }, null, 2));
}

/** Removes only this synthetic scope after independently verifying all money is unwound. */
async function cleanupFinancial(): Promise<void> {
  if (process.env.RUN_STRIPE_APP_E2E !== "authorized") throw new Error("Explicit cleanup authorization is absent.");
  const state = load();
  const configured = await identity();
  if (!state.provider_id.startsWith(FIXTURE_PREFIX) || state.identity.mode !== "test"
      || configured.platformAccountId !== state.identity.platformAccountId) throw new Error("Cleanup identity mismatch.");
  await enabledAccount(state.account_id);
  const stripe = await getStripe("test");
  const opts = { stripeAccount: state.account_id };
  const q = `provider_id=eq.${encodeURIComponent(state.provider_id)}`;
  await runWithBillingIdentity(state.identity, async () => {
    const orders = await selectMany("billing_orders", q);
    for (const sub of await selectMany("billing_subscriptions", q)) {
      const remote = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, {}, opts);
      if (remote.livemode || remote.status !== "canceled") throw new Error("Subscription is not safely canceled.");
    }
    for (const order of orders) {
      if (order.livemode) throw new Error("Live order found in fixture.");
      if (order.stripe_charge_id) {
        const charge = await stripe.charges.retrieve(order.stripe_charge_id, {}, opts);
        if (charge.livemode || !charge.refunded) throw new Error("Charge is not fully refunded.");
        const feeId = typeof charge.application_fee === "string" ? charge.application_fee : charge.application_fee?.id;
        if (feeId) {
          const fee = await stripe.applicationFees.retrieve(feeId);
          if (fee.livemode || fee.account !== state.account_id) throw new Error("Application fee scope mismatch.");
          if (fee.amount_refunded < fee.amount) await stripe.applicationFees.createRefund(fee.id, {
            amount: fee.amount - fee.amount_refunded,
          }, { idempotencyKey: `e2e-cleanup-fee:${fee.id}` });
        }
      } else if (order.stripe_payment_intent_id) {
        const pi = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id, {}, opts);
        if (pi.livemode || pi.status !== "canceled") throw new Error("Unpaid payment intent not canceled.");
      }
    }
    for (const payer of await selectMany("billing_payers", q)) {
      if (!payer.stripe_customer_id) continue;
      const customer = await stripe.customers.retrieve(payer.stripe_customer_id, {}, opts);
      if (!customer.deleted) {
        if (customer.livemode) throw new Error("Live customer in fixture.");
        await stripe.customers.del(customer.id, {}, opts);
      }
    }
    for (const price of await selectMany("billing_office_prices", q)) {
      const productIds = new Set<string>();
      if (price.stripe_product_id) productIds.add(price.stripe_product_id);
      if (price.stripe_shipping_price_id) {
        const shipping = await stripe.prices.retrieve(price.stripe_shipping_price_id, {}, opts);
        if (shipping.livemode) throw new Error("Live shipping price in fixture.");
        productIds.add(typeof shipping.product === "string" ? shipping.product : shipping.product.id);
      }
      for (const productId of productIds) {
        for await (const remote of stripe.prices.list({ product: productId, limit: 100 }, opts)) {
          if (remote.livemode) throw new Error("Live price in fixture.");
          if (remote.active) await stripe.prices.update(remote.id, { active: false }, opts);
        }
        await stripe.products.update(productId, { active: false }, opts);
      }
    }
    for (const order of orders) {
      const oq = `order_id=eq.${encodeURIComponent(order.id)}`;
      await remove("billing_refunds", oq);
      await remove("billing_disputes", oq);
      await remove("billing_ledger", oq);
      await remove("billing_warehouse_submissions", oq);
      await remove("billing_shipments", oq);
      await remove("billing_order_items", oq);
    }
    await remove("billing_ledger", q);
    await remove("billing_customer_emails", q);
    await remove("billing_orders", q);
    await remove("billing_subscriptions", q);
    await remove("billing_payers", q);
    await remove("billing_payment_links", q);
    await remove("billing_office_prices", q);
    await remove("billing_account_events", q);
    await remove("billing_connected_accounts", q);
  });
  const provider = await supabaseAdmin("DELETE", `/rest/v1/providers?provider_id=eq.${encodeURIComponent(state.provider_id)}`);
  if (provider.status >= 300) throw new Error("Synthetic provider cleanup failed.");
  unlinkSync(STATE_PATH);
  console.log(JSON.stringify({ cleaned: true, remote_money_verified_unwound: true, retained: "immutable Stripe test history and webhook audit" }));
}

/**
 * Locally signs an account.updated payload with the configured TEST Connect
 * secret. This proves the local signature/dispatch/store path, not delivery by
 * Stripe. It performs no Stripe write and is restricted to a loopback origin.
 */
async function localWebhookProbe(): Promise<void> {
  const state = load();
  const billingIdentity = await identity();
  if (state.identity.mode !== "test" || state.identity.platformAccountId !== billingIdentity.platformAccountId) {
    throw new Error("Fixture identity does not match the configured TEST platform.");
  }
  const rawOrigin = process.env.BILLING_E2E_LOCAL_ORIGIN?.trim() ?? "";
  const origin = new URL(rawOrigin);
  if (!["localhost", "127.0.0.1", "::1"].includes(origin.hostname) || origin.protocol !== "http:") {
    throw new Error("BILLING_E2E_LOCAL_ORIGIN must be an HTTP loopback origin.");
  }
  const signingSecret = process.env.STRIPE_TEST_CONNECT_WEBHOOK_SECRET?.trim();
  if (!signingSecret?.startsWith("whsec_")) throw new Error("TEST Connect webhook signing secret is unavailable.");
  const account = await enabledAccount(state.account_id);
  const eventId = `evt_e2e_${crypto.randomBytes(12).toString("hex")}`;
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    api_version: "2026-03-25.preview",
    created: Math.floor(Date.now() / 1000),
    data: { object: account },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: "account.updated",
    account: account.id,
  });
  const stripe = await getStripe("test");
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: signingSecret });
  const response = await fetch(`${origin.origin}/api/billing/webhooks/test/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: payload,
  });
  if (!response.ok) throw new Error(`Local signed webhook probe failed (HTTP ${response.status}).`);
  const row = await runWithBillingIdentity(billingIdentity, () =>
    selectOne("billing_webhook_events", `stripe_event_id=eq.${encodeURIComponent(eventId)}`));
  if (!row?.processed_at || row.error) throw new Error("Local signed webhook was not recorded as processed.");
  console.log(JSON.stringify({
    processed: true,
    kind: "connect",
    type: "account.updated",
    stripe_delivery: false,
    stripe_writes: 0,
    note: "Controlled local signature/dispatch proof only.",
  }, null, 2));
}

const command = process.argv[2] ?? "preflight";
const work = command === "prepare" ? prepare()
  : command === "preflight" ? preflight()
    : command === "cleanup" ? cleanup()
      : command === "cleanup-financial" ? cleanupFinancial()
      : command === "local-webhook-probe" ? localWebhookProbe()
        : Promise.reject(new Error("usage: stripe-app-e2e-fixture.mts prepare|preflight|local-webhook-probe|cleanup"));
work.catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});