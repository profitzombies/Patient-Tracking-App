import { encodeCursor, pagination, selectMany, type BillingLedgerRow, type BillingOrderRow, type BillingRefundRow } from "./store";
import { supabaseAdmin } from "../lib/supabase-admin";
import type { HourPoint, HqActivityRow, HqOverview, HqTodayOverview, OfficeDashboard, OfficeRefundRow, SeriesPoint } from "./types";

export class BillingReportingError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export function needsAttentionSubscriptionCount(rows: Array<{ status: string }>): number {
  return rows.filter((row) => row.status === "past_due" || row.status === "unpaid").length;
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
    result.set(key, { date: key, collected_cents: 0, net_cents: 0, fee_cents: 0, refunded_cents: 0, orders: 0 });
  }
  return result;
}
/** PostgREST `in.(...)` list; values are quoted so ids with commas or parens cannot break the filter. */
export function inList(values: string[]): string {
  return `in.(${[...new Set(values)].map((value) => `"${value.replace(/"/g, "")}"`).join(",")})`;
}
/**
 * Refunds that belong to the given orders, inside the range. Scoped by order
 * id whenever the list is small enough for one URL; a very active office
 * falls back to the range scan and filters in memory.
 */
async function refundsFor(orderIds: string[], range: { start: string; end: string }): Promise<BillingRefundRow[]> {
  if (orderIds.length === 0) return [];
  const window = `created_at=gte.${range.start}&created_at=lte.${range.end}`;
  if (orderIds.length <= 150) return selectMany("billing_refunds", `${window}&order_id=${inList(orderIds)}`);
  const wanted = new Set(orderIds);
  return (await selectMany("billing_refunds", window)).filter((row) => wanted.has(row.order_id));
}
/** Bucket paid orders and refunds into one point per calendar day. */
function fillSeries(series: Map<string, SeriesPoint>, paid: BillingOrderRow[], refunds: BillingRefundRow[], fee: (row: BillingOrderRow) => number): void {
  for (const row of paid) {
    const point = series.get((row.paid_at ?? row.created_at).slice(0, 10));
    if (!point) continue;
    point.collected_cents += row.total_cents;
    point.net_cents += row.office_net_cents ?? 0;
    point.fee_cents += fee(row);
    point.orders += 1;
  }
  for (const row of refunds) {
    const point = series.get(row.created_at.slice(0, 10));
    if (point) point.refunded_cents += row.amount_cents;
  }
}
export async function officeDashboard(providerId: string, input: { from?: unknown; to?: unknown }): Promise<OfficeDashboard> {
  const range = reportRange(input);
  const [orders, subscriptions, attention] = await Promise.all([
    selectMany("billing_orders", `provider_id=eq.${encodeURIComponent(providerId)}&created_at=gte.${range.start}&created_at=lte.${range.end}&order=created_at.asc`),
    selectMany("billing_subscriptions", `provider_id=eq.${encodeURIComponent(providerId)}&status=eq.active&select=id`),
    selectMany("billing_subscriptions", `provider_id=eq.${encodeURIComponent(providerId)}&status=in.(past_due,unpaid)&select=id`),
  ]);
  const paid = orders.filter((row) => row.status === "paid" || row.status === "refunded" || row.status === "partially_refunded" || row.status === "disputed");
  const refunds = await refundsFor(paid.map((row) => row.id), range);
  const series = points(range.from, range.to);
  fillSeries(series, paid, refunds, (row) => row.application_fee_collected_cents ?? row.application_fee_cents);
  return {
    balance: { available_cents: 0, pending_cents: 0 }, next_payout: null,
    collected_cents: paid.reduce((sum, row) => sum + row.total_cents, 0),
    thinnr_fee_cents: paid.reduce((sum, row) => sum + (row.application_fee_collected_cents ?? row.application_fee_cents), 0),
    stripe_fee_cents: paid.reduce((sum, row) => sum + (row.stripe_fee_cents ?? 0), 0),
    refunded_cents: refunds.reduce((sum, row) => sum + row.amount_cents, 0),
    net_cents: paid.reduce((sum, row) => sum + (row.office_net_cents ?? 0), 0),
    orders: paid.length, active_subscriptions: subscriptions.length,
    needs_attention_subscriptions: attention.length,
    to_ship: paid.filter((row) => row.fulfillment_status === "to_ship").length,
    series: [...series.values()],
  };
}

