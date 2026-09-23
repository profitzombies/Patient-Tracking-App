/**
 * End-to-end sandbox verification: a REAL patient checkout (Stripe TEST) that
 * reaches the WarehouseCraft SANDBOX tenant, picks up vendor tracking through
 * the ordinary status poll, and lands its emails in the customer-email ledger.
 *
 * Nothing live is touched: Stripe TEST keys only (asserted), the synthetic
 * `stripe-app-e2e-*` office and its charge-capable TEST connected account,
 * a synthetic catalog product mapped to the sandbox SKU `Test01` (hidden from
 * every real office by construction, asserted at runtime), and the per-order
 * allowance in `src/billing/sandbox-verification.ts`, which only opens under
 * the sandbox tenant for the one order id this runner flags.
 *
 * Commands (run from artifacts/api-server, in this order):
 *   prepare   synthetic product → stripe-app-e2e-fixture prepare → patient session fixture
 *   checkout  quote + checkout over the real patient API (tok_visa), flag the order,
 *             catch-up confirmation email, wait for the warehouse submission
 *   wait      wait for vendor tracking (resumable), then for OUR poll to land it;
 *             assert patient API + HQ/office order detail + email ledger; write result
 *   cleanup   refund (Stripe TEST), cancel at the warehouse when still allowed,
 *             remove the allowance, then delegate financial + patient teardown
 *   status    print the private state
 *
 * Authorization (every command): RUN_SANDBOX_VERIFICATION=authorized and
 * CONFIRM_VENDOR_SANDBOX_NO_CUTOVER=yes (the operator confirms the vendor has
 * not cut the tenant over to live). Also needed: STRIPE_APP_E2E_ACCOUNT_ID
 * (charge-capable TEST connected account for the fixture), SUPABASE_ACCESS_TOKEN
 * (fixture teardown) and RUN_STRIPE_APP_E2E=authorized for cleanup.
 *
 * Optional knobs: SANDBOX_VERIFICATION_INBOX (default delivered@resend.dev),
 * SANDBOX_VERIFICATION_TRACKING_WAIT_MINUTES (default 20; `wait` exits 3 when
 * the vendor has not added tracking yet — re-run `wait` later), SANDBOX_VERIFICATION_API_ORIGIN
 * (default http://localhost), SANDBOX_VERIFICATION_AUTHORIZED_BY (label stored on the allowance).
 *
 * State: ../../.local/state/sandbox-verification.json (private, gitignored, mode 600).
 * Result: ../../.local/state/sandbox-verification-result.json. No secrets are written.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getStripe, getStripeCredentials } from "../src/billing/stripe-client";
import { runWithBillingIdentity, type BillingIdentity } from "../src/billing/stripe-environment";
import { remove, selectMany, selectOne, update } from "../src/billing/store";
import { supabaseAdmin } from "../src/lib/supabase-admin";
import { createProduct, resolveOffering } from "../src/billing/catalog";
import { breakEvenMinimum } from "../src/billing/fees";
import { notifyOrderConfirmationIfCartComplete } from "../src/billing/customer-emails";
import { SANDBOX_VERIFICATION_TABLE, sandboxVerificationFor } from "../src/billing/sandbox-verification";
import { cancelAtWarehouse } from "../src/billing/warehouse-submissions";
import { refundOrder, toOrderDetail } from "../src/billing/orders";
import { toCustomerEmailDtos } from "../src/routes/billing-customer-emails";
import { warehouseTenantMode } from "../src/shipping/warehousecraft";
import { callOrderApi, warehouseOrderClient } from "../src/shipping/warehousecraft-orders";
import { warehouseStatusClient } from "../src/shipping/warehousecraft-status";
import { registerAllJobs } from "../src/jobs";
import { runJob } from "../src/jobs/scheduler";

const STATE_DIR = resolve(process.cwd(), "../../.local/state");
const STATE_PATH = resolve(STATE_DIR, "sandbox-verification.json");
const RESULT_PATH = resolve(STATE_DIR, "sandbox-verification-result.json");
const E2E_STATE_PATH = resolve(STATE_DIR, "stripe-app-e2e.json");
const BROWSER_FIXTURE_PATH = "/tmp/thinnr-patient-checkout-browser-fixture.json";
const SANDBOX_SKU = "Test01";
const ORIGIN = process.env.SANDBOX_VERIFICATION_API_ORIGIN?.trim() || "http://localhost";
const INBOX = process.env.SANDBOX_VERIFICATION_INBOX?.trim() || "delivered@resend.dev";
const AUTHORIZED_BY = process.env.SANDBOX_VERIFICATION_AUTHORIZED_BY?.trim() || "sandbox-verification runner";
const ALLOWANCE_HOURS = 4;
const SUBMIT_JOB = "warehouse-submit";
const SYNC_JOB = "warehouse-status-sync";
const RETRY_JOB = "customer-email-retries";
const SUBMIT_INTERVAL_MS = 2 * 60_000;
const SYNC_INTERVAL_MS = 5 * 60_000;
const ADDRESS = {
  name: "Sandbox Verification (TEST)", line1: "123 Test Street", line2: null, city: "Memphis", state: "TN",
  postal_code: "38103", country: "US", phone: null as string | null,
};

interface Timeline { [event: string]: string }
interface State {
  created_at: string;
  identity: BillingIdentity;
  actor: string;
  product_id: string;
  provider_id?: string;
  account_id?: string;
  patient_id?: string;
  cart_id?: string;
  order_id?: string;
  order_number?: string;
  payment_intent_id?: string;
  warehouse_order_id?: string;
  submit_triggered_by?: "dev scheduler" | "runner";
  sync_triggered_by?: "dev scheduler" | "runner";
  confirmation_email?: string;
  refund?: { id: string; amount_cents: number; status: string };
  vendor_cancel?: string;
  timeline: Timeline;
}
interface EmailSummary {
  template_id: string; status: string; attempts: number; max_attempts: number; recipient_domain: string | null;
  error: string | null; attempt_log: unknown[];
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const nowIso = () => new Date().toISOString();
const enc = encodeURIComponent;
const save = (state: State) => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
const load = (): State => {
  if (!existsSync(STATE_PATH)) throw new Error("No sandbox verification state; run `prepare` first.");
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
};
const stamp = (state: State, event: string) => { state.timeline[event] = nowIso(); save(state); };
const log = (message: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: nowIso(), message, ...extra }));
const safeError = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]+\b/g, "[redacted key]").replace(/\bwhsec_\S+/g, "[redacted]");

function requireAuthorization(): void {
  if (process.env.NODE_ENV === "production") throw new Error("Development-only runner.");
  if (process.env.RUN_SANDBOX_VERIFICATION !== "authorized") throw new Error("RUN_SANDBOX_VERIFICATION=authorized is required.");
  if (process.env.CONFIRM_VENDOR_SANDBOX_NO_CUTOVER !== "yes") throw new Error("CONFIRM_VENDOR_SANDBOX_NO_CUTOVER=yes is required (operator confirms the vendor tenant is still the sandbox).");
  if (warehouseTenantMode() !== "test") throw new Error("WAREHOUSECRAFT_TENANT_MODE is live; refused.");
  if (!INBOX.includes("@") || /@(thinnr|gmail|yahoo|outlook|icloud)\./i.test(INBOX) && !process.env.SANDBOX_VERIFICATION_INBOX) {
    throw new Error("Designated inbox must be an explicit test address.");
  }
}

/** Stripe TEST identity guard (mirrors the fixtures): keys, balance livemode, platform account. */
async function testIdentity(): Promise<BillingIdentity> {
  const keys = await getStripeCredentials("test");
  if (!keys.secret.startsWith("sk_test_") || !keys.publishable.startsWith("pk_test_")) throw new Error("Stripe TEST keys required.");
  const stripe = await getStripe("test");
  if ((await stripe.balance.retrieve()).livemode !== false) throw new Error("Stripe TEST balance required.");
  return { mode: "test", platformAccountId: keys.account_id };
}

