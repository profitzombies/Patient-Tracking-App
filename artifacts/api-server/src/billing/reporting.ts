import { selectMany } from "./store";
import type { HqOverview, OfficeDashboard, SeriesPoint } from "./types";

export class BillingReportingError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export function reportRange(input: { from?: unknown; to?: unknown }) {
  const to = typeof input.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.to) ? input.to : new Date().toISOString().slice(0, 10);
  const fallback = new Date(`${to}T00:00:00.000Z`); fallback.setUTCDate(fallback.getUTCDate() - 29);
  const from = typeof input.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.from) ? input.from : fallback.toISOString().slice(0, 10);
  if (from > to) throw new BillingReportingError("The start date must be before the end date.", 400);
  return { from, to, start: `${from}T00:00:00.000Z`, end: `${to}T23:59:59.999Z` };
}
function points(from: string, to: string): Map<string, SeriesPoint> {
  const result = new Map<string, SeriesPoint>();
  for (let date = new Date(`${from}T00:00:00Z`); date <= new Date(`${to}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1)) {
    const key = date.toISOString().slice(0, 10);
    result.set(key, { date: key, collected_cents: 0, net_cents: 0, fee_cents: 0 });
  }
  return result;
}
export async function officeDashboard(providerId: string, input: { from?: unknown; to?: unknown }): Promise<OfficeDashboard> {
  const range = reportRange(input);
  const [orders, subscriptions] = await Promise.all([
    selectMany("billing_orders", `provider_id=eq.${encodeURIComponent(providerId)}&created_at=gte.${range.start}&created_at=lte.${range.end}&order=created_at.asc`),
    selectMany("billing_subscriptions", `provider_id=eq.${encodeURIComponent(providerId)}&status=eq.active&select=id`),
  ]);
  const paid = orders.filter((row) => row.status === "paid" || row.status === "refunded" || row.status === "partially_refunded" || row.status === "disputed");
  const series = points(range.from, range.to);
  for (const row of paid) {
    const point = series.get((row.paid_at ?? row.created_at).slice(0, 10));
    if (!point) continue;
    point.collected_cents += row.total_cents;
    point.net_cents += row.office_net_cents ?? 0;
    point.fee_cents += row.application_fee_collected_cents ?? row.application_fee_cents;
  }
  const refunds = await selectMany("billing_refunds", `created_at=gte.${range.start}&created_at=lte.${range.end}`);
  return {
    balance: { available_cents: 0, pending_cents: 0 }, next_payout: null,
    collected_cents: paid.reduce((sum, row) => sum + row.total_cents, 0),
    thinnr_fee_cents: paid.reduce((sum, row) => sum + (row.application_fee_collected_cents ?? row.application_fee_cents), 0),
    stripe_fee_cents: paid.reduce((sum, row) => sum + (row.stripe_fee_cents ?? 0), 0),
    refunded_cents: refunds.filter((row) => paid.some((order) => order.id === row.order_id)).reduce((sum, row) => sum + row.amount_cents, 0),
    net_cents: paid.reduce((sum, row) => sum + (row.office_net_cents ?? 0), 0),
    orders: paid.length, active_subscriptions: subscriptions.length,
    to_ship: paid.filter((row) => row.fulfillment_status === "to_ship").length,
    series: [...series.values()],
  };
}
export async function hqOverview(input: { from?: unknown; to?: unknown }): Promise<HqOverview> {
  const range = reportRange(input);
  const [orders, refunds, disputes, subscriptions, accounts, ledger] = await Promise.all([
    selectMany("billing_orders", `created_at=gte.${range.start}&created_at=lte.${range.end}&order=created_at.asc`),
    selectMany("billing_refunds", `created_at=gte.${range.start}&created_at=lte.${range.end}`),
    selectMany("billing_disputes", `created_at=gte.${range.start}&created_at=lte.${range.end}`),
    selectMany("billing_subscriptions", "status=eq.active&select=id"),
    selectMany("billing_connected_accounts", "select=provider_id,charges_enabled,payouts_enabled"),
    selectMany("billing_ledger", `occurred_at=gte.${range.start}&occurred_at=lte.${range.end}&order=occurred_at.desc&limit=20`),
  ]);
  const paid = orders.filter((row) => row.status !== "pending" && row.status !== "failed" && row.status !== "canceled");
  const series = points(range.from, range.to);
  for (const row of paid) {
    const point = series.get((row.paid_at ?? row.created_at).slice(0, 10));
    if (point) { point.collected_cents += row.total_cents; point.net_cents += row.office_net_cents ?? 0; point.fee_cents += row.application_fee_cents; }
  }
  return {
    collected_cents: paid.reduce((sum, row) => sum + row.total_cents, 0),
    thinnr_fee_cents: paid.reduce((sum, row) => sum + row.application_fee_cents, 0),
    shipping_charge_cents: paid.reduce((sum, row) => sum + row.shipping_charge_cents, 0),
    hard_cost_cents: paid.reduce((sum, row) => sum + row.hard_cost_cents, 0),
    shipping_cost_cents: paid.reduce((sum, row) => sum + row.shipping_cost_cents, 0),
    profit_cents: paid.reduce((sum, row) => sum + row.hq_profit_cents, 0),
    refunded_cents: refunds.reduce((sum, row) => sum + row.amount_cents, 0),
    disputed_cents: disputes.filter((row) => row.status !== "won").reduce((sum, row) => sum + row.amount_cents, 0),
    orders: paid.length, active_subscriptions: subscriptions.length,
    providers_onboarded: accounts.filter((row) => row.charges_enabled && row.payouts_enabled).length,
    providers_pending: accounts.filter((row) => !row.charges_enabled || !row.payouts_enabled).length,
    to_ship: paid.filter((row) => row.fulfillment_status === "to_ship").length,
    series: [...series.values()],
    recent: ledger.map((row) => ({ id: row.id, kind: row.kind as any, label: row.kind.replace(/_/g, " "),
      office_name: row.provider_id, amount_cents: row.amount_cents, occurred_at: row.occurred_at, order_id: row.order_id })),
  };
}