/**
 * Genuine, isolated patient session for a development-only checkout cold start.
 * No confirmations/charges. Session material stays in a private local file;
 * browser tooling reads it directly rather than exposing a public helper URL.
 * Commands: prepare | status | cleanup. Run from artifacts/api-server.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { supabaseAdmin, supabaseBase, serviceKey } from "../src/lib/supabase-admin";
import { getStripe, getStripeCredentials } from "../src/billing/stripe-client";
import { runWithBillingIdentity, type BillingIdentity } from "../src/billing/stripe-environment";
import { selectMany, selectOne, update } from "../src/billing/store";
import { liveBillingEffectsAllowed } from "../src/billing/lifecycle-scopes";
import { CONSENT_POLICY_VERSION } from "../src/privacy/consent";

const path = "/tmp/thinnr-patient-checkout-browser-fixture.json";
interface State {
  provider: string; patient: string; user: string; identity: BillingIdentity;
  ownsProvider?: boolean;
  retryCart?: string;
  retryMethod?: string;
  storage?: Record<string, string>;
}
const save = (state: State) => writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
const load = (): State => JSON.parse(readFileSync(path, "utf8"));
async function rest(method: string, route: string, body?: unknown) {
  const result = await supabaseAdmin(method, route, body, "return=representation");
  if (result.status >= 300) throw new Error(`Fixture database operation failed: ${method} ${route.split("?")[0]} (${result.status}).`);
  return result.json;
}
async function auth(route: string, body?: unknown, method = "POST") {
  const response = await fetch(`${supabaseBase()}/auth/v1/${route}`, {
    method, headers: { apikey: serviceKey(), Authorization: `Bearer ${serviceKey()}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Fixture authentication operation failed (${response.status}).`);
  return response.json();
}
async function guard(state?: State) {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixture only.");
  const keys = await getStripeCredentials("test");
  if (!keys.secret.startsWith("sk_test_") || !keys.publishable.startsWith("pk_test_")) throw new Error("TEST keys required.");
  if (state && (state.identity.mode !== "test" || state.identity.platformAccountId !== keys.account_id
    || !(state.ownsProvider === false ? /^stripe-app-e2e-[a-f0-9]+$/ : /^browser-checkout-[a-f0-9]+$/).test(state.provider))) throw new Error("Fixture identity mismatch.");
  const stripe = await getStripe("test");
  if ((await stripe.balance.retrieve()).livemode !== false) throw new Error("TEST Stripe balance required.");
  return { mode: "test" as const, platformAccountId: keys.account_id };
}
async function prepare() {
  if (existsSync(path)) throw new Error("Fixture already exists; cleanup first.");
  // Require the management credential up front: teardown must be available.
  if (!process.env.SUPABASE_ACCESS_TOKEN) throw new Error("SUPABASE_ACCESS_TOKEN required for atomic fixture teardown.");
  const identity = await guard();
  await runWithBillingIdentity(identity, async () => {
    const source = await selectOne("billing_connected_accounts", "charges_enabled=eq.true&livemode=eq.false&disconnected_at=is.null");
    if (!source) throw new Error("No current-platform enabled TEST connected account available.");
    if (!/^stripe-app-e2e-[a-f0-9]+$/.test(source.provider_id)) throw new Error("Only the explicitly synthetic sandbox provider may be reused.");
    const stripe = await getStripe("test");
    const account = await stripe.accounts.retrieve(source.stripe_account_id);
    if (account.deleted || !account.charges_enabled || account.controller?.fees?.payer !== "account"
      || account.controller?.losses?.payments !== "stripe") throw new Error("TEST account guard failed.");
    const product = await selectOne("billing_products", "active=eq.true&status=eq.active&order=sort_order.asc");
    if (!product) throw new Error("Active catalog product required.");
    const state: State = { provider: source.provider_id, patient: randomUUID(), user: "", identity, ownsProvider: false };
    save(state);
    const email = `browser-checkout-${randomBytes(12).toString("hex")}@example.invalid`;
    const password = `Tmp!${randomBytes(28).toString("base64url")}5a`;
    const user = await auth("admin/users", { email, password, email_confirm: true,
      app_metadata: { fixture: "patient-checkout-browser" }, user_metadata: { display_name: "Synthetic Browser Patient" } });
    state.user = user.id; save(state);
    const now = new Date().toISOString();
    await rest("POST", "/rest/v1/patients", [{ id: state.patient, auth_user_id: state.user, provider_id: state.provider,
      name: "Synthetic Browser Patient", first_name: "Synthetic", last_name: "Browser", email, phone: null,
      activation_status: "activated", created_at: now, profile_completed_at: now, timezone: "America/New_York" }]);
    await rest("POST", "/rest/v1/patient_flags", [{ patient_id: state.patient, onboarding_complete: true }]);
    await rest("POST", "/rest/v1/patient_consents", [{ patient_id: state.patient, policy_version: CONSENT_POLICY_VERSION,
      terms_accepted: true, privacy_accepted: true, health_data_accepted: true, photo_analysis_accepted: false,
      app_version: "synthetic-browser-fixture", platform: "server" }]);
    const session = await auth("token?grant_type=password", { email, password });
    if (!session.access_token || !session.refresh_token || session.user?.id !== state.user) throw new Error("Invalid genuine session.");
    session.expires_at ??= Math.floor(Date.now() / 1000) + session.expires_in;
    const key = `sb-${new URL(supabaseBase()).hostname.split(".")[0]}-auth-token`;
    state.storage = { [key]: JSON.stringify(session), thinnr_app_mode_v1: "patient" };
    save(state);
    console.log(JSON.stringify({ ready: true, privateStorageFile: path, patient: state.patient, provider: state.provider,
      product: product.id, instructions: "Read storage privately in browser tooling; seed localStorage on Expo origin then reload /shop. Never log storage values. No charge confirmation." }));
  });
}
async function cleanup() {
  if (!existsSync(path)) { console.log("Fixture absent."); return; }
  const state = load();
  await guard(state);
  await runWithBillingIdentity(state.identity, async () => {
    const orders = await selectMany("billing_orders", `provider_id=eq.${state.provider}&patient_id=eq.${state.patient}`);
    if (orders.some(row => !["pending", "failed", "canceled"].includes(row.status))) throw new Error("Financial activity exists: explicit payment cleanup required.");
    const subscriptions = await selectMany("billing_subscriptions", `provider_id=eq.${state.provider}&patient_id=eq.${state.patient}`);
    if (subscriptions.length) throw new Error("Unexpected subscriptions: explicit payment cleanup required.");
    const stripe = await getStripe("test");
    const account = await selectOne("billing_connected_accounts", `provider_id=eq.${state.provider}`);
    for (const order of orders) {
      if (!order.stripe_payment_intent_id || !account) continue;
      const pi = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id, {}, { stripeAccount: account.stripe_account_id });
      if (pi.livemode || !["requires_payment_method", "requires_confirmation", "requires_action", "canceled"].includes(pi.status)) {
        throw new Error("Unexpected PaymentIntent status: manual safe cleanup required.");
      }
      if (pi.status !== "canceled") {
        if (order.stripe_invoice_id) {
          const invoice = await stripe.invoices.retrieve(order.stripe_invoice_id, {}, { stripeAccount: account.stripe_account_id });
          if (invoice.status === "open") await stripe.invoices.voidInvoice(invoice.id, {}, { stripeAccount: account.stripe_account_id });
          else if (invoice.status !== "void") throw new Error("Unexpected invoice status during safe cleanup.");
        } else await stripe.paymentIntents.cancel(pi.id, {}, { stripeAccount: account.stripe_account_id });
      }
    }
    const payers = await selectMany("billing_payers", `provider_id=eq.${state.provider}&patient_id=eq.${state.patient}`);
    for (const payer of payers) if (payer.stripe_customer_id && account) {
      await stripe.customers.del(payer.stripe_customer_id, {}, { stripeAccount: account.stripe_account_id });
    }
  });
  // Unique fixture IDs only. Replication-role switch is transaction-local to
  // remove immutable synthetic audit rows without altering real patient data.
  if (!/^[a-f0-9-]{36}$/.test(state.patient)) throw new Error("Invalid fixture UUID.");
  const query = `begin; set local session_replication_role=replica;
do $$ declare t text; begin
for t in select table_name from information_schema.columns where table_schema='public' and column_name='order_id' and table_name like 'billing_%' loop
execute format('delete from public.%I where order_id in (select id from billing_orders where patient_id=$1)',t) using '${state.patient}'::uuid; end loop;
for t in select table_name from information_schema.columns where table_schema='public' and column_name='patient_id' and table_name <> 'patients' loop
execute format('delete from public.%I where patient_id=$1',t) using '${state.patient}'::uuid; end loop;
${state.ownsProvider === false ? "" : `for t in select table_name from information_schema.columns where table_schema='public' and column_name='provider_id' and table_name like 'billing_%' loop
execute format('delete from public.%I where provider_id::text=$1',t) using '${state.provider}'; end loop;
delete from providers where provider_id='${state.provider}';`}
delete from patients where id='${state.patient}'::uuid;
end $$; commit;`;
  const response = await fetch(`https://api.supabase.com/v1/projects/${new URL(supabaseBase()).hostname.split(".")[0]}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error(`Atomic cleanup failed (${response.status}).`);
  if (state.user) await auth(`admin/users/${state.user}`, undefined, "DELETE");
  unlinkSync(path);
  console.log("Synthetic patient, session, and fixture file removed; shared provider untouched.");
}
async function verifyRetry() {
  if (process.env.BROWSER_FIXTURE_RELEASED !== "authorized") throw new Error("Wait for browser release and set BROWSER_FIXTURE_RELEASED=authorized.");
  const state = load(); await guard(state);
  const session = JSON.parse(Object.entries(state.storage ?? {}).find(([key]) => key.startsWith("sb-"))?.[1] ?? "{}");
  if (session.user?.id !== state.user || !session.access_token) throw new Error("Genuine session unavailable.");
  const origin = "http://localhost";
  const request = async (route: string, body?: unknown, cart?: string) => {
    const response = await fetch(`${origin}/api/patient-data/billing/${route}`, {
      method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${session.access_token}`,
        "X-Billing-Scope": `${state.identity.mode}:${state.identity.platformAccountId}`,
        "Content-Type": "application/json", ...(cart ? { "Idempotency-Key": cart } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  await runWithBillingIdentity(state.identity, async () => {
    if (liveBillingEffectsAllowed()) throw new Error("TEST outbound guard failed.");
    const account = await selectOne("billing_connected_accounts", `provider_id=eq.${state.provider}`);
    if (!account || account.livemode) throw new Error("TEST fixture account missing.");
    const shop = await request("shop");
    if (shop.status !== 200 || !shop.body.sandbox || shop.body.stripe_account_id !== account.stripe_account_id) throw new Error("Authenticated TEST storefront guard failed.");
    // Browser card setup must already have created this patient's payer. Blank
    // contact prevents even an older receipt worker reaching a transport.
    const payer = await selectOne("billing_payers", `patient_id=eq.${state.patient}&provider_id=eq.${state.provider}`);
    if (!payer) throw new Error("Patient payer missing; do not create an unsafe charge path.");
    await update("billing_payers", `id=eq.${payer.id}`, { email: "", phone: null });
    const verified = await selectOne("billing_payers", `id=eq.${payer.id}`);
    if (verified?.email !== "" || verified.phone !== null) throw new Error("Contact suppression failed.");
    const lines = [{ product_id: shop.body.products[0]?.product_id ?? shop.body.products[0]?.id, quantity: 1, purchase: "one_time" }];
    const shipping_address = { name: "Synthetic Browser Patient", line1: "510 Townsend St", line2: null,
      city: "San Francisco", state: "CA", postal_code: "94103", country: "US", phone: null };
    const quote = await request("cart/quote", { lines, shipping_address });
    if (quote.status !== 200 || !Number.isInteger(quote.body.total_due_cents)) throw new Error("Authenticated quote unavailable.");
    const stripe = await getStripe("test");
    const opts = { stripeAccount: account.stripe_account_id };
    if (state.retryCart && !state.retryMethod) {
      const previous = await selectMany("billing_carts", `id=eq.${state.retryCart}`);
      if (previous.length) throw new Error("Previous cart exists without saved method; inspect manually.");
    }
    const method = state.retryMethod ? await stripe.paymentMethods.retrieve(state.retryMethod, {}, opts)
      : await stripe.paymentMethods.create({ type: "card", card: { token: "tok_threeDSecure2Required" } }, opts);
    if (method.livemode) throw new Error("TEST payment method required.");
    state.retryCart ??= randomUUID(); state.retryMethod = method.id; save(state);
    const payload = { lines, shipping_address, payment_method_id: method.id, expected_total_due_cents: quote.body.total_due_cents };
    const responses = await Promise.all([request("cart/checkout", payload, state.retryCart), request("cart/checkout", payload, state.retryCart)]);
    // Deliberately discard the first checkout bodies; retry as a client that
    // never received them. This proves response-loss replay, not socket loss.
    const replay = await request("cart/checkout", payload, state.retryCart);
    const orders = await selectMany("billing_orders", `patient_id=eq.${state.patient}&cart_id=eq.${state.retryCart}`);
    const intents = [];
    for (const order of orders) {
      if (!order.stripe_payment_intent_id) continue;
      const intent = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id, {}, opts);
      if (intent.livemode) throw new Error("Unexpected LIVE intent.");
      if (intent.status === "succeeded") {
        await stripe.refunds.create({ payment_intent: intent.id, refund_application_fee: true }, { ...opts, idempotencyKey: `browser-retry-unexpected:${intent.id}` });
        throw new Error("Auth-required card unexpectedly succeeded; TEST payment refunded.");
      }
      intents.push({ id: intent.id, status: intent.status });
    }
    const count = await selectMany("billing_carts", `id=eq.${state.retryCart}&patient_id=eq.${state.patient}`);
    const evidence = { concurrent_statuses: responses.map(value => value.status), replay_status: replay.status,
      errors: responses.map(value => value.body.error ?? null), replay_error: replay.body.error ?? null,
      replay_checkout_status: replay.body.status, cart_count: count.length, order_count: orders.length,
      intent_statuses: intents.map(value => value.status), same_order_on_replay: Boolean(orders[0]?.id && replay.body.items?.[0]?.order_id === orders[0].id),
      scope: "genuine authenticated TEST endpoint; discarded-response replay; no challenge completion" };
    writeFileSync("/tmp/thinnr-patient-checkout-retry-evidence.json", JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(evidence));
    if (count.length !== 1 || orders.length !== 1 || intents.length !== 1 || intents[0].status !== "requires_action"
      || replay.status !== 200 || !evidence.same_order_on_replay || !responses.some(value => value.status === 200)
      || responses.some(value => ![200, 409].includes(value.status))) throw new Error("Retry assertions did not pass; inspect sanitized evidence.");
  });
}
try {
  const command = process.argv[2];
  if (command === "prepare") await prepare();
  else if (command === "cleanup") await cleanup();
  else if (command === "verify-retry") await verifyRetry();
  else if (command === "status") {
    const state = load(); await guard(state);
    console.log(JSON.stringify({ patient: state.patient, provider: state.provider, sessionPrepared: Boolean(state.storage) }));
  } else throw new Error("Use prepare|status|verify-retry|cleanup.");
} catch (error) {
  // Do not print remote errors or session-bearing payloads.
  console.error(error instanceof Error ? error.message.replace(/\b(?:sk|pk)_(?:test|live)_\w+/g, "[redacted]") : "Fixture failed.");
  process.exitCode = 1;
}