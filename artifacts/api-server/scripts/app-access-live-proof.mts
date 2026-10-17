/**
 * App-access subscription live proof (Stripe TEST, development Supabase).
 *
 * One throwaway office with a platform-controlled TEST connected account and
 * one throwaway patient on a non-THINNR program with a 0-day trial, so the
 * patient is LOCKED the moment the office turns charging on. The proof then
 * drives the real HTTP surface:
 *
 *   entitlement read (locked + checkout link) → premium route refuses 402 →
 *   public pay page preview → checkout on the connected account → first
 *   invoice paid with a test card → lifecycle lands (order paid, subscription
 *   active) → entitlement available/subscribed → premium route open → the
 *   app subscription in the patient's list → patient cancels at period end
 *   (still covered, staff state "canceling") → Stripe ends it → "lapsed"
 *   once the paid period is over.
 *
 * Stripe TEST keys only (asserted), no warehouse or email is ever involved
 * (the product kind ships nothing and the sandbox gate holds), and `cleanup`
 * refunds the one test charge, removes the Stripe customer + account, the
 * fixture rows (management API, replica role for the append-only ledgers) and
 * the auth user. Run from artifacts/api-server with the API server running:
 *   pnpm exec tsx scripts/app-access-live-proof.mts <prepare|run|cleanup|status>
 * Needs SUPABASE_ACCESS_TOKEN. Optional APP_ACCESS_PROOF_API_ORIGIN
 * (default http://localhost:80). State: ../../.local/state/app-access-proof.json.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { supabaseAdmin, supabaseBase, serviceKey } from "../src/lib/supabase-admin";
import { getStripe, getStripeCredentials } from "../src/billing/stripe-client";
import { runWithBillingIdentity, type BillingIdentity } from "../src/billing/stripe-environment";
import { claimConnect, connectGuard } from "../src/billing/connect-guard";
import { selectOne, update } from "../src/billing/store";
import { updateOfficeAppAccessSettings } from "../src/billing/app-access/settings";
import { APP_ACCESS_PATIENT_SELECT, officeAppAccessStates, patientAppAccess } from "../src/billing/app-access/service";
import { evaluateAppAccess, staffState } from "../src/billing/app-access/entitlement";
import { processStripeEvent } from "../src/billing/webhook-processing";
import { CONSENT_POLICY_VERSION } from "../src/privacy/consent";

const STATE_PATH = resolve(process.cwd(), "../../.local/state/app-access-proof.json");
const RESULT_PATH = resolve(process.cwd(), "../../.local/state/app-access-proof-result.json");
const ORIGIN = process.env.APP_ACCESS_PROOF_API_ORIGIN?.trim() || "http://localhost:80";
const PREFIX = "app-access-proof-";

interface State {
  created_at: string;
  provider_id: string;
  account_id: string | null;
  patient_id: string;
  user_id: string | null;
  email: string;
  password: string;
  identity: BillingIdentity;
  subscription_id?: string;
  order_id?: string;
  stripe_subscription_id?: string;
  stripe_customer_id?: string;
  payment_intent_id?: string;
}

const save = (state: State) => { mkdirSync(dirname(STATE_PATH), { recursive: true }); writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 }); };
const load = (): State => { if (!existsSync(STATE_PATH)) throw new Error("Proof is not prepared."); return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "ok " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`Check failed: ${name}`);
}

async function rest(method: string, route: string, body?: unknown, prefer = "return=representation") {
  const result = await supabaseAdmin(method, route, body, prefer);
  if (result.status >= 300) throw new Error(`Database operation failed: ${method} ${route.split("?")[0]} (${result.status}) ${JSON.stringify(result.json).slice(0, 300)}`);
  return result.json;
}
async function auth(route: string, body?: unknown, method = "POST") {
  const response = await fetch(`${supabaseBase()}/auth/v1/${route}`, {
    method, headers: { apikey: serviceKey(), Authorization: `Bearer ${serviceKey()}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Auth operation failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  return response.json();
}
async function management(query: string) {
  const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is required.");
  const ref = new URL(supabaseBase()).hostname.split(".")[0];
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error(`Management query failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

async function guard(): Promise<BillingIdentity> {
  if (process.env.NODE_ENV === "production") throw new Error("Development proof only.");
  if (!process.env.SUPABASE_ACCESS_TOKEN?.trim()) throw new Error("SUPABASE_ACCESS_TOKEN is required so the fixture can be torn down.");
  if (/xkdhmqexlvkipwgkaiyk/.test(supabaseBase())) throw new Error("Refusing: SUPABASE_URL points at production.");
  const keys = await getStripeCredentials("test");
  if (!keys.secret.startsWith("sk_test_") || !keys.publishable.startsWith("pk_test_")) throw new Error("Stripe TEST keys required.");
  const stripe = await getStripe("test");
  if ((await stripe.balance.retrieve()).livemode !== false) throw new Error("Stripe reports live mode.");
  return { mode: "test", platformAccountId: keys.account_id };
}

async function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as Record<string, string> ?? {}) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const response = await fetch(`${ORIGIN}/api${path}`, { ...init, headers });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: response.status, json, headers: response.headers };
}

/** What the office roster shows for the proof patient (same rule module as the roster DTO). */
async function rosterState(state: State) {
  const rows = await rest("GET", `/rest/v1/patients?id=eq.${state.patient_id}&select=${APP_ACCESS_PATIENT_SELECT}`) as Record<string, unknown>[];
  return (await officeAppAccessStates(state.provider_id, rows)).get(state.patient_id);
}

