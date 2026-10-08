import { afterEach, describe, expect, it as test, vi } from "vitest";
import { __setSandboxVerificationsForTests } from "./sandbox-verification";
import { runWithBillingIdentity } from "./stripe-environment";
const it = (name: string, fn: () => unknown) => test(name, () =>
  runWithBillingIdentity({ mode: "live", platformAccountId: "acct_live" }, fn));
import { MemoryNotificationStore } from "../notifications/memory-store";
import { guardPushMessage } from "../notifications/push-guard";
import {
  notifyOrderShipped,
  notifySubscriptionPaymentFailed,
  ORDER_SHIPPED_BODY,
  ORDER_SHIPPED_KIND,
  ORDER_SHIPPED_TITLE,
  PAYMENT_FAILED_BODY,
  PAYMENT_FAILED_KIND,
  PAYMENT_FAILED_TITLE,
  RENEWAL_UPCOMING_BODY,
  RENEWAL_UPCOMING_KIND,
  RENEWAL_UPCOMING_TITLE,
  runRenewalReminderEvaluation,
} from "./patient-notices";
import type { BillingOrderRow, BillingShipmentRow, BillingSubscriptionRow } from "./store";
import { LIVE_WAREHOUSE_LOGIN } from "../shipping/warehousecraft";

/** A live warehouse tenant needs the flag AND the complete live login (WAREHOUSECRAFT_API_*). */
const stubLiveWarehouseTenant = () => {
  vi.stubEnv("WAREHOUSECRAFT_TENANT_MODE", "live");
  for (const name of LIVE_WAREHOUSE_LOGIN) vi.stubEnv(name, `live-${name.toLowerCase()}`);
};

/** Vendor-visible copy and data must never carry what the row knows: order number, carrier, product, amount, decline reason. */
function expectPhiFree(row: { title: string; body: string; data: Record<string, unknown> }, forbidden: string[]) {
  const visible = `${row.title} ${row.body} ${JSON.stringify(row.data)}`;
  for (const fragment of forbidden) expect(visible).not.toContain(fragment);
  expect(guardPushMessage({ to: "ExponentPushToken[x]", title: row.title, body: row.body, data: row.data })).toEqual({ ok: true });
}

const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SUB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function order(overrides: Partial<BillingOrderRow> = {}): BillingOrderRow {
  return {
    livemode: true,
    id: ORDER, order_number: "TH-1001", provider_id: "office-1", payer_id: "payer", patient_id: PATIENT,
    kind: "one_time", status: "paid", total_cents: 7999, created_at: "2026-09-10T00:00:00.000Z", ...overrides,
  } as BillingOrderRow;
}
function shipment(overrides: Partial<BillingShipmentRow> = {}): BillingShipmentRow {
  return {
    id: "ship", order_id: ORDER, provider_id: "office-1", status: "shipped", carrier: "USPS",
    tracking_number: "9400", tracking_url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400", ...overrides,
  } as BillingShipmentRow;
}
function subscription(overrides: Partial<BillingSubscriptionRow> = {}): BillingSubscriptionRow {
  return {
    livemode: true,
    id: SUB, provider_id: "office-1", payer_id: "payer", patient_id: PATIENT, product_id: "prod", status: "active",
    unit_price_cents: 6299, shipping_charge_cents: 1000, quantity: 1, cadence_weeks: 4,
    next_shipment_at: "2026-09-20T12:00:00.000Z", paused_at: null, cancel_at_period_end: false, ...overrides,
  } as BillingSubscriptionRow;
}

afterEach(() => { __setSandboxVerificationsForTests(null); vi.unstubAllEnvs(); });

describe("order shipped notice", () => {
  it("never queues a test transaction or a notification inside Test scope", async () => {
    const store = new MemoryNotificationStore();
    expect(await notifyOrderShipped({ order: order({ livemode: false }), shipment: shipment() }, store)).toBe(false);
    await runWithBillingIdentity({ mode: "test", platformAccountId: "acct_test" }, async () => {
      expect(await notifyOrderShipped({ order: order(), shipment: shipment() }, store)).toBe(false);
      expect(await notifySubscriptionPaymentFailed({
        subscription: subscription(), invoiceId: "in_test", productName: "Control", message: "declined",
      }, store)).toBe(false);
    });
  });
  test("queues for a sandbox order only when it is flagged for verification under the sandbox tenant", async () => {
    const flag = [{ order_id: ORDER, designated_inbox: "qa-inbox@example.test", authorized_by: "tester", note: null, created_at: "2026-09-10T00:00:00.000Z", expires_at: "2999-01-01T00:00:00.000Z" }];
    const store = new MemoryNotificationStore();
    const inTest = <T,>(fn: () => Promise<T>) => runWithBillingIdentity({ mode: "test", platformAccountId: "acct_test" }, fn);
    vi.stubEnv("WAREHOUSECRAFT_TENANT_MODE", "test");
    expect(await inTest(() => notifyOrderShipped({ order: order({ livemode: false }), shipment: shipment() }, store))).toBe(false);
    __setSandboxVerificationsForTests(flag);
    stubLiveWarehouseTenant();
    expect(await inTest(() => notifyOrderShipped({ order: order({ livemode: false }), shipment: shipment() }, store))).toBe(false);
    vi.stubEnv("WAREHOUSECRAFT_TENANT_MODE", "test");
    // A real order under the flag still follows the live rules.
    expect(await inTest(() => notifyOrderShipped({ order: order({ livemode: true }), shipment: shipment() }, store))).toBe(false);
    expect(store.notifications.size).toBe(0);
    expect(await inTest(() => notifyOrderShipped({ order: order({ livemode: false }), shipment: shipment() }, store))).toBe(true);
    expect(await inTest(() => notifyOrderShipped({ order: order({ livemode: false }), shipment: shipment() }, store))).toBe(false);
    expect([...store.notifications.values()].map((row) => row.kind)).toEqual(["order_shipped"]);
  });
  it("queues one account-level notice per order with an allow-listable order deep link", async () => {
    const store = new MemoryNotificationStore();
    expect(await notifyOrderShipped({ order: order(), shipment: shipment() }, store)).toBe(true);
    expect(await notifyOrderShipped({ order: order(), shipment: shipment({ tracking_number: "other" }) }, store)).toBe(false);
    const rows = [...store.notifications.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      patient_id: PATIENT, kind: ORDER_SHIPPED_KIND, category: "account", title: ORDER_SHIPPED_TITLE,
      body: ORDER_SHIPPED_BODY,
      data: { route: `/orders/${ORDER}`, kind: ORDER_SHIPPED_KIND, orderId: ORDER, patientId: PATIENT },
      dedupe_key: `${ORDER_SHIPPED_KIND}:${ORDER}`,
    });
    expect(ORDER_SHIPPED_TITLE).toBe("Your order is on its way");
    expectPhiFree(rows[0], ["TH-1001", "USPS", "9400"]);
  });

  it("stays silent for guest orders and for non-shipped states", async () => {
    const store = new MemoryNotificationStore();
    expect(await notifyOrderShipped({ order: order({ patient_id: null }), shipment: shipment() }, store)).toBe(false);
    expect(await notifyOrderShipped({ order: order(), shipment: shipment({ status: "processing", carrier: null }) }, store)).toBe(false);
    expect(await notifyOrderShipped({ order: order(), shipment: shipment({ status: "canceled" }) }, store)).toBe(false);
    expect(store.notifications.size).toBe(0);
  });
});