/** Sandbox tenant guard: inventory must be the vendor's test-only SKU set (same rule as controlled-warehouse-test). */
async function assertSandboxTenant(): Promise<void> {
  const inventory = await callOrderApi("GET", "/api/InventoryDetails?WarehouseId=1");
  if (inventory.status !== 200 || !Array.isArray(inventory.json)) throw new Error("Warehouse inventory read failed; no write permitted.");
  const skus = inventory.json.map((row: { SKU?: string }) => row.SKU ?? "");
  if (!skus.includes(SANDBOX_SKU) || skus.some((sku: string) => !/^Test0[1-5]$/.test(sku))) {
    throw new Error("Tenant inventory contradicts the test-only expectation; stopped.");
  }
}

function runFixture(script: string, command: string, env: Record<string, string> = {}): string {
  const result = spawnSync("pnpm", ["exec", "tsx", script, command], {
    cwd: process.cwd(), env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`${script} ${command} failed:\n${(result.stderr || result.stdout).slice(-2000)}`);
  return result.stdout;
}

async function poll<T>(label: string, timeoutMs: number, intervalMs: number, probe: () => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) { log(`${label}: not observed within the wait window`); return null; }
    await sleep(intervalMs);
  }
}

async function triggerJob(name: string): Promise<void> {
  registerAllJobs();
  const outcome = await runJob(name, { trigger: "internal", force: true });
  log(`ran ${name} in-process`, { outcome: (outcome as { status?: string }).status ?? outcome });
}