async function patientToken(state: State): Promise<string> {
  const session = await auth("token?grant_type=password", { email: state.email, password: state.password });
  if (!session.access_token) throw new Error("Patient sign-in failed.");
  return session.access_token as string;
}

// ------------------------------------------------------------------ prepare
async function prepare() {
  if (existsSync(STATE_PATH)) throw new Error("Proof state already exists; run cleanup first.");
  const identity = await guard();
  const suffix = randomBytes(6).toString("hex");
  const providerId = `${PREFIX}${suffix}`;
  const email = `${providerId}-patient@example.invalid`;
  const state: State = {
    created_at: new Date().toISOString(), provider_id: providerId, account_id: null, patient_id: randomUUID(), user_id: null,
    email, password: `Tmp!${randomBytes(28).toString("base64url")}5a`, identity,
  };
  save(state);
  const now = new Date().toISOString();

  // Office + practice-launch waiver (the office-scope gate 502s otherwise).
  await rest("POST", "/rest/v1/providers", [{
    provider_id: providerId, provider_name: "App Access Proof Office", office_name: "App Access Proof Office",
    email: `${providerId}@example.invalid`, access_disabled: false,
  }]);
  await rest("POST", "/rest/v1/practice_launch?on_conflict=provider_id", [{
    provider_id: providerId, required: false, setup_override_at: now, setup_override_note: "App access live proof",
  }], "resolution=merge-duplicates,return=minimal");

  // A platform-controlled TEST connected account completed with Stripe's test
  // identity data (in-app onboarding is hCaptcha-blocked for scripts).
  const stripe = await getStripe("test");
  const account = await stripe.accounts.create({
    country: "US", email: `${providerId}@example.invalid`, business_type: "individual",
    business_profile: { name: "App Access Proof Office", mcc: "8099", url: "https://app.trythinnr.com", product_description: "Synthetic app access proof" },
    controller: { stripe_dashboard: { type: "none" }, fees: { payer: "application" }, losses: { payments: "application" }, requirement_collection: "application" },
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    individual: {
      first_name: "Synthetic", last_name: "Proof", email: `${providerId}@example.invalid`, phone: "0000000000",
      dob: { day: 1, month: 1, year: 1901 }, ssn_last_4: "0000", id_number: "000000000",
      address: { line1: "address_full_match", city: "Memphis", state: "TN", postal_code: "38103", country: "US" },
    },
    tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: "127.0.0.1" },
    external_account: { object: "bank_account", country: "US", currency: "usd", routing_number: "110000000", account_number: "000123456789" } as any,
    metadata: { thinnr_provider_id: providerId, thinnr_app_access_proof: "1" },
  });
  state.account_id = account.id; save(state);
  let ready = account;
  for (let i = 0; i < 40 && !(ready.charges_enabled && ready.capabilities?.card_payments === "active"); i += 1) {
    await sleep(3000);
    ready = await stripe.accounts.retrieve(account.id);
  }
  if (!(ready.charges_enabled && ready.capabilities?.card_payments === "active")) {
    throw new Error(`TEST account never became charge-capable: ${JSON.stringify(ready.requirements?.currently_due)}`);
  }

  await runWithBillingIdentity(identity, async () => {
    const claim = await claimConnect(providerId);
    await connectGuard("attach", providerId, { p_token: claim.token, p_generation: claim.generation, p_version: claim.modeVersion, p_account: {
      provider_id: providerId, stripe_account_id: account.id, origin: "created", dashboard_type: "none",
      charges_enabled: true, payouts_enabled: Boolean(ready.payouts_enabled), details_submitted: Boolean(ready.details_submitted),
      requirements: (ready.requirements ?? {}) as unknown as Record<string, unknown>,
      capabilities: (ready.capabilities ?? {}) as unknown as Record<string, string>,
      default_currency: ready.default_currency ?? "usd", business_name: "App Access Proof Office", email: `${providerId}@example.invalid`,
      tax_enabled: false, tax_last_checked_at: null, oauth_refresh_token: null, livemode: false, last_synced_at: new Date().toISOString(),
      disconnected_at: null, stripe_customer_emails: "off", stripe_customer_emails_checked_at: new Date().toISOString(),
      stripe_customer_emails_note: "Synthetic TEST fixture; no customer email is deliverable.",
    } });
  });

  // Patient on a non-THINNR program, activated now, consented and onboarded.
  const user = await auth("admin/users", { email, password: state.password, email_confirm: true,
    app_metadata: { fixture: "app-access-proof" }, user_metadata: { display_name: "Synthetic Proof Patient" } });
  state.user_id = user.id; save(state);
  await rest("POST", "/rest/v1/patients", [{
    id: state.patient_id, auth_user_id: user.id, provider_id: providerId, name: "Synthetic Proof Patient", first_name: "Synthetic", last_name: "Proof",
    email, phone: null, activation_status: "activated", created_at: now, profile_completed_at: now, timezone: "America/New_York",
    program_id: "glp", program_start_date: null,
  }]);
  await rest("POST", "/rest/v1/patient_flags", [{ patient_id: state.patient_id, onboarding_complete: true }]);
  await rest("POST", "/rest/v1/patient_consents", [{
    patient_id: state.patient_id, policy_version: CONSENT_POLICY_VERSION, terms_accepted: true, privacy_accepted: true,
    health_data_accepted: true, photo_analysis_accepted: false, app_version: "app-access-proof", platform: "server",
  }]);
  console.log(JSON.stringify({ prepared: true, provider_id: providerId, account_id: account.id, patient_id: state.patient_id, charges_enabled: true }, null, 2));
}