type OfficeNameRow = { provider_id: string; office_name: string | null; provider_name: string | null };
async function officeNames(providerIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(providerIds)];
  if (ids.length === 0) return new Map();
  const result = await supabaseAdmin("GET", `/rest/v1/providers?select=provider_id,office_name,provider_name&provider_id=${inList(ids)}`);
  if (result.status >= 300) throw new Error("provider list failed");
  const rows: OfficeNameRow[] = Array.isArray(result.json) ? result.json : [];
  return new Map(rows.map((row) => [row.provider_id, row.office_name?.trim() || row.provider_name?.trim() || "Office"]));
}
type ActivityKind = HqActivityRow["kind"];
const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  sale: "Payment received", refund: "Refund issued", dispute_opened: "Dispute opened", dispute_won: "Dispute won",
  dispute_lost: "Dispute lost", application_fee_adjustment: "THINNR fee adjustment", fee_discrepancy: "Fee discrepancy", payout: "Payout to office",
};
export const ACTIVITY_KINDS = Object.keys(ACTIVITY_LABEL) as ActivityKind[];
const isActivityKind = (value: string): value is ActivityKind => (ACTIVITY_KINDS as string[]).includes(value);
/**
 * Ledger lines become feed rows: the office name and order number are
 * resolved in two bulk reads, and a sale shows the gross order total (the
 * ledger stores the office's net on that line).
 */
async function toActivityRows(ledger: BillingLedgerRow[]): Promise<HqActivityRow[]> {
  const orderIds = ledger.map((row) => row.order_id).filter((id): id is string => Boolean(id));
  const [names, orders] = await Promise.all([
    officeNames(ledger.map((row) => row.provider_id)),
    orderIds.length ? selectMany("billing_orders", `select=id,order_number&id=${inList(orderIds)}`) : Promise.resolve([] as BillingOrderRow[]),
  ]);
  const orderNumber = new Map(orders.map((row) => [row.id, row.order_number]));
  return ledger.map((row) => {
    const gross = row.kind === "sale" && typeof row.detail?.total_cents === "number" ? row.detail.total_cents : row.amount_cents;
    const kind: ActivityKind = isActivityKind(row.kind) ? row.kind : "fee_discrepancy";
    return {
      id: row.id, kind, label: isActivityKind(row.kind) ? ACTIVITY_LABEL[row.kind] : row.kind.replace(/_/g, " "),
      provider_id: row.provider_id, office_name: names.get(row.provider_id) ?? "Office",
      amount_cents: gross, occurred_at: row.occurred_at, order_id: row.order_id,
      order_number: row.order_id ? orderNumber.get(row.order_id) ?? null : null,
    };
  });
}
export async function hqOverview(input: { from?: unknown; to?: unknown }): Promise<HqOverview> {
  const range = reportRange(input);
  const [orders, refunds, disputes, subscriptions, attention, accounts, ledger] = await Promise.all([
    selectMany("billing_orders", `created_at=gte.${range.start}&created_at=lte.${range.end}&order=created_at.asc`),
    selectMany("billing_refunds", `created_at=gte.${range.start}&created_at=lte.${range.end}`),
    selectMany("billing_disputes", `created_at=gte.${range.start}&created_at=lte.${range.end}`),
    selectMany("billing_subscriptions", "status=eq.active&select=id"),
    selectMany("billing_subscriptions", "status=in.(past_due,unpaid)&select=id"),
    selectMany("billing_connected_accounts", "select=provider_id,charges_enabled,payouts_enabled"),
    selectMany("billing_ledger", `occurred_at=gte.${range.start}&occurred_at=lte.${range.end}&order=occurred_at.desc,id.desc&limit=8`),
  ]);
  const paid = orders.filter((row) => row.status !== "pending" && row.status !== "failed" && row.status !== "canceled");
  const series = points(range.from, range.to);
  fillSeries(series, paid, refunds, (row) => row.application_fee_cents);
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
    needs_attention_subscriptions: attention.length,
    providers_onboarded: accounts.filter((row) => row.charges_enabled && row.payouts_enabled).length,
    providers_pending: accounts.filter((row) => !row.charges_enabled || !row.payouts_enabled).length,
    to_ship: paid.filter((row) => row.fulfillment_status === "to_ship").length,
    series: [...series.values()],
    recent: await toActivityRows(ledger),
  };
}
const DEFAULT_TIME_ZONE = "America/New_York";
function zoneParts(instant: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour") % 24, minute: read("minute"), second: read("second") };
}
/** Minutes east of UTC for `timeZone` at `instant`. */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const local = zoneParts(instant, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return Math.round((asUtc - instant.getTime()) / 60_000);
}
/** UTC instant of local midnight for the given local Y-M-D (DST-safe by re-checking the offset). */
function localMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  const first = new Date(guess - zoneOffsetMinutes(new Date(guess), timeZone) * 60_000);
  const second = zoneOffsetMinutes(first, timeZone);
  return new Date(guess - second * 60_000);
}
export function resolveTimeZone(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input });
    return input;
  } catch {
    throw new BillingReportingError("That time zone is not recognized.", 400);
  }
}
/** The local calendar day containing `now` in `timeZone`: its date string plus the UTC window [start, end). */
export function localDayWindow(timeZone: string, now: Date = new Date()) {
  const local = zoneParts(now, timeZone);
  const start = localMidnightUtc(local.year, local.month, local.day, timeZone);
  const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const end = localMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone);
  const date = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  return { date, start, end, currentHour: local.hour };
}
/** Revenue for the current local day, one point per clock hour. */
export async function hqToday(input: { tz?: unknown }, now: Date = new Date()): Promise<HqTodayOverview> {
  return todayOverview(input, null, now);
}
/**
 * The office's own hourly view: the same buckets scoped to one provider, where
 * the "profit" line is the office's net (after THINNR and card fees).
 */
