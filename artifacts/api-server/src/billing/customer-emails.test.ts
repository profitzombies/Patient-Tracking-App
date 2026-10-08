import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it as test, vi } from "vitest";
import { runWithBillingIdentity } from "./stripe-environment";
const scope = { stripe_mode: "live" as const, stripe_platform_account_id: "acct_live" };
const it = (name: string, fn: () => unknown) => test(name, () =>
  runWithBillingIdentity({ mode: "live", platformAccountId: "acct_live" }, fn));

/**
 * In-memory PostgREST stand-in that enforces the one constraint these emails
 * depend on: billing_customer_emails.dedupe_key is unique, so a second claim
 * for the same transition comes back 23505 exactly like Postgres would.
 */
type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
function matchesOne(row: Row, key: string, raw: string): boolean {
  if (raw === "is.null") return row[key] == null;
  if (raw === "is.false") return row[key] === false;
  if (raw === "is.true") return row[key] === true;
  if (raw.startsWith("eq.")) return String(row[key]) === decodeURIComponent(raw.slice(3));
  if (raw.startsWith("in.(")) return raw.slice(4, -1).split(",").map((v) => decodeURIComponent(v).replace(/^"|"$/g, "")).includes(String(row[key]));
  if (raw.startsWith("ilike.")) {
    const needle = decodeURIComponent(raw.slice(6)).replace(/^\*|\*$/g, "").toLowerCase();
    return String(row[key] ?? "").toLowerCase().includes(needle);
  }
  const bound = /^(gte|lte|lt)\.(.*)$/.exec(raw);
  if (bound) {
    if (row[key] == null) return false;
    const compare = String(row[key]).localeCompare(decodeURIComponent(bound[2]));
    return bound[1] === "gte" ? compare >= 0 : bound[1] === "lte" ? compare <= 0 : compare < 0;
  }
  return true;
}
/** Splits a PostgREST or=(a,b,c(d,e)) list at top-level commas. */
function splitClauses(text: string): string[] {
  const parts: string[] = []; let depth = 0; let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1; if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { parts.push(current); current = ""; } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
}
function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (["select", "order", "limit"].includes(key)) continue;
    if (key === "or") {
      const ok = splitClauses(raw.slice(1, -1)).some((clause) => {
        if (clause.startsWith("and(")) return splitClauses(clause.slice(4, -1)).every((inner) => { const dot = inner.indexOf("."); return matchesOne(row, inner.slice(0, dot), inner.slice(dot + 1)); });
        const dot = clause.indexOf("."); return matchesOne(row, clause.slice(0, dot), clause.slice(dot + 1));
      });
      if (!ok) return false;
      continue;
    }
    if (!matchesOne(row, key, raw)) return false;
  }
  return true;
}
vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: vi.fn(async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://db${path}`);
    const table = url.pathname.split("/").at(-1)!;
    const rows = tables[table] ?? (tables[table] = []);
    if (method === "GET") return { status: 200, json: rows.filter((row) => matches(row, url.searchParams)) };
    if (method === "PATCH") {
      const selected = rows.filter((row) => matches(row, url.searchParams));
      selected.forEach((row) => Object.assign(row, body as Row, { updated_at: new Date().toISOString() }));
      return { status: 200, json: selected };
    }
    if (method === "POST") {
      const input = body as Row;
      if (table === "billing_customer_emails" && rows.some((row) => row.dedupe_key === input.dedupe_key)) {
        return { status: 409, json: { code: "23505", message: "duplicate key value violates unique constraint \"billing_customer_emails_dedupe_key_unique\"", details: "" } };
      }
      if (table === "billing_notification_contacts" && rows.some((row) => row.active && row.payer_id === input.payer_id && row.email === input.email)) {
        return { status: 409, json: { code: "23505", message: "duplicate key value violates unique constraint \"billing_notification_contacts_active_unique\"", details: "" } };
      }
      const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...input };
      rows.push(row);
      return { status: 201, json: [row] };
    }
    return { status: 204, json: null };
  }),
}));

import { __setEmailClientForTests } from "../email/transport";
import type { JobContext } from "../jobs/types";
import {
  CustomerEmailError, MAX_EMAIL_ATTEMPTS, backoffMs, drainDueRetries, renderLedgerPreview, sendAgain,
} from "./customer-email-ledger";
import { customerEmailRetriesJob } from "../jobs/definitions/customer-email-retries";
import {
  notifyOnce, notifyOrderConfirmationIfCartComplete, notifyRenewalReminder,
  notifyShipmentTransition, notifySubscriptionEvent, notifySubscriptionStarted, renewalReminderDays, subscriptionLinks,
} from "./customer-emails";
import type { BillingCustomerEmailRow, BillingOrderRow, BillingShipmentRow, BillingSubscriptionRow } from "./store";
import { __setSandboxVerificationsForTests } from "./sandbox-verification";
import { LIVE_WAREHOUSE_LOGIN } from "../shipping/warehousecraft";

