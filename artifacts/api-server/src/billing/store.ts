import { supabaseAdmin } from "../lib/supabase-admin";
import type { OrderSummary, Payer } from "./types";

export type BillingTable =
  | "billing_settings" | "billing_products" | "billing_product_images" | "billing_catalog_changes"
  | "billing_connected_accounts" | "billing_account_events" | "billing_office_prices"
  | "billing_payment_links" | "billing_payers" | "billing_orders" | "billing_order_items"
  | "billing_subscriptions" | "billing_ledger" | "billing_refunds" | "billing_disputes"
  | "billing_payouts" | "billing_webhook_endpoints" | "billing_webhook_events";

export interface TimestampedRow { created_at: string; updated_at?: string }
export interface BillingSettingsRow extends TimestampedRow {
  id: number; shipping_charge_cents: number; shipping_cost_cents: number;
  card_fee_bps: number; card_fee_fixed_cents: number; version: number; updated_by: string | null;
}
export type BillingProductStatus = "draft" | "active" | "retired" | "archived";
export interface BillingProductRow extends TimestampedRow {
  id: string; slug: string; name: string; description: string; floor_price_cents: number; hard_cost_cents: number;
  /** Mirrors `status === "active"` (enforced by a DB check); checkout and pricing read this boolean. */
  active: boolean; status: BillingProductStatus; retired_at: string | null; archived_at: string | null;
  sort_order: number; stripe_tax_code: string | null;
}
export interface BillingProductImageRow extends TimestampedRow {
  id: string; product_id: string; object_path: string; content_type: string; size_bytes: number;
  sort_order: number; is_default: boolean; created_by: string | null;
}
export interface BillingCatalogChangeRow extends TimestampedRow {
  id: string; product_id: string | null; kind: string; before: Record<string, unknown> | null;
  after: Record<string, unknown> | null; actor_user_id: string | null; provider_id: string | null;
}
export interface BillingConnectedAccountRow extends TimestampedRow {
  provider_id: string; stripe_account_id: string; origin: "created" | "oauth";
  dashboard_type: "none" | "full" | "express"; charges_enabled: boolean; payouts_enabled: boolean;
  details_submitted: boolean; requirements: Record<string, unknown>; capabilities: Record<string, string>;
  default_currency: string | null; business_name: string | null; email: string | null;
  tax_enabled: boolean; tax_last_checked_at: string | null; oauth_refresh_token: string | null;
  livemode: boolean; last_synced_at: string | null; disconnected_at: string | null;
}
export interface BillingAccountEventRow extends TimestampedRow {
  id: string; provider_id: string; kind: string; detail: Record<string, unknown>;
}
export interface BillingOfficePriceRow extends TimestampedRow {
  provider_id: string; product_id: string; sell_price_cents: number; subscription_enabled: boolean;
  stripe_product_id: string | null; stripe_price_id: string | null;
  stripe_shipping_price_id: string | null; updated_by: string | null;
}
export interface BillingPaymentLinkRow extends TimestampedRow {
  id: string; token: string; provider_id: string; patient_id: string | null; created_by: string;
  label: string | null; active: boolean; expires_at: string | null; uses: number; last_used_at: string | null;
}
export interface BillingPayerRow extends TimestampedRow {
  id: string; provider_id: string; patient_id: string | null; name: string; email: string | null;
  phone: string | null; stripe_customer_id: string | null;
}
export interface BillingOrderRow extends TimestampedRow {
  id: string; order_number: string; provider_id: string; payer_id: string; patient_id: string | null;
  link_id: string | null; kind: "one_time" | "subscription_initial" | "subscription_renewal";
  subscription_id: string | null; status: string; currency: string; subtotal_cents: number;
  shipping_charge_cents: number; tax_cents: number; total_cents: number; application_fee_cents: number;
  application_fee_collected_cents: number | null; stripe_fee_cents: number | null;
  office_net_cents: number | null; hard_cost_cents: number; shipping_cost_cents: number;
  hq_profit_cents: number; shipping_address: Record<string, unknown>; stripe_invoice_id: string | null;
  stripe_payment_intent_id: string | null; stripe_charge_id: string | null;
  stripe_balance_transaction_id: string | null; livemode: boolean; paid_at: string | null;
  fulfillment_status: string; tracking_number: string | null; carrier: string | null;
  shipped_at: string | null; shipped_by: string | null; canceled_reason: string | null;
  metadata: Record<string, unknown>;
}
export interface BillingOrderItemRow extends TimestampedRow {
  id: string; order_id: string; product_id: string; product_name_snapshot: string; quantity: number;
  unit_price_cents: number; floor_price_cents_snapshot: number; thinnr_share_cents: number;
  hard_cost_cents_snapshot: number;
}
export interface BillingSubscriptionRow extends TimestampedRow {
  id: string; provider_id: string; payer_id: string; patient_id: string | null; product_id: string;
  stripe_subscription_id: string | null; stripe_customer_id: string | null; status: string; unit_price_cents: number;
  shipping_charge_cents: number; shipping_cost_cents: number; application_fee_cents: number; shipping_address: Record<string, unknown>;
  current_period_end: string | null; cancel_at_period_end: boolean; canceled_at: string | null;
  cancel_token: string; livemode: boolean;
}
export interface BillingLedgerRow extends TimestampedRow {
  id: string; provider_id: string; order_id: string | null; subscription_id: string | null;
  kind: string; amount_cents: number; application_fee_cents: number; stripe_ref: string | null;
  detail: Record<string, unknown>; occurred_at: string;
}
export interface BillingRefundRow extends TimestampedRow {
  id: string; order_id: string; stripe_refund_id: string; amount_cents: number;
  reason: string | null; status: string; requested_by: string | null;
}
export interface BillingDisputeRow extends TimestampedRow {
  id: string; order_id: string; stripe_dispute_id: string; amount_cents: number; status: string;
  reason: string | null; evidence_due_by: string | null; closed_at: string | null;
}
export interface BillingPayoutRow extends TimestampedRow {
  id: string; provider_id: string; stripe_payout_id: string; amount_cents: number;
  status: string; arrival_date: string | null; method: string | null;
}
export interface BillingWebhookEndpointRow extends TimestampedRow {
  id: string; kind: "platform" | "connect"; url: string; stripe_endpoint_id: string;
  secret: string; livemode: boolean;
}
export interface BillingWebhookEventRow {
  stripe_event_id: string; kind: string; type: string; account: string | null; livemode: boolean;
  received_at: string; claimed_at: string | null; processed_at: string | null; error: string | null;
  payload: Record<string, unknown>;
}

