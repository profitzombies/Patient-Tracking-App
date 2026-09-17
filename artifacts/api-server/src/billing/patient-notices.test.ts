import { describe, expect, it } from "vitest";
import { MemoryNotificationStore } from "../notifications/memory-store";
import {
  notifyOrderShipped,
  notifySubscriptionPaymentFailed,
  ORDER_SHIPPED_KIND,
  PAYMENT_FAILED_KIND,
  RENEWAL_UPCOMING_KIND,
  runRenewalReminderEvaluation,
} from "./patient-notices";
import type { BillingOrderRow, BillingShipmentRow, BillingSubscriptionRow } from "./store";

const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SUB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function order(overrides: Partial<BillingOrderRow> = {}): BillingOrderRow {
  return {
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
    id: SUB, provider_id: "office-1", payer_id: "payer", patient_id: PATIENT, product_id: "prod", status: "active",
    unit_price_cents: 6299, shipping_charge_cents: 1000, quantity: 1, cadence_weeks: 4,
    next_shipment_at: "2026-09-20T12:00:00.000Z", paused_at: null, cancel_at_period_end: false, ...overrides,
  } as BillingSubscriptionRow;
}

describe("order shipped notice", () => {
  it("queues one account-level notice per order with an allow-listable order deep link", async () => {
    const store = new MemoryNotificationStore();
    expect(await notifyOrderShipped({ order: order(), shipment: shipment() }, store)).toBe(true);
    expect(await notifyOrderShipped({ order: order(), shipment: shipment({ tracking_number: "other" }) }, store)).toBe(false);
    const rows = [...store.notifications.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      patient_id: PATIENT, kind: ORDER_SHIPPED_KIND, category: "account", title: "Your order shipped",
      body: "Order TH-1001 is on its way with USPS. Tap to track it.",
      data: { route: `/orders/${ORDER}`, kind: ORDER_SHIPPED_KIND, orderId: ORDER, patientId: PATIENT },
      dedupe_key: `${ORDER_SHIPPED_KIND}:${ORDER}`,
    });
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
      kind: PAYMENT_FAILED_KIND, category: "account", title: "Control payment didn't go through",
      body: "Your card was declined. Tap to retry with a saved card so your next shipment isn't delayed.",
      data: { route: `/my-subscriptions/${SUB}`, kind: PAYMENT_FAILED_KIND, subscriptionId: SUB, patientId: PATIENT, invoiceId: "in_1" },
      dedupe_key: `${PAYMENT_FAILED_KIND}:${SUB}:in_1`,
    });
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
      patient_id: PATIENT, kind: RENEWAL_UPCOMING_KIND, category: "account", title: "Control ships Sep 20",
      body: "Your card will be charged $72.99 before any tax. Tap to move or skip this shipment, or change your card.",
      data: { route: `/my-subscriptions/${SUB}`, kind: RENEWAL_UPCOMING_KIND, subscriptionId: SUB, patientId: PATIENT, shipDate: "2026-09-20" },
      dedupe_key: `${RENEWAL_UPCOMING_KIND}:${SUB}:2026-09-20`,
      expires_at: "2026-09-20T12:00:00.000Z",
    });
    rows = [{ subscription: subscription({ next_shipment_at: "2026-09-19T12:00:00.000Z", quantity: 2 }), productName: "Control" }];
    expect(await runRenewalReminderEvaluation({ store, now, load })).toEqual({ evaluated: 1, queued: 1 });
    const second = [...store.notifications.values()][1];
    expect(second.body).toContain("$135.98");
    expect(second.dedupe_key).toBe(`${RENEWAL_UPCOMING_KIND}:${SUB}:2026-09-19`);
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
