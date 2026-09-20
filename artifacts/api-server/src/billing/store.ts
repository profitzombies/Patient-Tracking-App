import crypto from "node:crypto";
import { supabaseAdmin } from "../lib/supabase-admin";
import { currentBillingIdentity, type BillingIdentity } from "./stripe-environment";
import type { ShipmentQuote } from "../shipping/rating";
import type { CadenceWeeks, OrderSummary, Payer, PickPackTier, ProductCategory, ProductFactRow, ProductFaq, ShipmentTerms, ShippingMethod, ShippingSource } from "./types";

export type BillingTable =
  | "billing_settings" | "billing_products" | "billing_product_images" | "billing_catalog_changes"
  | "billing_connected_accounts" | "billing_account_events" | "billing_office_prices"
  | "billing_payment_links" | "billing_payers" | "billing_orders" | "billing_order_items"
  | "billing_subscriptions" | "billing_ledger" | "billing_refunds" | "billing_disputes"
  | "billing_payouts" | "billing_webhook_endpoints" | "billing_webhook_events" | "billing_shipments" | "billing_carts" | "billing_customer_emails"
  | "billing_prebuilt_carts" | "billing_office_settings" | "billing_warehouse_submissions" | "billing_warehouse_sync_polls";

export interface BillingIdentityColumns {
  stripe_mode?: "test" | "live" | null;
  stripe_platform_account_id?: string | null;
}
export interface TimestampedRow extends BillingIdentityColumns { created_at: string; updated_at?: string }
export interface BillingSettingsRow extends TimestampedRow {
  id: number; shipping_charge_cents: number; shipping_cost_cents: number;
  card_fee_bps: number; card_fee_fixed_cents: number; version: number; updated_by: string | null;
  subscribe_save_enabled: boolean; subscribe_save_percent: number;
  /** Shipping rules (see shipping/rating.ts); the flat charge/cost above is the fallback. */
  free_shipping_over_cents: number | null; pick_pack_tier: PickPackTier; pick_pack_schedule: Record<string, unknown>;
  pick_pack_pass_through_default: boolean; expedited_enabled: boolean;
  /** HQ kill switch for automatic WarehouseCraft submission (intents keep queueing while off). */
  warehouse_auto_submit?: boolean;
}
/** Per-office shipping overrides; null = inherit HQ. */
export interface BillingOfficeSettingsRow extends TimestampedRow {
  provider_id: string; pick_pack_pass_through: boolean | null; version: number; updated_by: string | null;
}
/** The row columns a shipment quote locks onto an order/subscription. */
export function shipmentColumns(quote: ShipmentQuote): ShipmentColumns {
  return {
    shipping_method: quote.method, shipping_source: quote.source, carrier_service_name: quote.carrier_service_name,
    pick_pack_fee_cents: quote.pick_pack_fee_cents, packaging_cents: quote.packaging_cents,
    pick_pack_passed_through: quote.pick_pack_passed_through,
    delivery_window_start: quote.delivery_window_start, delivery_window_end: quote.delivery_window_end,
  };
}
/** The shipment terms of an order/subscription row with pre-rating defaults filled in. */
export function shipmentTerms(row: Partial<ShipmentColumns> & { shipping_cost_cents: number }): ShipmentTerms {
  return {
    shipping_method: row.shipping_method ?? "standard", shipping_source: row.shipping_source ?? "fallback",
    carrier_service_name: row.carrier_service_name ?? null, carrier_cost_cents: row.shipping_cost_cents,
    pick_pack_fee_cents: row.pick_pack_fee_cents ?? 0, packaging_cents: row.packaging_cents ?? 0,
    pick_pack_passed_through: row.pick_pack_passed_through ?? false,
    delivery_window_start: row.delivery_window_start ?? null, delivery_window_end: row.delivery_window_end ?? null,
  };
}
/**
 * Columns shared by orders and subscriptions describing the locked shipment
 * terms. Rows written before live rating carry the column defaults (standard /
 * fallback / zero fees); shipmentTerms() applies the same defaults to fixtures.
 */