/** A live warehouse tenant needs the flag AND the complete live login (WAREHOUSECRAFT_API_*). */
const stubLiveWarehouseTenant = () => {
  vi.stubEnv("WAREHOUSECRAFT_TENANT_MODE", "live");
  for (const name of LIVE_WAREHOUSE_LOGIN) vi.stubEnv(name, `live-${name.toLowerCase()}`);
};

const sent: Array<{ from: string; to: string; subject: string; html: string; text: string }> = [];
let transportFailure: Error | null = null;
let vendorMessageId: string | null = null;
/** Minimal JobContext for the retry drain: tallies and checkpoints are recorded, nothing else. */
function jobContext(at: string, dryRun = false): JobContext & { tallies: Record<string, number>; failures: string[] } {
  const tallies: Record<string, number> = {};
  const failures: string[] = [];
  return {
    now: new Date(at), dryRun, leaseLost: false, tallies, failures,
    tally: (key: string, by = 1) => { tallies[key] = (tallies[key] ?? 0) + by; },
    checkpoint: () => undefined, log: () => undefined,
    failItem: (item: string) => { failures.push(item); },
  } as unknown as JobContext & { tallies: Record<string, number>; failures: string[] };
}
const SUB_ID = "0a1b2c3d-0000-4000-8000-00000000aa01";
const subscription = (over: Partial<BillingSubscriptionRow> = {}): BillingSubscriptionRow => ({
  id: SUB_ID, provider_id: "office-1", payer_id: "payer-1", patient_id: "patient-1", product_id: "product-1",
  stripe_subscription_id: "sub_1", stripe_customer_id: "cus_1", status: "active", unit_price_cents: 6999,
  shipping_charge_cents: 0, shipping_cost_cents: 0, application_fee_cents: 1000,
  shipping_address: { name: "Riley Example", line1: "12 Harbor Lane", city: "Austin", state: "TX", postal_code: "78701", country: "US" },
  current_period_end: "2026-10-12T16:00:00.000Z", cancel_at_period_end: false, canceled_at: null, cancel_token: "tok",
  ...scope, livemode: true, last_payment_failed_at: null, payment_failure_count: 0, last_failed_invoice_id: null,
  last_hosted_invoice_url: null, last_failure_message: null, payment_failure_email_sent_invoice_id: null,
  last_paid_invoice_id: null, paused_at: null, pending_product_id: null, pending_unit_price_cents: null,
  pending_application_fee_cents: null, pending_effective_at: null, pending_shipping_charge_cents: null,
  pending_stripe_price_id: null, cadence_weeks: 4, quantity: 1, next_shipment_at: "2026-10-12T16:00:00.000Z",
  created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z", ...over,
});
const order = (over: Partial<BillingOrderRow> = {}): BillingOrderRow => ({
  ...scope, livemode: true,
  id: "order-1", order_number: "TH-1", provider_id: "office-1", payer_id: "payer-1", patient_id: "patient-1",
  status: "paid", subtotal_cents: 5999, shipping_charge_cents: 0, tax_cents: 0, total_cents: 5999,
  shipping_address: { name: "Riley Example", line1: "12 Harbor Lane", city: "Austin", state: "TX", postal_code: "78701", country: "US" },
  paid_at: "2026-09-14T15:24:00.000Z", created_at: "2026-09-14T15:20:00.000Z", fulfillment_status: "to_ship",
  carrier: null, tracking_number: null, shipped_at: null, shipped_by: null, canceled_reason: null,
  subscription_id: null, cart_id: "cart-1", ...over,
} as BillingOrderRow);

beforeEach(() => {
  sent.length = 0;
  transportFailure = null;
  vendorMessageId = null;
  process.env.PATIENT_APP_URL = "https://app.example.test/";
  delete process.env.BILLING_RENEWAL_REMINDER_DAYS;
  process.env.RESEND_API_KEY = "test";
  process.env.CLAIM_EMAIL_FROM = "THINNR <hello@example.test>";
  __setEmailClientForTests({
    async send(message) {
      if (transportFailure) throw transportFailure;
      sent.push(message);
      return { id: vendorMessageId };
    },
  });
  tables = {
    billing_customer_emails: [],
    billing_payers: [{ ...scope, id: "payer-1", name: "Riley Example", email: "riley@example.test" }],
    billing_products: [{ id: "product-1", name: "Control" }, { id: "product-2", name: "Balance" }],
    providers: [{ provider_id: "office-1", office_name: "Harbor Health", provider_name: "Dr. Harbor", email: "care@harbor.test" }],
    billing_orders: [], billing_order_items: [], billing_subscriptions: [subscription()],
    billing_notification_contacts: [], billing_customer_email_events: [],
  };
});

afterAll(() => __setEmailClientForTests(null));

