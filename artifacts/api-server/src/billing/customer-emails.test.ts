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
function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (["select", "order", "limit"].includes(key)) continue;
    if (raw === "is.null") { if (row[key] != null) return false; continue; }
    if (raw === "is.false") { if (row[key] !== false) return false; continue; }
    if (raw.startsWith("eq.") && String(row[key]) !== decodeURIComponent(raw.slice(3))) return false;
    const bound = /^(gte|lte)\.(.*)$/.exec(raw);
    if (bound) {
      if (row[key] == null) return false;
      const compare = String(row[key]).localeCompare(decodeURIComponent(bound[2]));
      if (bound[1] === "gte" ? compare < 0 : compare > 0) return false;
    }
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
      const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...input };
      rows.push(row);
      return { status: 201, json: [row] };
    }
    return { status: 204, json: null };
  }),
}));

import { __setEmailClientForTests } from "../email/transport";
import {
  notifyOnce, notifyOrderConfirmationIfCartComplete, notifyRenewalReminder,
  notifyShipmentTransition, notifySubscriptionEvent, notifySubscriptionStarted, renewalReminderDays, subscriptionLinks,
} from "./customer-emails";
import type { BillingOrderRow, BillingShipmentRow, BillingSubscriptionRow } from "./store";

const sent: Array<{ from: string; to: string; subject: string; html: string; text: string }> = [];
let transportFailure: Error | null = null;
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
  process.env.PATIENT_APP_URL = "https://app.example.test/";
  delete process.env.BILLING_RENEWAL_REMINDER_DAYS;
  process.env.RESEND_API_KEY = "test";
  process.env.CLAIM_EMAIL_FROM = "THINNR <hello@example.test>";
  __setEmailClientForTests({
    async send(message) {
      if (transportFailure) throw transportFailure;
      sent.push(message);
      return { id: null };
    },
  });
  tables = {
    billing_customer_emails: [],
    billing_payers: [{ ...scope, id: "payer-1", name: "Riley Example", email: "riley@example.test" }],
    billing_products: [{ id: "product-1", name: "Control" }, { id: "product-2", name: "Balance" }],
    providers: [{ provider_id: "office-1", office_name: "Harbor Health", provider_name: "Dr. Harbor", email: "care@harbor.test" }],
    billing_orders: [], billing_order_items: [], billing_subscriptions: [subscription()],
  };
});

afterAll(() => __setEmailClientForTests(null));

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
  it("never throws: a failed send is recorded on the claim and not retried", async () => {
    transportFailure = new Error("Resend send failed (500)");
    const compose = async () => ({ to: "riley@example.test", variables: { productName: "Control", officeName: "Harbor Health" } });
    expect(await notifyOnce("paused:y:1", "subscription-paused", { subscription_id: SUB_ID }, compose)).toBe("failed");
    expect(tables.billing_customer_emails[0]).toMatchObject({ status: "failed", error: "Resend send failed (500)" });
    transportFailure = null;
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