export interface ShipmentColumns {
  shipping_method: ShippingMethod; shipping_source: ShippingSource; carrier_service_name: string | null;
  pick_pack_fee_cents: number; packaging_cents: number; pick_pack_passed_through: boolean;
  delivery_window_start: string | null; delivery_window_end: string | null;
}
export type BillingProductStatus = "draft" | "active" | "retired" | "archived";
export interface BillingProductRow extends TimestampedRow {
  id: string; slug: string; name: string; description: string; floor_price_cents: number; hard_cost_cents: number;
  /** Mirrors `status === "active"` (enforced by a DB check); checkout and pricing read this boolean. */
  active: boolean; status: BillingProductStatus; retired_at: string | null; archived_at: string | null;
  sort_order: number; stripe_tax_code: string | null;
  category: ProductCategory; tagline: string; format: string; benefits: string[]; how_to_take: string;
  facts_title: string; facts: ProductFactRow[]; faqs: ProductFaq[]; disclaimer: string;
  offered_cadences_weeks: CadenceWeeks[]; default_cadence_weeks: CadenceWeeks;
  /** HQ coach suggestion rule (validated shape lives in billing/catalog.ts coachSuggestionRule). */
  coach_suggestion: Record<string, unknown> | null;
  warehousecraft_sku: string | null; shipping_weight_oz: number | null;
  package_length_in: number | string | null; package_width_in: number | string | null; package_height_in: number | string | null;
  oversized: boolean;
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
  stripe_customer_emails?: StripeCustomerEmailsState; stripe_customer_emails_checked_at?: string | null;
  stripe_customer_emails_note?: string | null;
  /** Stripe Terminal location on this account (Tap to Pay); minted on first use. */
  terminal_location_id?: string | null; terminal_location_checked_at?: string | null;
}
/** Whether Stripe itself may email this office's customers; THINNR sends every customer email, so "off" is the healthy state. */
export type StripeCustomerEmailsState = "off" | "unverified" | "on";
export interface BillingCustomerEmailRow extends TimestampedRow {
  id: string; dedupe_key: string; template_id: string; provider_id: string | null; subscription_id: string | null;
  order_id: string | null; status: "claimed" | "sent" | "skipped" | "failed"; error: string | null;
}
export interface BillingAccountEventRow extends TimestampedRow {
  id: string; provider_id: string; kind: string; detail: Record<string, unknown>;
}
export interface BillingOfficePriceRow extends TimestampedRow {
  /** False excludes this product from new purchases; existing subscriptions remain intact. */
  enabled?: boolean;
  provider_id: string; product_id: string; sell_price_cents: number; subscription_enabled: boolean;
  stripe_product_id: string | null; stripe_price_id: string | null;
  stripe_shipping_price_id: string | null; updated_by: string | null;
  /** Per-cadence recurring price mirror keyed by weeks ("2".."12"); see prices.ts. */
  stripe_cadence_prices: Record<string, CadencePriceMirror>;
}
export interface CadencePriceMirror { price_id: string; unit_amount_cents: number; shipping_price_id: string }
export interface BillingPaymentLinkRow extends TimestampedRow {
  id: string; token: string; provider_id: string; patient_id: string | null; created_by: string;
  label: string | null; active: boolean; expires_at: string | null; uses: number; last_used_at: string | null;
  product_id?: string | null; max_uses?: number | null;
}
export interface BillingPayerRow extends TimestampedRow {
  id: string; provider_id: string; patient_id: string | null; name: string; email: string | null;
  phone: string | null; stripe_customer_id: string | null;
}
export interface BillingOrderRow extends TimestampedRow, Partial<ShipmentColumns> {
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
  metadata: Record<string, unknown>; failure_message: string | null;
  /** In-app checkout id shared by every order the same cart created (null for link/renewal orders). */
  cart_id?: string | null;
}
export interface BillingOrderItemRow extends TimestampedRow {
  id: string; order_id: string; product_id: string; product_name_snapshot: string; quantity: number;
  unit_price_cents: number; floor_price_cents_snapshot: number; thinnr_share_cents: number;
  hard_cost_cents_snapshot: number; warehousecraft_sku_snapshot?: string | null; shipping_weight_oz_snapshot?: number | null;
}
export interface BillingSubscriptionRow extends TimestampedRow, Partial<ShipmentColumns> {
  shipping_requoted_at?: string | null;
  id: string; provider_id: string; payer_id: string; patient_id: string | null; product_id: string;
  stripe_subscription_id: string | null; stripe_customer_id: string | null; status: string; unit_price_cents: number;
  shipping_charge_cents: number; shipping_cost_cents: number; application_fee_cents: number; shipping_address: Record<string, unknown>;
  current_period_end: string | null; cancel_at_period_end: boolean; canceled_at: string | null;
  cancel_token: string; livemode: boolean; last_payment_failed_at: string | null;
  payment_failure_count: number; last_failed_invoice_id: string | null;
  last_hosted_invoice_url: string | null; last_failure_message: string | null;
  payment_failure_email_sent_invoice_id: string | null;
  last_paid_invoice_id: string | null;
  paused_at: string | null;
  pending_product_id: string | null; pending_unit_price_cents: number | null;
  pending_application_fee_cents: number | null; pending_effective_at: string | null;
  pending_shipping_charge_cents: number | null; pending_stripe_price_id: string | null;
  /** Plan the patient chose (in-app shop); legacy link subscriptions are 4 weeks × 1. */
  cadence_weeks?: number; quantity?: number; next_shipment_at?: string | null;
  stripe_price_id?: string | null; stripe_shipping_price_id?: string | null;
}
export type BillingShipmentStatus = "processing" | "shipped" | "delivered" | "canceled";
export interface BillingCartRow extends TimestampedRow {
  id: string; provider_id: string; patient_id: string | null; status: "staging" | "ready"; quote: Record<string, unknown>;
}