describe("sandbox verification allowance", () => {
  const testScope = { stripe_mode: "test" as const, stripe_platform_account_id: "acct_test" };
  const inTest = <T,>(fn: () => Promise<T>) => runWithBillingIdentity({ mode: "test", platformAccountId: "acct_test" }, fn);
  const sandboxOrder = () => order({ ...testScope, livemode: false, id: "order-sbx", order_number: "TH-SBX" });
  const flag = (expiresAt = "2999-01-01T00:00:00.000Z") => [{ order_id: "order-sbx", designated_inbox: "qa-inbox@example.test", authorized_by: "tester", note: null, created_at: "2026-09-14T15:00:00.000Z", expires_at: expiresAt }];
  const shipped = { id: "ship-sbx", order_id: "order-sbx", provider_id: "office-1", status: "shipped", carrier: "UPS", tracking_number: "1Z9", tracking_url: "https://www.ups.com/track?tracknum=1Z9", source: "provider", external_id: "1", label_created_at: null, shipped_at: "2026-09-15T12:00:00.000Z", delivered_at: null, canceled_at: null, canceled_reason: null, events: [], updated_by: null, created_at: "", updated_at: "" } as unknown as BillingShipmentRow;
  beforeEach(() => {
    vi.stubEnv("WAREHOUSECRAFT_TENANT_MODE", "test");
    tables.billing_orders = [sandboxOrder()];
    tables.billing_payers = [{ ...testScope, id: "payer-1", name: "Riley Example", email: "riley@example.test" }];
    tables.billing_notification_contacts = [{ ...testScope, id: "contact-1", payer_id: "payer-1", email: "aunt@example.test", active: true }];
    __setSandboxVerificationsForTests(null);
  });
  afterAll(() => { vi.unstubAllEnvs(); __setSandboxVerificationsForTests(null); });
  test("an unflagged sandbox order stays silent in the test scope", async () => {
    expect(await inTest(() => notifyShipmentTransition(sandboxOrder(), shipped, "processing"))).toBe("skipped");
    expect(sent).toEqual([]);
    expect(tables.billing_customer_emails).toEqual([]);
  });
  test("a flagged sandbox order under the sandbox tenant emails the designated inbox only, never the payer or contacts", async () => {
    __setSandboxVerificationsForTests(flag());
    expect(await inTest(() => notifyShipmentTransition(sandboxOrder(), shipped, "processing"))).toBe("sent");
    expect(await inTest(() => notifyShipmentTransition(sandboxOrder(), shipped, "processing"))).toBe("duplicate");
    expect(sent.map((message) => message.to)).toEqual(["qa-inbox@example.test"]);
    expect(sent[0].subject).toBe("THINNR Order (TH-SBX) has shipped");
    expect(tables.billing_customer_emails).toEqual([expect.objectContaining({ order_id: "order-sbx", recipient: "qa-inbox@example.test", status: "sent", kind: "automatic" })]);
  });
  test("the flag is ignored under a live warehouse tenant, once expired, and for live-mode orders", async () => {
    __setSandboxVerificationsForTests(flag());
    stubLiveWarehouseTenant();
    expect(await inTest(() => notifyShipmentTransition(sandboxOrder(), shipped, "processing"))).toBe("skipped");
    vi.stubEnv("WAREHOUSECRAFT_TENANT_MODE", "test");
    __setSandboxVerificationsForTests(flag("2020-01-01T00:00:00.000Z"));
    expect(await inTest(() => notifyShipmentTransition(sandboxOrder(), shipped, "processing"))).toBe("skipped");
    // A real order flagged by mistake is still governed by the live rules: nothing in the test scope.
    __setSandboxVerificationsForTests(flag());
    tables.billing_orders = [order({ ...testScope, id: "order-sbx", order_number: "TH-SBX", livemode: true })];
    expect(await inTest(() => notifyShipmentTransition(tables.billing_orders[0] as BillingOrderRow, shipped, "processing"))).toBe("skipped");
    expect(sent).toEqual([]);
    expect(tables.billing_customer_emails).toEqual([]);
  });
  test("a flagged row's retries drain in the test scope only through the verification pass, and only for flagged orders", async () => {
    __setSandboxVerificationsForTests(flag());
    transportFailure = new Error("Resend send failed (500)");
    expect(await inTest(() => notifyShipmentTransition(sandboxOrder(), shipped, "processing"))).toBe("retrying");
    transportFailure = null;
    const row = tables.billing_customer_emails[0];
    const ctx = jobContext(row.next_attempt_at);
    await inTest(() => drainDueRetries(ctx));
    expect(ctx.tallies).toEqual({});
    const other = jobContext(row.next_attempt_at);
    await inTest(() => drainDueRetries(other, { onlyOrderIds: ["some-other-order"] }));
    expect(other.tallies).toEqual({});
    const pass = jobContext(row.next_attempt_at);
    await inTest(() => drainDueRetries(pass, { onlyOrderIds: ["order-sbx"] }));
    expect(pass.tallies).toEqual({ due: 1, sent: 1 });
    expect(tables.billing_customer_emails[0]).toMatchObject({ status: "sent", attempts: 2, recipient: "qa-inbox@example.test" });
    expect(sent.map((message) => message.to)).toEqual(["qa-inbox@example.test"]);
  });
});