export async function officeToday(providerId: string, input: { tz?: unknown }, now: Date = new Date()): Promise<HqTodayOverview> {
  return todayOverview(input, providerId, now);
}
async function todayOverview(input: { tz?: unknown }, providerId: string | null, now: Date): Promise<HqTodayOverview> {
  const timeZone = resolveTimeZone(input.tz);
  const window = localDayWindow(timeZone, now);
  const startIso = window.start.toISOString();
  const endIso = window.end.toISOString();
  const scope = providerId ? `provider_id=eq.${encodeURIComponent(providerId)}&` : "";
  const orders = await selectMany("billing_orders", `${scope}paid_at=gte.${startIso}&paid_at=lt.${endIso}&order=paid_at.asc`);
  const paid = orders.filter((row) => row.status !== "pending" && row.status !== "failed" && row.status !== "canceled");
  // Refund rows carry no provider column: an office view keeps today's
  // refunds whose order belongs to it, including refunds of older orders.
  const refundsToday = await selectMany("billing_refunds", `created_at=gte.${startIso}&created_at=lt.${endIso}`);
  const refunds = providerId ? await ownedBy(providerId, refundsToday, paid) : refundsToday;
  const profitOf = (row: BillingOrderRow) => providerId ? (row.office_net_cents ?? 0) : row.hq_profit_cents;
  const hours: HourPoint[] = Array.from({ length: 24 }, (_, hour) => ({
    hour, collected_cents: 0, net_cents: 0, fee_cents: 0, profit_cents: 0, refunded_cents: 0, orders: 0,
  }));
  const hourOf = (iso: string) => zoneParts(new Date(iso), timeZone).hour;
  for (const row of paid) {
    const point = hours[hourOf(row.paid_at ?? row.created_at)];
    point.collected_cents += row.total_cents;
    point.fee_cents += row.application_fee_cents;
    point.profit_cents += profitOf(row);
    point.orders += 1;
  }
  for (const row of refunds) hours[hourOf(row.created_at)].refunded_cents += row.amount_cents;
  for (const point of hours) point.net_cents = point.collected_cents - point.refunded_cents;
  const sum = (key: keyof Omit<HourPoint, "hour">) => hours.reduce((total, point) => total + point[key], 0);
  return {
    date: window.date, time_zone: timeZone, current_hour: window.currentHour, hours,
    collected_cents: sum("collected_cents"), net_cents: sum("net_cents"), fee_cents: sum("fee_cents"),
    profit_cents: sum("profit_cents"), refunded_cents: sum("refunded_cents"), orders: sum("orders"),
  };
}
/** One office's slice of the ledger feed; the provider filter is pinned server-side. */
export async function officeActivity(providerId: string, query: Record<string, unknown>) {
  return hqActivity({ ...query, provider_id: providerId });
}
/** PostgREST id lists stay short enough for one URL. */
const ID_CHUNK = 150;
function chunks<T>(values: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}
/** The provider's orders among `ids` (chunked so the id list never outgrows a URL). */
async function ordersOwnedBy(providerId: string, ids: string[]): Promise<BillingOrderRow[]> {
  const rows = await Promise.all(
    chunks([...new Set(ids)]).map((chunk) =>
      selectMany("billing_orders", `provider_id=eq.${encodeURIComponent(providerId)}&id=${inList(chunk)}`),
    ),
  );
  return rows.flat();
}
/**
 * Keep the order-linked rows (refunds, disputes) whose order belongs to the
 * provider. Orders already in hand skip the lookup; the rest are resolved
 * against the provider-filtered orders table, so a row on another office's
 * order is never kept and a row on an older own order is never dropped.
 */