describe("payment failed notice", () => {
  it("queues once per failed invoice and points at the subscription", async () => {
    const store = new MemoryNotificationStore();
    const input = { subscription: subscription({ status: "past_due" }), productName: "Control", invoiceId: "in_1", message: "Your card was declined" };
    expect(await notifySubscriptionPaymentFailed(input, store)).toBe(true);
    expect(await notifySubscriptionPaymentFailed(input, store)).toBe(false);
    expect(await notifySubscriptionPaymentFailed({ ...input, invoiceId: "in_2" }, store)).toBe(true);
    const rows = [...store.notifications.values()];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: PAYMENT_FAILED_KIND, category: "account", title: PAYMENT_FAILED_TITLE,
      body: PAYMENT_FAILED_BODY,
      data: { route: `/my-subscriptions/${SUB}`, kind: PAYMENT_FAILED_KIND, subscriptionId: SUB, patientId: PATIENT, invoiceId: "in_1" },
      dedupe_key: `${PAYMENT_FAILED_KIND}:${SUB}:in_1`,
    });
    expectPhiFree(rows[0], ["Control", "declined"]);
    expect(await notifySubscriptionPaymentFailed({ ...input, subscription: subscription({ patient_id: null }) }, store)).toBe(false);
  });
});

describe("renewal reminders", () => {
  it("reminds once per subscription and shipment date, and again when the date moves", async () => {
    const store = new MemoryNotificationStore();
    const now = () => new Date("2026-09-17T15:00:00.000Z");
    let rows = [{ subscription: subscription(), productName: "Control" }];
    const load = async () => rows;
    expect(await runRenewalReminderEvaluation({ store, now, load })).toEqual({ evaluated: 1, queued: 1 });
    expect(await runRenewalReminderEvaluation({ store, now, load })).toEqual({ evaluated: 1, queued: 0 });
    const [first] = [...store.notifications.values()];
    expect(first).toMatchObject({
      patient_id: PATIENT, kind: RENEWAL_UPCOMING_KIND, category: "account", title: RENEWAL_UPCOMING_TITLE,
      body: RENEWAL_UPCOMING_BODY,
      data: { route: `/my-subscriptions/${SUB}`, kind: RENEWAL_UPCOMING_KIND, subscriptionId: SUB, patientId: PATIENT, shipDate: "2026-09-20" },
      dedupe_key: `${RENEWAL_UPCOMING_KIND}:${SUB}:2026-09-20`,
      expires_at: "2026-09-20T12:00:00.000Z",
    });
    rows = [{ subscription: subscription({ next_shipment_at: "2026-09-19T12:00:00.000Z", quantity: 2 }), productName: "Control" }];
    expect(await runRenewalReminderEvaluation({ store, now, load })).toEqual({ evaluated: 1, queued: 1 });
    const second = [...store.notifications.values()][1];
    expect(second.dedupe_key).toBe(`${RENEWAL_UPCOMING_KIND}:${SUB}:2026-09-19`);
  });

  it("never puts the product, the amount, or the date on the lock screen", async () => {
    const store = new MemoryNotificationStore();
    const now = () => new Date("2026-09-17T15:00:00.000Z");
    const load = async () => [{ subscription: subscription({ shipping_charge_cents: 1000, unit_price_cents: 6299 }), productName: "Control" }];
    expect(await runRenewalReminderEvaluation({ store, now, load })).toEqual({ evaluated: 1, queued: 1 });
    const [row] = [...store.notifications.values()];
    expectPhiFree(row, ["Control", "$", "Sep 20", "72.99", "62.99"]);
  });

  it("skips rows without a patient or a shipment date", async () => {
    const store = new MemoryNotificationStore();
    const load = async () => [
      { subscription: subscription({ patient_id: null }), productName: "Control" },
      { subscription: subscription({ next_shipment_at: null }), productName: "Control" },
    ];
    expect(await runRenewalReminderEvaluation({ store, load })).toEqual({ evaluated: 2, queued: 0 });
    expect(store.notifications.size).toBe(0);
  });
});