describe("notifyOnce", () => {
  it("suppresses Test effects before claiming, composing, or sending", async () => {
    const compose = vi.fn(async () => ({ to: "riley@example.test", variables: {} }));
    await runWithBillingIdentity({ mode: "test", platformAccountId: "acct_test" }, async () => {
      expect(await notifyOnce("test", "subscription-paused", { subscription_id: SUB_ID }, compose)).toBe("skipped");
    });
    expect(compose).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(tables.billing_customer_emails).toEqual([]);
  });
  it("does not send for test source rows even inside Live context", async () => {
    tables.billing_subscriptions[0].livemode = false;
    const compose = vi.fn(async () => ({ to: "riley@example.test", variables: {} }));
    expect(await notifyOnce("test-row", "subscription-paused", { subscription_id: SUB_ID }, compose)).toBe("skipped");
    expect(compose).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
  it("sends exactly once per dedupe key and records the claim", async () => {
    const compose = vi.fn(async () => ({ to: "riley@example.test", variables: { name: "Riley", productName: "Control", officeName: "Harbor Health", manageLink: "" } }));
    expect(await notifyOnce("paused:x:1", "subscription-paused", { subscription_id: SUB_ID }, compose)).toBe("sent");
    expect(await notifyOnce("paused:x:1", "subscription-paused", { subscription_id: SUB_ID }, compose)).toBe("duplicate");
    expect(compose).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(tables.billing_customer_emails).toEqual([expect.objectContaining({ dedupe_key: "paused:x:1", template_id: "subscription-paused", status: "sent" })]);
  });
  it("never throws: a failed send schedules a retry on the claim and the claim still dedupes", async () => {
    transportFailure = new Error("Resend send failed (500)");
    const compose = async () => ({ to: "riley@example.test", variables: { productName: "Control", officeName: "Harbor Health" } });
    expect(await notifyOnce("paused:y:1", "subscription-paused", { subscription_id: SUB_ID }, compose)).toBe("retrying");
    const row = tables.billing_customer_emails[0];
    expect(row).toMatchObject({ status: "retrying", error: "Resend send failed (500)", attempts: 1, max_attempts: MAX_EMAIL_ATTEMPTS, recipient: "riley@example.test" });
    expect(new Date(row.next_attempt_at).getTime() - new Date(row.last_attempt_at).getTime()).toBe(backoffMs(1));
    expect(row.attempt_log).toEqual([expect.objectContaining({ outcome: "failed", error: "Resend send failed (500)", recipient_domain: "example.test" })]);
    expect(JSON.stringify(row.attempt_log)).not.toContain("riley@");
    transportFailure = null;
    // Dedupe is preserved while the retry is pending: the transition never claims twice.
    expect(await notifyOnce("paused:y:1", "subscription-paused", { subscription_id: SUB_ID }, compose)).toBe("duplicate");
    expect(sent).toHaveLength(0);
  });
  it("records a skip when the payer has no email address or a template variable is missing", async () => {
    expect(await notifyOnce("k1", "subscription-paused", { subscription_id: SUB_ID }, async () => ({ to: null, variables: {} }))).toBe("skipped");
    expect(await notifyOnce("k2", "subscription-paused", { subscription_id: SUB_ID }, async () => ({ to: "a@b.c", variables: {} }))).toBe("failed");
    expect(tables.billing_customer_emails.map((row) => row.status)).toEqual(["skipped", "failed"]);
  });
});

describe("subscription events", () => {
  it("maps each event to its template with the right variables and links", async () => {
    const sub = subscription();
    expect(await notifySubscriptionEvent(sub, { kind: "moved", previous: "2026-10-05T16:00:00.000Z" })).toBe("sent");
    expect(sent[0].subject).toBe("Your next Control shipment moved to Monday, October 12, 2026");
    expect(sent[0].text).toContain("moved from Monday, October 5, 2026");
    expect(sent[0].html).toContain(`https://app.example.test/billing?subscription=${SUB_ID}`);
    expect(await notifySubscriptionEvent(sub, { kind: "skipped", skipped: "2026-09-14T16:00:00.000Z" })).toBe("sent");
    expect(sent[1].subject).toContain("Skipped: your Control shipment on Monday, September 14, 2026");
    expect(await notifySubscriptionEvent(subscription({ paused_at: "2026-09-15T00:00:00.000Z" }), { kind: "paused" })).toBe("sent");
    expect(await notifySubscriptionEvent(subscription({ updated_at: "2026-09-16T00:00:00.000Z" }), { kind: "resumed" })).toBe("sent");
    expect(sent[3].text).toContain("Next shipment: Monday, October 12, 2026");
    expect(await notifySubscriptionEvent(subscription({ updated_at: "2026-09-17T00:00:00.000Z" }), { kind: "plan-changed", previousPlan: "Control every 4 weeks", newPlan: "Control × 2 every 8 weeks" })).toBe("sent");
    expect(sent[4].subject).toBe("Your subscription plan changed to Control × 2 every 8 weeks");
    expect(await notifySubscriptionEvent(subscription({ updated_at: "2026-09-18T00:00:00.000Z" }), { kind: "address-changed" })).toBe("sent");
    expect(sent[5].text).toContain("Ship to: Riley Example, 12 Harbor Lane, Austin, TX 78701, US");
    expect(await notifySubscriptionEvent(sub, { kind: "card-updated", paymentMethod: { id: "pm_1", card: { brand: "visa", last4: "4242" } } })).toBe("sent");
    expect(sent[6].text).toContain("Card on file: Visa ending in 4242");
    expect(sent.every((message) => message.to === "riley@example.test")).toBe(true);
  });
  it("sends the same transition once even when the action is replayed", async () => {
    const sub = subscription({ paused_at: "2026-09-15T00:00:00.000Z" });
    expect(await notifySubscriptionEvent(sub, { kind: "paused" })).toBe("sent");
    expect(await notifySubscriptionEvent(sub, { kind: "paused" })).toBe("duplicate");
    // A later pause is a new transition.
    expect(await notifySubscriptionEvent(subscription({ paused_at: "2026-11-01T00:00:00.000Z" }), { kind: "paused" })).toBe("sent");
    expect(sent).toHaveLength(2);
  });
  it("welcomes a started subscription once with cadence, amount, and next shipment", async () => {
    const sub = subscription({ quantity: 2, shipping_charge_cents: 500 });
    expect(await notifySubscriptionStarted(sub)).toBe("sent");
    expect(await notifySubscriptionStarted(sub)).toBe("duplicate");
    expect(sent[0].subject).toBe("Your Control subscription has started");
    expect(sent[0].text).toContain("charged $144.98 every 4 weeks");
    expect(sent[0].text).toContain("Next shipment: Monday, October 12, 2026");
  });
});

describe("renewal reminder", () => {
  it("reads the lead time from the environment with a blank-safe default", () => {
    expect(renewalReminderDays()).toBe(3);
    process.env.BILLING_RENEWAL_REMINDER_DAYS = "";
    expect(renewalReminderDays()).toBe(3);
    process.env.BILLING_RENEWAL_REMINDER_DAYS = "5";
    expect(renewalReminderDays()).toBe(5);
    process.env.BILLING_RENEWAL_REMINDER_DAYS = "0";
    expect(renewalReminderDays()).toBe(3);
  });
  it("sends once per shipment date with skip and manage links, and again after the date moves", async () => {
    const sub = subscription();
    expect(await notifyRenewalReminder(sub, { card: { brand: "mastercard", last4: "5100" } })).toBe("sent");
    expect(await notifyRenewalReminder(sub, null)).toBe("duplicate");
    const links = subscriptionLinks(SUB_ID);
    expect(sent[0].text).toContain(`Skip this shipment: ${links.skip}`);
    expect(links.skip).toBe(`https://app.example.test/billing?subscription=${SUB_ID}&action=skip`);
    expect(sent[0].html).toContain(links.manage);
    expect(sent[0].text).toContain("charge $69.99 to Mastercard ending in 5100");
    expect(await notifyRenewalReminder(subscription({ next_shipment_at: "2026-10-26T16:00:00.000Z" }), null)).toBe("sent");
    expect(sent[1].text).toContain("your card on file");
  });
  it("fails closed (no email) when the patient app origin is unknown", async () => {
    delete process.env.PATIENT_APP_URL;
    delete process.env.REPLIT_EXPO_DEV_DOMAIN;
    expect(await notifyRenewalReminder(subscription(), null)).toBe("failed");
    expect(sent).toHaveLength(0);
  });
});

describe("order confirmation", () => {
  it("waits for every cart order to settle, then sends one breakdown with one-time items and subscriptions", async () => {
    tables.billing_orders = [
      order({ id: "order-1", order_number: "TH-1", total_cents: 5999 }),
      order({ id: "order-2", order_number: "TH-2", total_cents: 6999, subscription_id: SUB_ID, status: "pending" }),
    ];
    tables.billing_order_items = [
      { ...scope, id: "i1", order_id: "order-1", product_id: "product-2", product_name_snapshot: "Balance", quantity: 1, unit_price_cents: 5999 },
      { ...scope, id: "i2", order_id: "order-2", product_id: "product-1", product_name_snapshot: "Control", quantity: 1, unit_price_cents: 6999 },
    ];
    tables.billing_subscriptions = [subscription()];
    expect(await notifyOrderConfirmationIfCartComplete(tables.billing_orders[0] as BillingOrderRow)).toBe("skipped");
    tables.billing_orders[1].status = "paid";
    expect(await notifyOrderConfirmationIfCartComplete(tables.billing_orders[1] as BillingOrderRow)).toBe("sent");
    expect(await notifyOrderConfirmationIfCartComplete(tables.billing_orders[0] as BillingOrderRow)).toBe("duplicate");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Your THINNR order is confirmed (TH-1, TH-2)");
    expect(sent[0].text).toContain("Balance · $59.99");
    expect(sent[0].text).toContain("Control every 4 weeks · $69.99");
    expect(sent[0].text).toContain("Total charged today: $129.98");
    expect(sent[0].html).toContain(`https://app.example.test/billing?subscription=${SUB_ID}`);
  });
  it("leaves orders outside a cart to the receipt", async () => {
    expect(await notifyOrderConfirmationIfCartComplete(order({ cart_id: null }))).toBe("skipped");
    expect(tables.billing_customer_emails).toHaveLength(0);
  });
});

describe("shipment transitions", () => {
  const shipment = (over: Partial<BillingShipmentRow>): BillingShipmentRow => ({
    id: "ship-1", order_id: "order-1", provider_id: "office-1", status: "processing", carrier: null, tracking_number: null,
    tracking_url: null, source: "staff", external_id: null, label_created_at: null, shipped_at: null, delivered_at: null,
    canceled_at: null, canceled_reason: null, events: [], updated_by: null, created_at: "", updated_at: "", ...over,
  } as BillingShipmentRow);
  it("emails shipped and delivered once each, only on a real status change", async () => {
    tables.billing_orders = [order()];
    const shipped = shipment({ status: "shipped", carrier: "UPS", tracking_number: "1Z9", tracking_url: "https://www.ups.com/track?tracknum=1Z9", shipped_at: "2026-09-15T12:00:00.000Z" });
    expect(await notifyShipmentTransition(order(), shipped, "processing")).toBe("sent");
    expect(await notifyShipmentTransition(order(), shipped, "shipped")).toBe("skipped");
    expect(await notifyShipmentTransition(order(), shipped, "processing")).toBe("duplicate");
    const delivered = shipment({ ...shipped, status: "delivered", delivered_at: "2026-09-18T18:05:00.000Z" });
    expect(await notifyShipmentTransition(order(), delivered, "shipped")).toBe("sent");
    expect(await notifyShipmentTransition(order(), delivered, "shipped")).toBe("duplicate");
    expect(await notifyShipmentTransition(order(), shipment({ status: "canceled" }), "shipped")).toBe("skipped");
    expect(sent.map((message) => message.subject)).toEqual(["THINNR Order (TH-1) has shipped", "Your THINNR order TH-1 was delivered"]);
    expect(sent[0].html).toContain("https://www.ups.com/track?tracknum=1Z9");
    expect(sent[1].text).toContain("Delivered: Sep 18, 2026, 2:05 PM EDT");
  });
});

describe("delivery ledger", () => {
  const compose = async () => ({ to: "riley@example.test", variables: { name: "Riley", productName: "Control", officeName: "Harbor Health", manageLink: "" } });
  const claimRow = () => tables.billing_customer_emails[0] as BillingCustomerEmailRow & Row;
  const dueAt = (row: Row = claimRow()) => row.next_attempt_at as string;

  it("retries a vendor failure from the job until three attempts are spent, then fails for good", async () => {
    transportFailure = new Error("Resend send failed (503)");
    expect(await notifyOnce("paused:r:1", "subscription-paused", { subscription_id: SUB_ID }, compose)).toBe("retrying");
    const firstRetryAt = claimRow().next_attempt_at as string;
    // Not due yet: the drain leaves it alone.
    const early = jobContext(new Date(new Date(firstRetryAt).getTime() - 1000).toISOString());
    await drainDueRetries(early);
    expect(early.tallies).toEqual({});
    expect(claimRow().attempts).toBe(1);
    // Second attempt fails too: still retrying, with the longer backoff.
    const second = jobContext(firstRetryAt);
    await drainDueRetries(second);
    expect(second.tallies).toEqual({ due: 1, retrying: 1 });
    expect(claimRow()).toMatchObject({ status: "retrying", attempts: 2 });
    expect(new Date(dueAt()).getTime() - new Date(firstRetryAt).getTime()).toBe(backoffMs(2));
    // Third attempt is the last one.
    const third = jobContext(dueAt());
    await drainDueRetries(third);
    expect(third.tallies).toEqual({ due: 1, failed: 1 });
    expect(claimRow()).toMatchObject({ status: "failed", attempts: 3, next_attempt_at: null, error: "Resend send failed (503) (gave up after 3 attempts)" });
    expect(claimRow().attempt_log).toHaveLength(3);
    // Nothing is due anymore, even long after; the transition still dedupes.
    const later = jobContext("2030-01-01T00:00:00.000Z");
    await drainDueRetries(later);
    expect(later.tallies).toEqual({});
    transportFailure = null;
    expect(await notifyOnce("paused:r:1", "subscription-paused", { subscription_id: SUB_ID }, compose)).toBe("duplicate");
    expect(sent).toHaveLength(0);
  });

  it("marks the row sent with the vendor message id when a retry succeeds, and re-composes from stored variables", async () => {
    transportFailure = new Error("Resend send failed (500)");
    expect(await notifyOnce("paused:r:2", "subscription-paused", { subscription_id: SUB_ID }, compose)).toBe("retrying");
    transportFailure = null;
    vendorMessageId = "msg_retry_ok";
    // Wipe the source rows: the retry must not need the subscription or payer again.
    tables.billing_subscriptions = [];
    tables.billing_payers = [];
    const ctx = jobContext(dueAt());
    await drainDueRetries(ctx);
    expect(ctx.tallies).toEqual({ due: 1, sent: 1 });
    expect(claimRow()).toMatchObject({ status: "sent", attempts: 2, vendor_message_id: "msg_retry_ok", next_attempt_at: null, error: null });
    expect(claimRow().sent_at).toBe(ctx.now.toISOString());
    expect(claimRow().subject).toBe(sent[0].subject);
    expect(claimRow().attempt_log.map((entry: Row) => entry.outcome)).toEqual(["failed", "sent"]);
    expect(claimRow().attempt_log[1].vendor_message_id).toBe("msg_retry_ok");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("riley@example.test");
  });

  it("dry runs count due retries without sending, and the job is registered for the live scope", async () => {
    transportFailure = new Error("Resend send failed (500)");
    await notifyOnce("paused:r:3", "subscription-paused", { subscription_id: SUB_ID }, compose);
    transportFailure = null;
    const ctx = jobContext(dueAt(), true);
    await drainDueRetries(ctx);
    expect(ctx.tallies).toEqual({ due: 1, wouldRetry: 1 });
    expect(claimRow()).toMatchObject({ status: "retrying", attempts: 1 });
    expect(sent).toHaveLength(0);
    expect(customerEmailRetriesJob).toMatchObject({ name: "customer-email-retries", intervalMs: 60_000 });
  });

  it("never drains in a Test billing scope", async () => {
    transportFailure = new Error("Resend send failed (500)");
    await notifyOnce("paused:r:4", "subscription-paused", { subscription_id: SUB_ID }, compose);
    transportFailure = null;
    const ctx = jobContext(dueAt());
    await runWithBillingIdentity({ mode: "test", platformAccountId: "acct_test" }, () => drainDueRetries(ctx));
    expect(ctx.tallies).toEqual({});
    expect(claimRow().status).toBe("retrying");
  });

  it("refuses PHI and missing variables permanently instead of retrying", async () => {
    expect(await notifyOnce("phi:1", "subscription-paused", { subscription_id: SUB_ID }, async () => ({
      to: "riley@example.test", variables: { ...(await compose()).variables, medicationName: "Semaglutide" },
    }))).toBe("failed");
    expect(claimRow()).toMatchObject({ status: "failed", attempts: 1, next_attempt_at: null });
    expect(claimRow().error).toContain("medicationName");
    expect(await notifyOnce("missing:1", "subscription-paused", { subscription_id: SUB_ID }, async () => ({ to: "riley@example.test", variables: { name: "Riley" } }))).toBe("failed");
    expect(tables.billing_customer_emails[1]).toMatchObject({ status: "failed", attempts: 1, next_attempt_at: null });
    expect(sent).toHaveLength(0);
  });

  it("resends and sends to another address as linked rows that never touch the original claim", async () => {
    vendorMessageId = "msg_first";
    expect(await notifyOnce("paused:s:1", "subscription-paused", { subscription_id: SUB_ID }, compose)).toBe("sent");
    const original = { ...claimRow() };
    vendorMessageId = "msg_resend";
    const resend = await sendAgain(claimRow(), { kind: "resend", requestedBy: "staff-1" });
    expect(resend.outcome).toBe("sent");
    expect(resend.row).toMatchObject({
      kind: "resend", parent_id: original.id, recipient: "riley@example.test", template_id: "subscription-paused",
      status: "sent", vendor_message_id: "msg_resend", requested_by: "staff-1", variables: original.variables,
    });
    expect(resend.row.dedupe_key).not.toBe(original.dedupe_key);
    const other = await sendAgain(claimRow(), { kind: "send_to_other", to: " Spouse@Example.test ", requestedBy: "staff-1" });
    expect(other.row).toMatchObject({ kind: "send_to_other", parent_id: original.id, recipient: "spouse@example.test", status: "sent" });
    expect(sent.map((message) => message.to)).toEqual(["riley@example.test", "riley@example.test", "spouse@example.test"]);
    expect(sent[2].subject).toBe(sent[0].subject);
    expect(tables.billing_customer_emails[0]).toEqual(original);
    // The automatic transition is still spent.
    expect(await notifyOnce("paused:s:1", "subscription-paused", { subscription_id: SUB_ID }, compose)).toBe("duplicate");
    await expect(sendAgain(claimRow(), { kind: "send_to_other", to: "not-an-address", requestedBy: null })).rejects.toMatchObject({ status: 400 });
    await expect(runWithBillingIdentity({ mode: "test", platformAccountId: "acct_test" }, () =>
      sendAgain(claimRow(), { kind: "resend", requestedBy: null }))).rejects.toBeInstanceOf(CustomerEmailError);
    expect(tables.billing_customer_emails).toHaveLength(3);
  });

  it("a resend that the vendor rejects gets its own retry budget", async () => {
    expect(await notifyOnce("paused:s:2", "subscription-paused", { subscription_id: SUB_ID }, compose)).toBe("sent");
    transportFailure = new Error("Resend send failed (500)");
    const resend = await sendAgain(claimRow(), { kind: "resend", requestedBy: "staff-1" });
    expect(resend.outcome).toBe("retrying");
    expect(resend.row).toMatchObject({ kind: "resend", status: "retrying", attempts: 1 });
    expect(claimRow().status).toBe("sent");
    transportFailure = null;
    const ctx = jobContext(resend.row.next_attempt_at as string);
    await drainDueRetries(ctx);
    expect(tables.billing_customer_emails[1]).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("previews re-render from the stored template and variables, never from a stored body", async () => {
    expect(await notifyOnce("paused:p:1", "subscription-paused", { subscription_id: SUB_ID }, compose)).toBe("sent");
    const preview = renderLedgerPreview(claimRow());
    expect(preview.subject).toBe(sent[0].subject);
    expect(preview.html).toBe(sent[0].html);
    expect(preview.text).toBe(sent[0].text);
    expect(Object.keys(claimRow())).not.toContain("html");
    expect(() => renderLedgerPreview({ ...claimRow(), variables: null })).toThrow(CustomerEmailError);
  });

  it("copies order and shipment emails to the payer's active additional contacts as separate rows with their own budgets", async () => {
    tables.billing_notification_contacts = [
      { ...scope, id: "contact-1", payer_id: "payer-1", provider_id: "office-1", email: "spouse@example.test", active: true, created_at: "2026-09-01T00:00:00.000Z" },
      { ...scope, id: "contact-2", payer_id: "payer-1", provider_id: "office-1", email: "old@example.test", active: false, created_at: "2026-09-02T00:00:00.000Z" },
      { ...scope, id: "contact-3", payer_id: "payer-1", provider_id: "office-1", email: "riley@example.test", active: true, created_at: "2026-09-03T00:00:00.000Z" },
      { ...scope, id: "contact-9", payer_id: "payer-9", provider_id: "office-1", email: "stranger@example.test", active: true, created_at: "2026-09-04T00:00:00.000Z" },
    ];
    const sub = subscription();
    expect(await notifySubscriptionEvent(sub, { kind: "moved", previous: "2026-10-05T16:00:00.000Z" })).toBe("sent");
    expect(sent.map((message) => message.to)).toEqual(["riley@example.test", "spouse@example.test"]);
    expect(sent[1].subject).toBe(sent[0].subject);
    expect(sent[1].html).toBe(sent[0].html);
    const [primary, copy] = tables.billing_customer_emails;
    expect(copy).toMatchObject({
      kind: "automatic", parent_id: primary.id, contact_id: "contact-1", payer_id: "payer-1", recipient: "spouse@example.test",
      template_id: "subscription-shipment-moved", status: "sent", dedupe_key: `${primary.dedupe_key}:contact:contact-1`,
      subscription_id: SUB_ID, variables: primary.variables, attempts: 1, max_attempts: MAX_EMAIL_ATTEMPTS,
    });
    expect(tables.billing_customer_emails).toHaveLength(2);
    // Replaying the transition sends nothing more to anyone.
    expect(await notifySubscriptionEvent(sub, { kind: "moved", previous: "2026-10-05T16:00:00.000Z" })).toBe("duplicate");
    expect(sent).toHaveLength(2);
    // Account notices stay with the payer only.
    expect(await notifySubscriptionEvent(subscription({ paused_at: "2026-09-15T00:00:00.000Z" }), { kind: "paused" })).toBe("sent");
    expect(sent).toHaveLength(3);
    expect(sent[2].to).toBe("riley@example.test");
  });

  it("a contact copy that fails retries on its own without holding up the payer's email", async () => {
    tables.billing_notification_contacts = [
      { ...scope, id: "contact-1", payer_id: "payer-1", provider_id: "office-1", email: "spouse@example.test", active: true, created_at: "2026-09-01T00:00:00.000Z" },
    ];
    let calls = 0;
    __setEmailClientForTests({
      async send(message) {
        calls += 1;
        if (message.to === "spouse@example.test" && calls < 3) throw new Error("Resend send failed (500)");
        sent.push(message);
        return { id: `msg_${calls}` };
      },
    });
    expect(await notifySubscriptionEvent(subscription(), { kind: "moved", previous: "2026-10-05T16:00:00.000Z" })).toBe("sent");
    const [primary, copy] = tables.billing_customer_emails;
    expect(primary.status).toBe("sent");
    expect(copy).toMatchObject({ status: "retrying", attempts: 1, recipient: "spouse@example.test" });
    const ctx = jobContext(dueAt(copy));
    await drainDueRetries(ctx);
    expect(ctx.tallies).toEqual({ due: 1, sent: 1 });
    expect(copy).toMatchObject({ status: "sent", attempts: 2, vendor_message_id: "msg_3" });
    expect(sent.map((message) => message.to)).toEqual(["riley@example.test", "spouse@example.test"]);
  });
});