async function ownedBy<T extends { order_id: string }>(providerId: string, rows: T[], known: BillingOrderRow[] = []): Promise<T[]> {
  const owned = new Set(known.map((row) => row.id));
  const unknown = rows.map((row) => row.order_id).filter((id) => !owned.has(id));
  if (unknown.length) for (const row of await ordersOwnedBy(providerId, unknown)) owned.add(row.id);
  return rows.filter((row) => owned.has(row.order_id));
}
/**
 * Refunds and disputes for one office, newest first. Both tables hang off
 * orders (no provider column), so the rows in the date window are resolved
 * back to the office's orders (chunked lookups, bounded by the window rather
 * than the office's whole history) and the payer name rides along so staff
 * can recognize the patient.
 */
export async function officeRefunds(providerId: string, query: Record<string, unknown>): Promise<{ items: OfficeRefundRow[]; next_cursor: null }> {
  const range = reportRange(query);
  const window = `created_at=gte.${range.start}&created_at=lte.${range.end}`;
  const [refundRows, disputeRows] = await Promise.all([
    selectMany("billing_refunds", `${window}&order=created_at.desc`),
    selectMany("billing_disputes", `${window}&order=created_at.desc`),
  ]);
  const orders = await ordersOwnedBy(providerId, [...refundRows, ...disputeRows].map((row) => row.order_id));
  if (orders.length === 0) return { items: [], next_cursor: null };
  const byOrder = new Map(orders.map((row) => [row.id, row]));
  const refunds = refundRows.filter((row) => byOrder.has(row.order_id));
  const disputes = disputeRows.filter((row) => byOrder.has(row.order_id));
  const payers = (
    await Promise.all(chunks([...new Set(orders.map((row) => row.payer_id))]).map((chunk) => selectMany("billing_payers", `select=id,name&id=${inList(chunk)}`)))
  ).flat();
  const payerName = new Map(payers.map((row) => [row.id, row.name]));
  const describe = (orderId: string) => {
    const order = byOrder.get(orderId);
    return { order_number: order?.order_number ?? "", payer_name: order ? payerName.get(order.payer_id) ?? null : null };
  };
  const items: OfficeRefundRow[] = [
    ...refunds.map((row) => ({
      id: row.id, kind: "refund" as const, order_id: row.order_id, ...describe(row.order_id),
      amount_cents: row.amount_cents, status: row.status, reason: row.reason,
      evidence_due_by: null, closed_at: null, created_at: row.created_at,
    })),
    ...disputes.map((row) => ({
      id: row.id, kind: "dispute" as const, order_id: row.order_id, ...describe(row.order_id),
      amount_cents: row.amount_cents, status: row.status, reason: row.reason,
      evidence_due_by: row.evidence_due_by, closed_at: row.closed_at, created_at: row.created_at,
    })),
  ].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  const kind = typeof query.kind === "string" ? query.kind : "";
  return { items: kind === "refund" || kind === "dispute" ? items.filter((row) => row.kind === kind) : items, next_cursor: null };
}
/**
 * The full activity feed behind the overview's "recent activity": every
 * ledger line in the range, newest first, cursor-paged on occurred_at.
 */
export async function hqActivity(query: Record<string, unknown>): Promise<{ items: HqActivityRow[]; next_cursor: string | null }> {
  const range = reportRange(query);
  const page = pagination(query);
  const filters = [`occurred_at=gte.${range.start}`, `occurred_at=lte.${range.end}`];
  if (typeof query.kind === "string" && isActivityKind(query.kind)) filters.push(`kind=eq.${query.kind}`);
  if (typeof query.provider_id === "string" && query.provider_id) filters.push(`provider_id=eq.${encodeURIComponent(query.provider_id)}`);
  // The shared cursor helper names its timestamp created_at; this feed orders on occurred_at.
  if (page.cursor) filters.push(`occurred_at=lt.${encodeURIComponent(page.cursor.created_at)}`);
  const rows = await selectMany("billing_ledger", `${filters.join("&")}&order=occurred_at.desc,id.desc&limit=${page.limit + 1}`);
  const visible = rows.slice(0, page.limit);
  const last = visible.at(-1);
  return {
    items: await toActivityRows(visible),
    next_cursor: rows.length > page.limit && last ? encodeCursor({ created_at: last.occurred_at, id: last.id }) : null,
  };
}