async function apiConfig(): Promise<{ sandbox: boolean }> {
  const response = await fetch(`${ORIGIN}/api/billing/public/config`);
  if (!response.ok) throw new Error(`API server not reachable at ${ORIGIN} (${response.status}); start the API Server workflow.`);
  return response.json() as Promise<{ sandbox: boolean }>;
}

function patientSession(): string {
  if (!existsSync(BROWSER_FIXTURE_PATH)) throw new Error("Patient session fixture missing; run `prepare`.");
  const fixture = JSON.parse(readFileSync(BROWSER_FIXTURE_PATH, "utf8")) as { storage?: Record<string, string>; patient: string };
  const key = Object.keys(fixture.storage ?? {}).find((name) => name.endsWith("-auth-token"));
  const session = key ? JSON.parse(fixture.storage![key]) as { access_token?: string } : null;
  if (!session?.access_token) throw new Error("Patient session fixture has no access token.");
  return session.access_token;
}

async function patientApi<T>(path: string, init: RequestInit = {}): Promise<{ status: number; json: T }> {
  const response = await fetch(`${ORIGIN}/api${path}`, {
    ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${patientSession()}`, ...(init.headers ?? {}) },
  });
  return { status: response.status, json: await response.json().catch(() => null) as T };
}

/* -------------------------------- prepare -------------------------------- */

async function prepare(): Promise<void> {
  // A prepare that failed after the product step may be re-run; it resumes at the fixtures.
  const resuming = existsSync(STATE_PATH) ? load() : null;
  if (resuming?.provider_id || resuming?.patient_id) throw new Error("State exists; finish with `cleanup` first.");
  if (!resuming && (existsSync(E2E_STATE_PATH) || existsSync(BROWSER_FIXTURE_PATH))) throw new Error("A fixture state already exists; clean those up first.");
  if (!process.env.STRIPE_APP_E2E_ACCOUNT_ID) throw new Error("STRIPE_APP_E2E_ACCOUNT_ID (charge-capable TEST connected account) is required.");
  if (!process.env.SUPABASE_ACCESS_TOKEN) throw new Error("SUPABASE_ACCESS_TOKEN is required so teardown is guaranteed.");
  const identity = await testIdentity();
  await assertSandboxTenant();
  const state: State = resuming ?? { created_at: nowIso(), identity, actor: randomUUID(), product_id: "", timeline: {} };
  if (!state.product_id) await runWithBillingIdentity(identity, async () => {
    const settings = await selectOne("billing_settings", "id=eq.1");
    if (!settings) throw new Error("billing_settings row missing.");
    // Lowest sort order so both fixtures pick THIS product; a floor below break-even
    // keeps it out of every office storefront that has no explicit office price row.
    const product = await createProduct({
      name: "Sandbox verification item (TEST — do not sell)", slug: `sandbox-verification-${randomUUID().slice(0, 8)}`,
      description: "Synthetic product used by the end-to-end sandbox verification runner. Removed by its cleanup.",
      floor_price_cents: 100, hard_cost_cents: 1, sort_order: -1000, status: "active",
      warehousecraft_sku: SANDBOX_SKU, shipping_weight_oz: 4, package_length_in: 6, package_width_in: 4, package_height_in: 2,
    }, state.actor);
    if (resolveOffering(product, null, settings) !== null) {
      await remove("billing_products", `id=eq.${enc(product.id)}`);
      throw new Error("Synthetic product would be visible to offices without an office price; aborted.");
    }
    state.product_id = product.id;
    save(state);
  });
  if (!state.timeline.product_created) stamp(state, "product_created");
  log("synthetic product ready", { product_id: state.product_id, resumed: Boolean(resuming) });
  try {
    if (!existsSync(E2E_STATE_PATH)) runFixture("scripts/stripe-app-e2e-fixture.mts", "prepare");
    const e2e = JSON.parse(readFileSync(E2E_STATE_PATH, "utf8")) as { provider_id: string; account_id: string; product_id: string };
    if (e2e.product_id !== state.product_id) throw new Error("The e2e fixture picked a different product; refusing to continue.");
    state.provider_id = e2e.provider_id; state.account_id = e2e.account_id;
    // The fixture prices at the floor; checkout refuses anything under the break-even
    // minimum, so the synthetic office sells at exactly that minimum (smallest valid charge).
    await runWithBillingIdentity(identity, async () => {
      const [settings, product] = await Promise.all([selectOne("billing_settings", "id=eq.1"), selectOne("billing_products", `id=eq.${enc(state.product_id)}`)]);
      if (!settings || !product) throw new Error("Settings or synthetic product missing.");
      const minimum = breakEvenMinimum(product.floor_price_cents, settings);
      await update("billing_office_prices", `provider_id=eq.${enc(state.provider_id!)}&product_id=eq.${enc(state.product_id)}`, { sell_price_cents: minimum });
      log("office price set to the break-even minimum", { sell_price_cents: minimum });
    });
    stamp(state, "office_fixture_ready");
    runFixture("scripts/patient-checkout-browser-fixture.mts", "prepare");
    const browser = JSON.parse(readFileSync(BROWSER_FIXTURE_PATH, "utf8")) as { patient: string; provider: string };
    if (browser.provider !== state.provider_id) throw new Error("Patient fixture attached to an unexpected office.");
    state.patient_id = browser.patient;
    stamp(state, "patient_fixture_ready");
  } catch (error) {
    log("prepare failed; re-run `prepare` to resume, or `cleanup` to remove what was created", { error: safeError(error) });
    throw error;
  }
  log("prepared", { provider_id: state.provider_id, patient_id: state.patient_id, product_id: state.product_id });
}

/* -------------------------------- checkout ------------------------------- */

async function checkout(): Promise<void> {
  const state = load();
  if (state.order_id) throw new Error("Checkout already happened for this state.");
  if (!state.provider_id || !state.patient_id || !state.account_id) throw new Error("Run `prepare` first.");
  const identity = await testIdentity();
  if (identity.platformAccountId !== state.identity.platformAccountId) throw new Error("Stripe platform identity changed since prepare.");
  await assertSandboxTenant();
  const config = await apiConfig();
  if (config.sandbox !== true) throw new Error("The API server is not in Stripe sandbox mode; refused.");

  const lines = [{ product_id: state.product_id, quantity: 1, purchase: "one_time" as const }];
  const quote = await patientApi<{ total_due_cents: number | null; total_cents: number; shipping_charge_cents: number; error?: string }>(
    "/patient-data/billing/cart/quote", { method: "POST", body: JSON.stringify({ lines, shipping_address: ADDRESS, shipping_method: "standard" }) });
  if (quote.status !== 200 || quote.json?.total_due_cents == null) throw new Error(`Quote failed (${quote.status}): ${quote.json?.error ?? "no total"}`);
  log("quote", { total_due_cents: quote.json.total_due_cents, shipping_charge_cents: quote.json.shipping_charge_cents });

  const stripe = await getStripe("test");
  const method = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_visa" } }, { stripeAccount: state.account_id });
  state.cart_id = randomUUID();
  stamp(state, "checkout_requested");
  // Financial writes must echo the billing scope the payment screen was loaded with.
  const scope = `${state.identity.mode}:${state.identity.platformAccountId}`;
  const result = await patientApi<{ status: string; items: Array<{ order_id: string; order_number: string; status: string; error: string | null }>; error?: string }>(
    "/patient-data/billing/cart/checkout", {
      method: "POST", headers: { "Idempotency-Key": state.cart_id, "X-Billing-Scope": scope },
      body: JSON.stringify({ lines, shipping_address: ADDRESS, shipping_method: "standard", payment_method_id: method.id, expected_total_due_cents: quote.json.total_due_cents }),
    });
  const item = result.json?.items?.[0];
  if (result.status !== 200 || result.json?.status !== "paid" || !item) {
    throw new Error(`Checkout did not pay (${result.status}): ${result.json?.error ?? item?.error ?? JSON.stringify(result.json)}`);
  }
  state.order_id = item.order_id; state.order_number = item.order_number;
  stamp(state, "order_paid");
  log("order paid through the patient checkout API", { order_id: state.order_id, order_number: state.order_number });

  await runWithBillingIdentity(state.identity, async () => {
    const order = await selectOne("billing_orders", `id=eq.${enc(state.order_id!)}`);
    if (!order || order.livemode !== false || order.status !== "paid") throw new Error("Paid sandbox order row not found.");
    state.payment_intent_id = order.stripe_payment_intent_id ?? undefined;
    await flagAllowance(state, order);
    // In-app carts pay synchronously, so the confirmation ran (and was skipped) before the
    // allowance existed. One documented catch-up call; notifyOnce dedupes on the cart key.
    state.confirmation_email = await notifyOrderConfirmationIfCartComplete(order);
    stamp(state, "confirmation_email_attempted");
    log("confirmation email", { outcome: state.confirmation_email });
  });

  // Warehouse submission: the dev server's scheduler (2 min) should drain the flagged
  // intent; if it does not, the runner runs the same job under the shared lease ledger.
  const sent = await waitForSubmission(state, SUBMIT_INTERVAL_MS + 60_000);
  if (!sent) {
    await triggerJob(SUBMIT_JOB);
    state.submit_triggered_by = "runner";
    if (!(await waitForSubmission(state, 30_000))) {
      const submission = await runWithBillingIdentity(state.identity, () => selectOne("billing_warehouse_submissions", `order_id=eq.${enc(state.order_id!)}`));
      throw new Error(`Warehouse submission did not reach sent: ${JSON.stringify({ state: submission?.state, error: submission?.last_error, skipped: submission?.skipped_reason })}`);
    }
  } else state.submit_triggered_by ??= "dev scheduler";
  save(state);
  log("submitted to the warehouse sandbox", { warehouse_order_id: state.warehouse_order_id, triggered_by: state.submit_triggered_by });
  console.log(`\nNext: have the vendor add tracking to sandbox order ${state.warehouse_order_id} (ClientOrderId ${state.order_number}), then run \`wait\`.`);
}

/** The allowance: sandbox tenant + this order id, bounded well inside the 12 h cap. */
async function flagAllowance(state: State, order: { id: string }): Promise<void> {
  const expires = new Date(Date.now() + ALLOWANCE_HOURS * 3_600_000).toISOString();
  const flagged = await supabaseAdmin("POST", `/rest/v1/${SANDBOX_VERIFICATION_TABLE}`, {
    order_id: order.id, designated_inbox: INBOX, authorized_by: AUTHORIZED_BY, expires_at: expires,
    note: "end-to-end checkout→tracking verification; emails go to the designated test inbox only",
  }, "return=representation");
  if (flagged.status >= 300) throw new Error(`Allowance insert failed (${flagged.status}).`);
  stamp(state, state.timeline.allowance_flagged ? "allowance_reflagged" : "allowance_flagged");
  if (!(await sandboxVerificationFor(order))) throw new Error("Allowance row not active after insert.");
}

/**
 * The vendor may take longer than one allowance window to ship the sandbox order. A
 * `wait` that starts with an expired (or soon-expiring) allowance re-arms it for this
 * one order so the poll and the shipped email are still permitted when tracking lands.
 * (The DB caps expires_at at created_at + 12 h, so this is a fresh row, not an extension.)
 */
async function rearmAllowance(state: State, horizonMs: number): Promise<void> {
  const order = await selectOne("billing_orders", `id=eq.${enc(state.order_id!)}`);
  if (!order || order.livemode !== false) throw new Error("Sandbox order row missing; refused.");
  const rows = await supabaseAdmin("GET", `/rest/v1/${SANDBOX_VERIFICATION_TABLE}?order_id=eq.${enc(order.id)}&select=expires_at`);
  const current = Array.isArray(rows.json) && rows.json[0] ? new Date((rows.json[0] as { expires_at: string }).expires_at).getTime() : 0;
  if (current > Date.now() + horizonMs) return;
  await supabaseAdmin("DELETE", `/rest/v1/${SANDBOX_VERIFICATION_TABLE}?order_id=eq.${enc(order.id)}`);
  await flagAllowance(state, order);
  log("allowance re-armed for the wait window", { hours: ALLOWANCE_HOURS });
}

async function waitForSubmission(state: State, timeoutMs: number): Promise<boolean> {
  const id = await poll("warehouse submission", timeoutMs, 10_000, () => runWithBillingIdentity(state.identity, async () => {
    const submission = await selectOne("billing_warehouse_submissions", `order_id=eq.${enc(state.order_id!)}`);
    if (submission?.state === "needs_attention") throw new Error(`Warehouse rejected the order: ${submission.last_error}`);
    return submission?.state === "sent" && submission.warehouse_order_id ? submission.warehouse_order_id : null;
  }));
  if (!id) return false;
  state.warehouse_order_id = id;
  stamp(state, "warehouse_sent");
  return true;
}

/* ---------------------------------- wait --------------------------------- */

async function wait(): Promise<void> {
  const state = load();
  if (!state.order_id || !state.warehouse_order_id || !state.order_number) throw new Error("Run `checkout` first.");
  await assertSandboxTenant();
  const waitMinutes = Number(process.env.SANDBOX_VERIFICATION_TRACKING_WAIT_MINUTES?.trim() || "20");
  const warehouseId = Number(state.warehouse_order_id);
  await runWithBillingIdentity(state.identity, () => rearmAllowance(state, waitMinutes * 60_000 + SYNC_INTERVAL_MS * 3));

  // 1. Vendor side: tracking on the sandbox order's shipment feed.
  const vendor = await poll("vendor tracking", waitMinutes * 60_000, 30_000, async () => {
    const status = await warehouseStatusClient.byId(warehouseId);
    if (!status) return null;
    if (status.client_order_id !== state.order_number) throw new Error("Feed answered for a different client order id; stopped.");
    const parcel = status.parcels.find((entry) => entry.tracking_number);
    return parcel ? { status: status.status, tracking: parcel.tracking_number!, carrier: parcel.carrier, ship_date: parcel.ship_date } : null;
  });
  if (!vendor) {
    writeResult(state, { outcome: "awaiting_vendor_tracking", note: `No tracking on warehouse order ${state.warehouse_order_id} after ${waitMinutes} minutes; re-run wait once the vendor adds it.` });
    process.exitCode = 3;
    return;
  }
  if (!state.timeline.vendor_tracking_seen) stamp(state, "vendor_tracking_seen");
  log("vendor tracking present", vendor);

  // 2. Our poll: the shipment row gets the tracking number via the ordinary status sync.
  const ours = await waitForOurTracking(state, vendor.tracking, SYNC_INTERVAL_MS + 60_000);
  if (!ours) {
    await triggerJob(SYNC_JOB);
    state.sync_triggered_by = "runner";
    if (!(await waitForOurTracking(state, vendor.tracking, 30_000))) throw new Error("Status sync did not land the tracking number.");
  } else state.sync_triggered_by ??= "dev scheduler";
  save(state);

  // 3. Shipped email rides the shipment write; give the ledger's retry job one pass too.
  await triggerJob(RETRY_JOB);
  const snapshot = await collectEvidence(state, vendor);
  const failures = snapshot.assertions.filter((entry) => !entry.ok);
  writeResult(state, { outcome: failures.length ? "assertions_failed" : "verified", ...snapshot });
  if (failures.length) throw new Error(`Assertions failed: ${failures.map((entry) => entry.name).join(", ")}`);
  log("verified end to end", { tracking: vendor.tracking, timings: snapshot.timings });
}

async function waitForOurTracking(state: State, tracking: string, timeoutMs: number): Promise<boolean> {
  const seen = await poll("our shipment tracking", timeoutMs, 10_000, () => runWithBillingIdentity(state.identity, async () => {
    const shipment = await selectOne("billing_shipments", `order_id=eq.${enc(state.order_id!)}`);
    return shipment?.tracking_number === tracking ? shipment : null;
  }));
  if (!seen) return false;
  if (!state.timeline.our_tracking_landed) stamp(state, "our_tracking_landed");
  return true;
}

interface Assertion { name: string; ok: boolean; detail?: unknown }

async function collectEvidence(state: State, vendor: { tracking: string; carrier: string | null; status: string }) {
  const assertions: Assertion[] = [];
  const check = (name: string, ok: boolean, detail?: unknown) => { assertions.push({ name, ok, ...(detail === undefined ? {} : { detail }) }); };

  // Patient orders API over real HTTP with the patient's own session.
  const patient = await patientApi<{ id: string; tracking_number: string | null; carrier: string | null; fulfillment_status: string; shipment?: { tracking_number?: string | null; status?: string } }>(
    `/patient-data/billing/orders/${state.order_id}`);
  const patientTracking = patient.json?.tracking_number ?? patient.json?.shipment?.tracking_number ?? null;
  check("patient orders API shows tracking", patient.status === 200 && patientTracking === vendor.tracking,
    { status: patient.status, tracking_number: patientTracking, fulfillment_status: patient.json?.fulfillment_status });

  const staff = await runWithBillingIdentity(state.identity, async () => {
    // Same service functions the HQ transaction and office order routes call (service layer,
    // not staff-token HTTP: the synthetic office has no staff login).
    const [hq, office] = await Promise.all([toOrderDetail(state.order_id!, true), toOrderDetail(state.order_id!, false)]);
    const rows = await selectMany("billing_customer_emails", `order_id=eq.${enc(state.order_id!)}&order=created_at.asc`);
    const emails = await toCustomerEmailDtos(rows);
    const submission = await selectOne("billing_warehouse_submissions", `order_id=eq.${enc(state.order_id!)}`);
    const shipment = await selectOne("billing_shipments", `order_id=eq.${enc(state.order_id!)}`);
    return { hq, office, emails, rows, submission, shipment };
  });
  check("HQ transaction detail shows tracking", staff.hq?.tracking_number === vendor.tracking, { tracking_number: staff.hq?.tracking_number, warehouse: staff.hq?.warehouse, shipment: staff.hq?.shipment });
  check("office order detail shows tracking", staff.office?.tracking_number === vendor.tracking, { tracking_number: staff.office?.tracking_number });
  check("warehouse submission sent with vendor id", staff.submission?.state === "sent" && staff.submission.warehouse_order_id === state.warehouse_order_id,
    { state: staff.submission?.state, warehouse_order_id: staff.submission?.warehouse_order_id });
  check("shipment row shipped from provider feed", staff.shipment?.status === "shipped" || staff.shipment?.status === "delivered", { status: staff.shipment?.status, source: staff.shipment?.source });

  const emails: EmailSummary[] = staff.rows.map((row) => ({
    template_id: row.template_id, status: row.status, attempts: row.attempts, max_attempts: row.max_attempts,
    recipient_domain: row.recipient ? row.recipient.split("@")[1] ?? null : null, error: row.error ?? null,
    attempt_log: Array.isArray(row.attempt_log) ? row.attempt_log.map((entry) => ({ ...(entry as Record<string, unknown>), recipient: undefined })) : [],
  }));
  const inboxDomain = INBOX.split("@")[1];
  const confirmation = emails.find((row) => /confirmation/.test(row.template_id));
  const shipped = emails.find((row) => /ship/.test(row.template_id));
  check("confirmation email sent to the designated inbox", confirmation?.status === "sent" && confirmation.recipient_domain === inboxDomain, confirmation);
  check("shipped email sent to the designated inbox", shipped?.status === "sent" && shipped.recipient_domain === inboxDomain, shipped);
  check("no email addressed anywhere but the designated inbox", emails.every((row) => !row.recipient_domain || row.recipient_domain === inboxDomain), emails.map((row) => row.recipient_domain));
  check("ledger DTOs load for staff pages", staff.emails.length === staff.rows.length, { count: staff.emails.length });

  const t = state.timeline;
  const ms = (a?: string, b?: string) => (a && b ? new Date(b).getTime() - new Date(a).getTime() : null);
  const timings = {
    checkout_to_paid_ms: ms(t.checkout_requested, t.order_paid),
    paid_to_warehouse_sent_ms: ms(t.order_paid, t.warehouse_sent),
    vendor_tracking_to_visible_ms: ms(t.vendor_tracking_seen, t.our_tracking_landed),
    submit_triggered_by: state.submit_triggered_by, sync_triggered_by: state.sync_triggered_by,
  };
  return { assertions, emails, timings, vendor, patient_status: patient.status, hq_shipment: staff.hq?.shipment ?? null, warehouse: staff.hq?.warehouse ?? null };
}

function writeResult(state: State, body: Record<string, unknown>): void {
  const result = {
    written_at: nowIso(), order_id: state.order_id, order_number: state.order_number, warehouse_order_id: state.warehouse_order_id,
    provider_id: state.provider_id, patient_id: state.patient_id, product_id: state.product_id, designated_inbox_domain: INBOX.split("@")[1],
    confirmation_email_catchup_outcome: state.confirmation_email, timeline: state.timeline, refund: state.refund ?? null, vendor_cancel: state.vendor_cancel ?? null,
    ...body,
  };
  writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), { mode: 0o600 });
  log("result written", { path: RESULT_PATH, outcome: body.outcome });
}