// ---------------------------------------------------------------------- run
async function waitFor<T>(label: string, read: () => Promise<T | null>, ms = 90_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await read();
    if (value !== null) return value;
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/**
 * Webhooks for the TEST platform are registered to the main workspace and
 * production, not to this environment, so the lifecycle events are pulled
 * from Stripe and run through the SAME processor the webhook route uses.
 * The event ledger makes this idempotent: a delivery the main workspace
 * already handled comes back "duplicate" and is simply counted.
 */
async function pumpEvents(state: State, types: string[], matches: (object: any) => boolean) {
  const stripe = await getStripe("test");
  const events = await stripe.events.list({ limit: 50, types } as any, { stripeAccount: state.account_id! });
  const outcomes: Record<string, string> = {};
  for (const event of [...events.data].reverse()) {
    const object = (event.data.object as any) ?? {};
    if (!matches(object)) continue;
    const connectEvent = { ...event, account: state.account_id! } as any;
    outcomes[`${event.type}:${event.id}`] = await processStripeEvent(connectEvent, "connect");
  }
  return outcomes;
}

async function run() {
  const state = load();
  const identity = await guard();
  const result: Record<string, unknown> = { started_at: new Date().toISOString(), provider_id: state.provider_id, patient_id: state.patient_id };
  const health = await api("/healthz");
  if (health.status !== 200) throw new Error(`API server is not reachable at ${ORIGIN} (${health.status}).`);

  await runWithBillingIdentity(identity, async () => {
    console.log("\nOffice turns charging on (0-day trial so the patient locks today)");
    const before = await selectOne("billing_office_settings", `provider_id=eq.${state.provider_id}`);
    const settings = await updateOfficeAppAccessSettings(state.provider_id, {
      enabled: true, price_cents: 699, cadence: "2_weeks", trial_days: 0, expected_version: before?.version ?? 0,
    }, randomUUID());
    check("settings saved with the office price", settings.enabled && settings.price_cents === 699 && settings.cadence === "2_weeks" && settings.trial_days === 0);
    const mirror = await selectOne("billing_app_access_prices", `provider_id=eq.${state.provider_id}`);
    const stripe = await getStripe("test");
    const price = await stripe.prices.retrieve(mirror!.stripe_price_id!, {}, { stripeAccount: state.account_id! });
    check("recurring price mirrored on the connected account", price.active && price.unit_amount === 699 && price.recurring?.interval === "week" && price.recurring?.interval_count === 2,
      `${price.id} ${price.unit_amount} every ${price.recurring?.interval_count} ${price.recurring?.interval}`);

    console.log("\nLocked patient");
    const token = await patientToken(state);
    const locked = await api("/patient-data/billing/app-access", { token });
    check("entitlement read answers locked with the office price and a checkout link",
      locked.status === 200 && locked.json.available === false && locked.json.reason === "locked" && locked.json.office_charges === true
      && locked.json.price_cents === 699 && locked.json.cadence === "2_weeks" && locked.json.free_window?.kind === "trial"
      && typeof locked.json.checkout_url === "string" && locked.json.checkout_url.includes("/pay/app-access/"),
      JSON.stringify({ ...locked.json, checkout_url: locked.json.checkout_url ? "[link]" : null }));
    const barcode = await api("/barcode/0049000006346", { token });
    check("premium route refuses with the non-retryable upgrade payload",
      barcode.status === 402 && barcode.json.upgradeRequired === true && barcode.json.retryable === false && barcode.json.entitlement?.reason === "locked",
      `${barcode.status} ${JSON.stringify(barcode.json).slice(0, 160)}`);
    const roster0 = await rosterState(state);
    check("office roster state reads trial_ended", roster0?.state === "trial_ended", JSON.stringify(roster0));

    console.log("\nPublic pay page");
    const checkoutToken = String(locked.json.checkout_url).split("/pay/app-access/")[1];
    const preview = await api(`/billing/public/app-access/${encodeURIComponent(checkoutToken)}`);
    const scope = preview.headers.get("X-Billing-Scope");
    check("preview names the office, price and cadence under the test scope",
      preview.status === 200 && preview.json.office_name === "App Access Proof Office" && preview.json.price_cents === 699
      && preview.json.cadence === "2_weeks" && preview.json.already_subscribed === false && preview.json.sandbox === true && Boolean(scope),
      JSON.stringify(preview.json));
    const bad = await api(`/billing/public/app-access/not-a-token`);
    check("a bad token is a 404", bad.status === 404);
    const checkout = await api(`/billing/public/app-access/${encodeURIComponent(checkoutToken)}/checkout`, {
      method: "POST", body: "{}", headers: { "X-Billing-Scope": scope! },
    });
    check("checkout opens a subscription on the connected account",
      checkout.status === 200 && typeof checkout.json.client_secret === "string" && checkout.json.stripe_account_id === state.account_id
      && checkout.json.price_cents === 699 && checkout.json.sandbox === true,
      `${checkout.status} ${JSON.stringify({ ...checkout.json, client_secret: "[secret]", publishable_key: "[key]" })}`);
    state.order_id = checkout.json.order_id;
    state.payment_intent_id = String(checkout.json.client_secret).split("_secret_")[0];
    const subRow = await selectOne("billing_subscriptions", `patient_id=eq.${state.patient_id}&kind=eq.app_access&order=created_at.desc`);
    state.subscription_id = subRow!.id; state.stripe_subscription_id = subRow!.stripe_subscription_id!; state.stripe_customer_id = subRow!.stripe_customer_id!;
    save(state);
    const orderRow = await selectOne("billing_orders", `id=eq.${state.order_id}`);
    check("order snapshots the flat 30% share, no shipping and no fulfilment",
      orderRow!.thinnr_share_percent === 30 && orderRow!.application_fee_cents === 209 && orderRow!.shipping_charge_cents === 0
      && orderRow!.fulfillment_status === "not_required" && orderRow!.status === "pending",
      JSON.stringify({ share: orderRow!.thinnr_share_percent, fee: orderRow!.application_fee_cents, fulfillment: orderRow!.fulfillment_status }));
    const stripeSub = await stripe.subscriptions.retrieve(state.stripe_subscription_id!, {}, { stripeAccount: state.account_id! });
    check("Stripe subscription carries the 30% application fee", Math.abs(Number(stripeSub.application_fee_percent) - 29.9) < 0.01 && stripeSub.status === "incomplete",
      `${stripeSub.application_fee_percent}% ${stripeSub.status}`);

    console.log("\nFirst payment (test card)");
    const intent = await stripe.paymentIntents.confirm(state.payment_intent_id!, { payment_method: "pm_card_visa" }, { stripeAccount: state.account_id! });
    check("PaymentIntent succeeded on the connected account", intent.status === "succeeded", intent.status);
    const invoiceMatches = (object: any) => object.subscription === state.stripe_subscription_id
      || object.id === state.stripe_subscription_id
      || object.parent?.subscription_details?.subscription === state.stripe_subscription_id
      || object.metadata?.thinnr_subscription_id === state.subscription_id;
    const paid = await waitFor("the first order to be paid", async () => {
      const outcomes = await pumpEvents(state, ["invoice.paid", "customer.subscription.updated", "customer.subscription.created"], invoiceMatches);
      const order = await selectOne("billing_orders", `id=eq.${state.order_id}`);
      const sub = await selectOne("billing_subscriptions", `id=eq.${state.subscription_id}`);
      return order?.status === "paid" && sub?.status === "active" ? { order, sub, outcomes } : null;
    });
    result.first_payment_events = paid.outcomes;
    check("lifecycle landed: order paid, subscription active with a paid-through instant",
      paid.order.status === "paid" && paid.sub.status === "active" && Boolean(paid.sub.current_period_end) && paid.sub.stripe_subscription_id === state.stripe_subscription_id,
      JSON.stringify({ order: paid.order.status, sub: paid.sub.status, period_end: paid.sub.current_period_end, events: paid.outcomes }));
    const status = await api(`/billing/public/app-access/${encodeURIComponent(checkoutToken)}/orders/${state.order_id}`);
    check("the pay page's done poll sees paid/active", status.status === 200 && status.json.status === "paid" && status.json.subscription_status === "active", JSON.stringify(status.json));

    console.log("\nSubscribed patient");
    const open = await api("/patient-data/billing/app-access", { token });
    check("entitlement read answers available/subscribed with no upgrade link",
      open.status === 200 && open.json.available === true && open.json.reason === "subscribed" && open.json.subscription?.state === "active"
      && open.json.subscription_id === state.subscription_id && open.json.checkout_url === null, JSON.stringify(open.json));
    const barcodeOpen = await api("/barcode/0049000006346", { token });
    check("premium route no longer refuses", barcodeOpen.status !== 402, String(barcodeOpen.status));
    const overview = await api("/patient-data/billing/overview", { token });
    const listed = (overview.json.subscriptions ?? []).find((row: any) => row.id === state.subscription_id);
    check("the app subscription shows in the patient's subscriptions list as kind app_access",
      overview.status === 200 && listed && listed.kind === "app_access" && listed.status === "active", JSON.stringify(listed));
    const roster1 = await rosterState(state);
    check("office roster state reads subscribed", roster1?.state === "subscribed", JSON.stringify(roster1));

    console.log("\nPatient cancels (keeps access through the paid period)");
    const cancel = await api(`/patient-data/billing/subscriptions/${state.subscription_id}/cancel`, { method: "POST", body: "{}", token });
    check("cancel route accepts", cancel.status === 200, `${cancel.status} ${JSON.stringify(cancel.json).slice(0, 160)}`);
    const canceling = await stripe.subscriptions.retrieve(state.stripe_subscription_id!, {}, { stripeAccount: state.account_id! });
    check("Stripe subscription is set to end at period end", canceling.cancel_at_period_end === true && canceling.status === "active");
    await pumpEvents(state, ["customer.subscription.updated"], invoiceMatches);
    const afterCancel = await api("/patient-data/billing/app-access", { token });
    check("still available until the paid period ends, flagged cancel_at_period_end",
      afterCancel.json.available === true && afterCancel.json.reason === "subscribed" && afterCancel.json.subscription?.cancel_at_period_end === true,
      JSON.stringify(afterCancel.json.subscription));
    const roster2 = await rosterState(state);
    check("office roster state reads canceling", roster2?.state === "canceling", JSON.stringify(roster2));

    console.log("\nStripe ends the subscription (lapse)");
    await stripe.subscriptions.cancel(state.stripe_subscription_id!, {}, { stripeAccount: state.account_id! });
    const ended = await waitFor("the subscription to read canceled", async () => {
      await pumpEvents(state, ["customer.subscription.deleted", "customer.subscription.updated"], invoiceMatches);
      const sub = await selectOne("billing_subscriptions", `id=eq.${state.subscription_id}`);
      return sub?.status === "canceled" ? sub : null;
    });
    check("subscription row is canceled with the paid-through instant kept", ended.status === "canceled" && Boolean(ended.current_period_end), ended.current_period_end ?? "");
    const live = await patientAppAccess(state.patient_id);
    check("today (inside the paid period) the patient still has access", live!.entitlement.available === true && live!.entitlement.reason === "subscribed");
    const afterPeriod = new Date(Date.parse(ended.current_period_end!) + 60_000);
    const later = evaluateAppAccess({
      todayKey: afterPeriod.toISOString().slice(0, 10), now: afterPeriod, programId: "glp", episodeStartedOn: null,
      activatedAt: state.created_at, timeZone: "America/New_York",
      office: { enabled: true, price_cents: 699, cadence: "2_weeks", trial_days: 0 },
      subscription: { status: ended.status, current_period_end: ended.current_period_end, cancel_at_period_end: ended.cancel_at_period_end },
    });
    check("one minute after the paid period the same facts read locked / lapsed", later.available === false && later.reason === "locked" && staffState(later) === "lapsed",
      `${later.reason} ${staffState(later)}`);
    const relock = await api("/patient-data/billing/app-access", { token });
    check("a canceled subscription re-offers the upgrade link", relock.json.available === true && typeof relock.json.checkout_url === "string");
  });

  result.checks = checks;
  result.finished_at = new Date().toISOString();
  mkdirSync(dirname(RESULT_PATH), { recursive: true });
  writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(`\nAll ${checks.length} live checks passed. Result: ${RESULT_PATH}`);
}

// ------------------------------------------------------------------ cleanup
async function cleanup() {
  if (!existsSync(STATE_PATH)) { console.log("Proof state absent."); return; }
  const state = load();
  const identity = await guard();
  if (!state.provider_id.startsWith(PREFIX) || !/^[a-f0-9-]{36}$/.test(state.patient_id)) throw new Error("Refusing to clean a non-fixture id.");
  const stripe = await getStripe("test");
  if (state.account_id) {
    const opts = { stripeAccount: state.account_id };
    if (state.stripe_subscription_id) {
      const sub = await stripe.subscriptions.retrieve(state.stripe_subscription_id, {}, opts).catch(() => null);
      if (sub && sub.status !== "canceled") await stripe.subscriptions.cancel(state.stripe_subscription_id, {}, opts);
    }
    if (state.payment_intent_id) {
      const intent = await stripe.paymentIntents.retrieve(state.payment_intent_id, {}, opts).catch(() => null);
      if (intent?.status === "succeeded") {
        const charge = typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id;
        if (charge) {
          const existing = await stripe.refunds.list({ charge }, opts);
          if (!existing.data.length) await stripe.refunds.create({ charge, refund_application_fee: true } as any, opts);
        }
      }
    }
    if (state.stripe_customer_id) await stripe.customers.del(state.stripe_customer_id, {}, opts).catch(() => null);
    await runWithBillingIdentity(identity, async () => {
      // Refund events may still arrive; nothing else references the office.
      await update("billing_connected_accounts", `provider_id=eq.${state.provider_id}`, { charges_enabled: false }).catch(() => null);
    });
    await stripe.accounts.del(state.account_id).catch((error: unknown) => console.warn("account delete skipped:", error instanceof Error ? error.message : error));
  }
  await management(`begin; set local session_replication_role = replica;
select set_config('thinnr.connect_mutation','allowed',true);
do $$ declare t text; begin
for t in select table_name from information_schema.columns where table_schema='public' and column_name='order_id' and table_name like 'billing_%' loop
execute format('delete from public.%I where order_id in (select id from billing_orders where patient_id=$1)',t) using '${state.patient_id}'::uuid; end loop;
for t in select table_name from information_schema.columns where table_schema='public' and column_name='patient_id' and table_name <> 'patients' loop
execute format('delete from public.%I where patient_id=$1',t) using '${state.patient_id}'::uuid; end loop;
for t in select table_name from information_schema.columns where table_schema='public' and column_name='provider_id' and table_name <> 'providers' loop
execute format('delete from public.%I where provider_id::text=$1',t) using '${state.provider_id}'; end loop;
delete from patients where id='${state.patient_id}'::uuid;
delete from providers where provider_id='${state.provider_id}';
end $$; commit;`);
  if (state.user_id) await auth(`admin/users/${state.user_id}`, undefined, "DELETE").catch(() => null);
  const left = await management(`select (select count(*) from providers where provider_id='${state.provider_id}') as providers,
    (select count(*) from patients where id='${state.patient_id}'::uuid) as patients,
    (select count(*) from billing_subscriptions where provider_id='${state.provider_id}') as subscriptions`);
  unlinkSync(STATE_PATH);
  console.log(JSON.stringify({ cleaned: true, remaining: left }, null, 2));
}

async function status() {
  if (!existsSync(STATE_PATH)) { console.log("Proof state absent."); return; }
  const state = load();
  console.log(JSON.stringify({ ...state, password: "[redacted]" }, null, 2));
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = { prepare, run, cleanup, status };
if (!command || !commands[command]) { console.error("Usage: app-access-live-proof.mts <prepare|run|cleanup|status>"); process.exit(2); }
commands[command]().then(() => process.exit(0)).catch((error) => {
  console.error(error instanceof Error ? error.message.replace(/\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9]+\b/g, "[redacted]") : error);
  process.exit(1);
});