export interface BillingPrebuiltCartRow extends TimestampedRow {
  id: string; token: string; provider_id: string; patient_id: string | null; created_by_user_id: string | null;
  label: string | null; lines: unknown[]; quote: Record<string, unknown>;
  status: "open" | "verified" | "checkout" | "paid" | "failed" | "expired" | "revoked" | "locked";
  expires_at: string; phone_attempts: number; verification_id: string | null; verified_at: string | null;
  session_hash: string | null; checkout_attempt: number; cart_id: string | null; paid_at: string | null;
}
export interface BillingShipmentRow extends TimestampedRow {
  id: string; order_id: string; provider_id: string; status: BillingShipmentStatus;
  carrier: string | null; tracking_number: string | null; tracking_url: string | null;
  source: "staff" | "provider"; external_id: string | null;
  label_created_at: string | null; shipped_at: string | null; delivered_at: string | null;
  canceled_at: string | null; canceled_reason: string | null;
  events: Array<{ at: string; status: string; detail?: Record<string, unknown> }>;
  updated_by: string | null;
  /** Mirror of the WarehouseCraft submission outcome (see warehouse-submissions.ts). */
  warehouse_order_id?: string | null; warehouse_state?: WarehouseSubmissionState | null;
  warehouse_sent_at?: string | null; warehouse_error?: string | null;
  /** Last state seen on the WarehouseCraft status feed (see warehouse-status-sync.ts). */
  warehouse_status?: string | null; warehouse_status_at?: string | null; warehouse_back_ordered?: boolean | null;
  warehouse_event_key?: string | null; warehouse_last_event?: Record<string, unknown> | null; warehouse_synced_at?: string | null;
}
/** One row per run of the warehouse status poll; feeds System health and the stalled-feed alert. */
export interface BillingWarehouseSyncPollRow {
  id: string; started_at: string; finished_at: string | null; ok: boolean; window_start: string; window_end: string;
  rows_seen: number; matched: number; transitions: number; errors: number; error: string | null; created_at: string;
}
export type WarehouseSubmissionState = "pending" | "sent" | "needs_attention" | "skipped";
/** One submission intent per paid order; created by the paid-transition trigger, drained by the warehouse-submit job. */
export interface BillingWarehouseSubmissionRow extends TimestampedRow {
  id: string; order_id: string; provider_id: string; patient_id: string | null; state: WarehouseSubmissionState;
  attempts: number; next_attempt_at: string; warehouse_order_id: string | null; warehouse_status: string | null;
  last_error: string | null; last_error_kind: "rejected" | "transient" | "incomplete" | null; last_attempt_at: string | null;
  sent_at: string | null; skipped_reason: string | null; payload: Record<string, unknown> | null;
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
export interface BillingWebhookEventRow extends BillingIdentityColumns {
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
  billing_webhook_events: BillingWebhookEventRow; billing_shipments: BillingShipmentRow; billing_carts: BillingCartRow;
  billing_customer_emails: BillingCustomerEmailRow;
  billing_prebuilt_carts: BillingPrebuiltCartRow; billing_office_settings: BillingOfficeSettingsRow;
  billing_warehouse_submissions: BillingWarehouseSubmissionRow;
  billing_warehouse_sync_polls: BillingWarehouseSyncPollRow;
};

export class BillingStoreError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function messageOf(json: unknown): string {
  return json && typeof json === "object" && typeof (json as { message?: unknown }).message === "string"
    ? String((json as { message: string }).message) : "Billing data request failed.";
}
function qs(query = ""): string { return query ? `?${query.replace(/^\?/, "")}` : ""; }

/** Catalog and commercial configuration are shared; all Stripe-derived data is isolated. */
const SHARED_TABLES = new Set<BillingTable>([
  "billing_settings", "billing_products", "billing_product_images", "billing_catalog_changes", "billing_office_settings",
]);
export function billingScope(table: BillingTable): BillingIdentity | undefined {
  if (SHARED_TABLES.has(table)) return undefined;
  const identity = currentBillingIdentity();
  if (!identity) throw new BillingStoreError("Billing identity is required.", 503);
  return identity;
}
export function scopedBillingQuery(table: BillingTable, query = ""): string {
  const identity = billingScope(table);
  if (!identity) return query;
  return `${query ? `${query.replace(/^\?/, "")}&` : ""}stripe_mode=eq.${identity.mode}&stripe_platform_account_id=eq.${encodeURIComponent(identity.platformAccountId)}`;
}
function scopedRow(table: BillingTable, row: object): object {
  const identity = billingScope(table);
  return identity ? { ...row, stripe_mode: identity.mode, stripe_platform_account_id: identity.platformAccountId } : row;
}

export async function selectMany<T extends BillingTable>(
  table: T, query = "",
): Promise<BillingRows[T][]> {
  const result = await supabaseAdmin("GET", `/rest/v1/${table}${qs(scopedBillingQuery(table, query))}`);
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
  const result = await supabaseAdmin("POST", `/rest/v1/${table}`, scopedRow(table, row), "return=representation");
  if (result.status >= 300) throw new BillingStoreError(messageOf(result.json), result.status);
  return (Array.isArray(result.json) ? result.json[0] : result.json) as BillingRows[T];
}
export async function insertIgnore<T extends BillingTable>(
  table: T, row: Partial<BillingRows[T]>, expectedConstraint?: string,
): Promise<BillingRows[T] | null> {
  const result = await supabaseAdmin("POST", `/rest/v1/${table}`, scopedRow(table, row), "resolution=ignore-duplicates,return=representation");
  const code = result.json && typeof result.json === "object" && "code" in result.json
    ? String((result.json as { code?: unknown }).code) : "";
  const constraintText = result.json && typeof result.json === "object"
    ? `${String((result.json as { message?: unknown }).message ?? "")} ${String((result.json as { details?: unknown }).details ?? "")}` : "";
  if (result.status === 409 && code === "23505" && (!expectedConstraint || constraintText.includes(expectedConstraint))) return null;
  if (result.status >= 300) throw new BillingStoreError(messageOf(result.json), result.status);
  return (Array.isArray(result.json) ? result.json[0] ?? null : result.json) as BillingRows[T] | null;
}
export async function upsert<T extends BillingTable>(
  table: T, row: Partial<BillingRows[T]>, onConflict?: string,
): Promise<BillingRows[T]> {
  const conflict = onConflict && billingScope(table) ? `${onConflict},stripe_mode,stripe_platform_account_id` : onConflict;
  const query = conflict ? `?on_conflict=${encodeURIComponent(conflict)}` : "";
  const result = await supabaseAdmin("POST", `/rest/v1/${table}${query}`, scopedRow(table, row), "resolution=merge-duplicates,return=representation");
  if (result.status >= 300) throw new BillingStoreError(messageOf(result.json), result.status);
  return (Array.isArray(result.json) ? result.json[0] : result.json) as BillingRows[T];
}
export async function update<T extends BillingTable>(
  table: T, query: string, patch: Partial<BillingRows[T]>,
): Promise<BillingRows[T] | null> {
  const result = await supabaseAdmin("PATCH", `/rest/v1/${table}${qs(scopedBillingQuery(table, query))}`, scopedRow(table, patch), "return=representation");
  if (result.status >= 300) throw new BillingStoreError(messageOf(result.json), result.status);
  return (Array.isArray(result.json) ? result.json[0] ?? null : result.json) as BillingRows[T] | null;
}
export async function remove(table: BillingTable, query: string): Promise<void> {
  const result = await supabaseAdmin("DELETE", `/rest/v1/${table}${qs(scopedBillingQuery(table, query))}`);
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
/**
 * Human-readable order number, also WarehouseCraft's ClientOrderId: `TH-` plus
 * eight characters from an alphabet without 0/O/1/I. It never contains `#` (the
 * warehouse rejects it). 32^8 ≈ 1.1e12 values keeps a random collision below
 * 1e-7 per order at 100k orders; the DB unique index on billing_orders.order_number
 * is the backstop (a collision fails that checkout attempt, never double-submits).
 */
export function newOrderNumber(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `TH-${[...crypto.randomBytes(8)].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}
export function encodeCursor(row: { created_at: string; id: string } | null): string | null {
  return row ? Buffer.from(JSON.stringify(row)).toString("base64url") : null;
}

/**
 * Keyset continuation for pages ordered (created_at DESC, id DESC): rows
 * strictly older than the cursor, plus rows at the same instant with a
 * smaller id. Timestamps are not unique, so a created_at-only predicate
 * would drop every tied row that did not fit on the previous page.
 */
export function cursorFilter(cursor: { created_at: string; id: string }): string {
  const at = encodeURIComponent(cursor.created_at);
  return `or=(created_at.lt.${at},and(created_at.eq.${at},id.lt.${encodeURIComponent(cursor.id)}))`;
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