export type BillingRows = {
  billing_settings: BillingSettingsRow; billing_products: BillingProductRow;
  billing_product_images: BillingProductImageRow; billing_catalog_changes: BillingCatalogChangeRow; billing_connected_accounts: BillingConnectedAccountRow;
  billing_account_events: BillingAccountEventRow; billing_office_prices: BillingOfficePriceRow;
  billing_payment_links: BillingPaymentLinkRow; billing_payers: BillingPayerRow;
  billing_orders: BillingOrderRow; billing_order_items: BillingOrderItemRow;
  billing_subscriptions: BillingSubscriptionRow; billing_ledger: BillingLedgerRow;
  billing_refunds: BillingRefundRow; billing_disputes: BillingDisputeRow;
  billing_payouts: BillingPayoutRow; billing_webhook_endpoints: BillingWebhookEndpointRow;
  billing_webhook_events: BillingWebhookEventRow;
};

export class BillingStoreError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function messageOf(json: unknown): string {
  return json && typeof json === "object" && typeof (json as { message?: unknown }).message === "string"
    ? String((json as { message: string }).message) : "Billing data request failed.";
}
function qs(query = ""): string { return query ? `?${query.replace(/^\?/, "")}` : ""; }

export async function selectMany<T extends BillingTable>(
  table: T, query = "",
): Promise<BillingRows[T][]> {
  const result = await supabaseAdmin("GET", `/rest/v1/${table}${qs(query)}`);
  if (result.status >= 300) throw new BillingStoreError(messageOf(result.json), result.status);
  return (Array.isArray(result.json) ? result.json : []) as BillingRows[T][];
}
export async function selectOne<T extends BillingTable>(
  table: T, query = "",
): Promise<BillingRows[T] | null> {
  const rows = await selectMany(table, `${query}${query ? "&" : ""}limit=1`);
  return rows[0] ?? null;
}
export async function insert<T extends BillingTable>(
  table: T, row: Partial<BillingRows[T]>,
): Promise<BillingRows[T]> {
  const result = await supabaseAdmin("POST", `/rest/v1/${table}`, row, "return=representation");
  if (result.status >= 300) throw new BillingStoreError(messageOf(result.json), result.status);
  return (Array.isArray(result.json) ? result.json[0] : result.json) as BillingRows[T];
}
export async function upsert<T extends BillingTable>(
  table: T, row: Partial<BillingRows[T]>, onConflict?: string,
): Promise<BillingRows[T]> {
  const query = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : "";
  const result = await supabaseAdmin("POST", `/rest/v1/${table}${query}`, row, "resolution=merge-duplicates,return=representation");
  if (result.status >= 300) throw new BillingStoreError(messageOf(result.json), result.status);
  return (Array.isArray(result.json) ? result.json[0] : result.json) as BillingRows[T];
}
export async function update<T extends BillingTable>(
  table: T, query: string, patch: Partial<BillingRows[T]>,
): Promise<BillingRows[T] | null> {
  const result = await supabaseAdmin("PATCH", `/rest/v1/${table}${qs(query)}`, patch, "return=representation");
  if (result.status >= 300) throw new BillingStoreError(messageOf(result.json), result.status);
  return (Array.isArray(result.json) ? result.json[0] ?? null : result.json) as BillingRows[T] | null;
}
export async function remove(table: BillingTable, query: string): Promise<void> {
  const result = await supabaseAdmin("DELETE", `/rest/v1/${table}${qs(query)}`);
  if (result.status >= 300) throw new BillingStoreError(messageOf(result.json), result.status);
}
export function nowIso(): string { return new Date().toISOString(); }
export function pagination(input: { limit?: unknown; cursor?: unknown }) {
  const parsed = Number(input.limit);
  const limit = Number.isInteger(parsed) ? Math.max(1, Math.min(200, parsed)) : 50;
  let cursor: { created_at: string; id: string } | null = null;
  if (typeof input.cursor === "string" && input.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
      if (typeof decoded.created_at === "string" && typeof decoded.id === "string") cursor = decoded;
    } catch { throw new BillingStoreError("Invalid cursor.", 400); }
  }
  return { limit, cursor };
}
export function encodeCursor(row: { created_at: string; id: string } | null): string | null {
  return row ? Buffer.from(JSON.stringify(row)).toString("base64url") : null;
}

export function toOrderSummary(
  row: BillingOrderRow,
  items: BillingOrderItemRow[],
  payer: BillingPayerRow,
  officeName: string,
): OrderSummary {
  const count = items.reduce((sum, item) => sum + item.quantity, 0);
  const payerDto: Payer = { id: payer.id, patient_id: payer.patient_id, name: payer.name, email: payer.email, phone: payer.phone };
  return {
    id: row.id, order_number: row.order_number, provider_id: row.provider_id, office_name: officeName,
    payer: payerDto, kind: row.kind, status: row.status as OrderSummary["status"],
    fulfillment_status: row.fulfillment_status as OrderSummary["fulfillment_status"],
    total_cents: row.total_cents, application_fee_cents: row.application_fee_cents,
    item_count: count, items_label: items.map((item) => `${item.product_name_snapshot} × ${item.quantity}`).join(", "),
    livemode: row.livemode, created_at: row.created_at, paid_at: row.paid_at,
  };
}