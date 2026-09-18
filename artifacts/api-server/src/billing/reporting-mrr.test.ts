import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  queries: [] as Array<{ table: string; query: string }>,
  rows: {} as Record<string, unknown[] | ((query: string) => unknown[])>,
}));
vi.mock("./store", () => ({
  encodeCursor: () => "",
  pagination: () => ({ limit: 50, cursor: null }),
  selectMany: async (table: string, query = "") => {
    state.queries.push({ table, query });
    const rows = state.rows[table];
    return typeof rows === "function" ? rows(query) : rows ?? [];
  },
}));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: async () => ({ status: 200, json: [] }) }));

import { monthlyRecurringRevenueCents, officeDashboard, type RecurringRevenueRow } from "./reporting";

/** Reference normalization: yearly shipments × price, over 12 months. */
const monthly = (unitCents: number, weeks: number, quantity = 1) => Math.round((unitCents * quantity * 52) / weeks / 12);

type Row = RecurringRevenueRow & { shipping_charge_cents?: number };
const sub = (unit_price_cents: number, cadence_weeks: number, quantity = 1, status = "active"): Row =>
  ({ status, unit_price_cents, cadence_weeks, quantity, shipping_charge_cents: 995 });

describe("monthly recurring revenue", () => {
  it("normalizes every offered cadence from weeks to a calendar month", () => {
    // $100 per shipment; 52/12 weeks in a month.
    const expected = (weeks: number) => monthly(10_000, weeks);
    expect(monthlyRecurringRevenueCents([sub(10_000, 2)])).toBe(expected(2));
    expect(monthlyRecurringRevenueCents([sub(10_000, 4)])).toBe(expected(4));
    expect(monthlyRecurringRevenueCents([sub(10_000, 6)])).toBe(expected(6));
    expect(monthlyRecurringRevenueCents([sub(10_000, 8)])).toBe(expected(8));
    expect(monthlyRecurringRevenueCents([sub(10_000, 10)])).toBe(expected(10));
    expect(monthlyRecurringRevenueCents([sub(10_000, 12)])).toBe(expected(12));
    expect(expected(2)).toBe(21_667);
    expect(expected(4)).toBe(10_833);
    expect(expected(12)).toBe(3_611);
  });
  it("multiplies by quantity and excludes the shipping charge", () => {
    expect(monthlyRecurringRevenueCents([sub(7_199, 4, 3)])).toBe(monthly(7_199, 4, 3));
    // A shipping charge on the row never changes the figure.
    const shipped: Row = { ...sub(7_199, 4), shipping_charge_cents: 5_000 };
    expect(monthlyRecurringRevenueCents([shipped])).toBe(monthly(7_199, 4));
  });
  it("counts active subscriptions only", () => {
    const rows = [sub(10_000, 4, 1, "active"), sub(10_000, 4, 1, "past_due"), sub(10_000, 4, 1, "unpaid"), sub(10_000, 4, 1, "canceled"), sub(10_000, 4, 1, "incomplete")];
    expect(monthlyRecurringRevenueCents(rows)).toBe(10_833);
    expect(monthlyRecurringRevenueCents([])).toBe(0);
  });
  it("treats legacy rows without a plan as 4 weeks × 1 and rounds the total once", () => {
    expect(monthlyRecurringRevenueCents([{ status: "active", unit_price_cents: 7_999 }])).toBe(monthly(7_999, 4));
    expect(monthlyRecurringRevenueCents([{ status: "active", unit_price_cents: 7_999, cadence_weeks: null, quantity: 0 }])).toBe(monthly(7_999, 4));
    // Three 2-week rows at $33.33: sum first (rounding each would drift by a cent).
    const three = monthlyRecurringRevenueCents([sub(3_333, 2), sub(3_333, 2), sub(3_333, 2)]);
    expect(three).toBe(21_665);
    expect(three).not.toBe(3 * monthly(3_333, 2));
  });
});

describe("office dashboard recurring revenue fields", () => {
  it("reads plan columns for active rows, reports MRR and the failed-payment count", async () => {
    state.queries.length = 0;
    state.rows = {
      billing_orders: [],
      billing_subscriptions: (query: string) => query.includes("status=eq.active")
        ? [sub(7_199, 4, 2), sub(5_999, 8)]
        : query.includes("status=in.(past_due,unpaid)") ? [{ id: "s3", status: "past_due" }, { id: "s4", status: "unpaid" }] : [],
    };
    const dashboard = await officeDashboard("office-1", { from: "2026-09-01", to: "2026-09-07" });
    const active = state.queries.find((q) => q.table === "billing_subscriptions" && q.query.includes("status=eq.active"));
    expect(active?.query).toContain("select=id,status,unit_price_cents,quantity,cadence_weeks");
    expect(dashboard.active_subscriptions).toBe(2);
    expect(dashboard.mrr_cents).toBe(Math.round(((7_199 * 2 * 52) / 4 + (5_999 * 52) / 8) / 12));
    expect(dashboard.needs_attention_subscriptions).toBe(2);
    expect(dashboard.account_connected).toBe(false);
    expect(dashboard.series).toHaveLength(7);
  });
  it("reports $0 and zero subscriptions for an office with none", async () => {
    state.rows = { billing_orders: [], billing_subscriptions: [] };
    const dashboard = await officeDashboard("office-2", { from: "2026-09-01", to: "2026-09-01" });
    expect(dashboard.mrr_cents).toBe(0);
    expect(dashboard.active_subscriptions).toBe(0);
    expect(dashboard.needs_attention_subscriptions).toBe(0);
  });
});