/* -------------------------------- cleanup -------------------------------- */

async function cleanup(): Promise<void> {
  if (!existsSync(STATE_PATH)) { console.log("No state; nothing to clean."); return; }
  const state = load();
  if (process.env.RUN_STRIPE_APP_E2E !== "authorized") throw new Error("RUN_STRIPE_APP_E2E=authorized is required for financial teardown.");
  await testIdentity();
  await runWithBillingIdentity(state.identity, async () => {
    if (state.order_id) {
      const order = await selectOne("billing_orders", `id=eq.${enc(state.order_id)}`);
      if (order && order.livemode !== false) throw new Error("Order is not a sandbox row; refused.");
      if (order && order.status === "paid" && !state.refund) {
        const refunded = await refundOrder(order.id, { amount_cents: order.total_cents, reason: "sandbox verification cleanup" }, null) as { id?: string; amount_cents?: number; status?: string; refund?: { id: string; amount_cents: number; status: string } };
        const row = refunded.refund ?? refunded;
        state.refund = { id: String(row.id ?? "unknown"), amount_cents: Number(row.amount_cents ?? order.total_cents), status: String(row.status ?? "unknown") };
        stamp(state, "refunded");
        log("Stripe TEST payment refunded", state.refund);
      }
      if (!state.vendor_cancel && state.warehouse_order_id) {
        try {
          const remote = await warehouseOrderClient.lookup(state.order_number!);
          const sync = await cancelAtWarehouse(order!.id);
          state.vendor_cancel = sync.kind === "applied" ? "cancelled at the sandbox warehouse"
            : `${sync.kind}: ${"message" in sync ? sync.message : ""} (vendor status ${remote?.status ?? "unknown"}; sandbox order stays marked as a test)`;
        } catch (error) { state.vendor_cancel = `not cancelled: ${safeError(error)}`; }
        stamp(state, "vendor_cancel_attempted");
        log("vendor cancel", { result: state.vendor_cancel });
      }
      await supabaseAdmin("DELETE", `/rest/v1/${SANDBOX_VERIFICATION_TABLE}?order_id=eq.${enc(state.order_id)}`).catch(() => undefined);
      if (state.cart_id) await remove("billing_carts", `id=eq.${enc(state.cart_id)}`).catch(() => undefined);
    }
  });
  // Financial teardown (orders, emails, payers, prices, account, office) then the patient/session.
  if (existsSync(E2E_STATE_PATH)) runFixture("scripts/stripe-app-e2e-fixture.mts", "cleanup-financial");
  if (existsSync(BROWSER_FIXTURE_PATH)) runFixture("scripts/patient-checkout-browser-fixture.mts", "cleanup");
  await runWithBillingIdentity(state.identity, async () => {
    if (state.product_id) {
      await remove("billing_office_prices", `product_id=eq.${enc(state.product_id)}`).catch(() => undefined);
      await remove("billing_catalog_changes", `product_id=eq.${enc(state.product_id)}`);
      await remove("billing_products", `id=eq.${enc(state.product_id)}`);
    }
  });
  stamp(state, "cleaned_up");
  if (existsSync(RESULT_PATH)) {
    const result = JSON.parse(readFileSync(RESULT_PATH, "utf8"));
    writeFileSync(RESULT_PATH, JSON.stringify({ ...result, cleanup: { refund: state.refund ?? null, vendor_cancel: state.vendor_cancel ?? null, timeline: state.timeline } }, null, 2), { mode: 0o600 });
  }
  unlinkSync(STATE_PATH);
  log("cleanup complete; synthetic product, office, patient, order and allowance removed");
}

/* --------------------------------- main ---------------------------------- */

const command = process.argv[2];
try {
  requireAuthorization();
  if (command === "prepare") await prepare();
  else if (command === "checkout") await checkout();
  else if (command === "wait") await wait();
  else if (command === "cleanup") await cleanup();
  else if (command === "status") console.log(existsSync(STATE_PATH) ? readFileSync(STATE_PATH, "utf8") : "No state.");
  else throw new Error("Usage: sandbox-verification-run.mts prepare|checkout|wait|cleanup|status");
} catch (error) {
  console.error(safeError(error));
  process.exitCode = process.exitCode || 1;
}
