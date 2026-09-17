/**
 * Wire contract for the provider payments (Stripe Connect) API.
 * Mirrors docs/billing-connect/SPEC.md §6. Every money field is integer cents.
 * The API server is authoritative; keep these shapes in lockstep with
 * artifacts/api-server/src/billing/types.ts.
 */

export type OrderStatus =
  | 'pending'
  | 'paid'
  | 'failed'
  | 'refunded'
  | 'partially_refunded'
  | 'disputed'
  | 'canceled';
export type OrderKind = 'one_time' | 'subscription_initial' | 'subscription_renewal';
export type FulfillmentStatus = 'to_ship' | 'shipped' | 'canceled';
export type SubscriptionStatus = 'incomplete' | 'active' | 'past_due' | 'canceled' | 'unpaid';
export type AccountOrigin = 'created' | 'oauth';
export type DashboardType = 'none' | 'full' | 'express';
export type OfficeRole = 'owner' | 'admin' | 'staff';

export interface ShippingAddress {
  name: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  phone: string | null;
}

export interface AccountRequirements {
  currently_due: string[];
  past_due: string[];
  eventually_due: string[];
  disabled_reason: string | null;
  current_deadline: string | null;
}

export interface ConnectedAccount {
  provider_id: string;
  stripe_account_id: string;
  origin: AccountOrigin;
  dashboard_type: DashboardType;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements: AccountRequirements;
  capabilities: Record<string, string>;
  default_currency: string | null;
  business_name: string | null;
  email: string | null;
  tax_enabled: boolean;
  livemode: boolean;
  /** Whether Stripe itself may email this office's customers. THINNR sends every customer email, so "off" is healthy. */
  stripe_customer_emails: StripeCustomerEmailsState;
  stripe_customer_emails_checked_at: string | null;
  stripe_customer_emails_note: string | null;
  last_synced_at: string | null;
  disconnected_at: string | null;
  created_at: string;
}
export type StripeCustomerEmailsState = 'off' | 'unverified' | 'on';

export interface AccountEvent {
  id: string;
  provider_id: string;
  kind:
    | 'account_created'
    | 'oauth_connected'
    | 'onboarding_started'
    | 'requirements_updated'
    | 'charges_enabled'
    | 'payouts_enabled'
    | 'capability_updated'
    | 'deauthorized'
    | 'tax_enabled'
    | 'tax_disabled'
    | 'customer_emails_recorded';
  detail: Record<string, unknown>;
  created_at: string;
}

export interface BillingSettings {
  shipping_charge_cents: number;
  shipping_cost_cents: number;
  card_fee_bps: number;
  card_fee_fixed_cents: number;
  /** Subscribe-and-save: when off, no discount is quoted or charged anywhere. */
  subscribe_save_enabled: boolean;
  /** Whole percent off every subscription renewal while enabled (kept while off). */
  subscribe_save_percent: number;
  version: number;
  updated_at: string | null;
}

/** Subscription renewal cadences a product may offer, in weeks. */
export type CadenceWeeks = 2 | 4 | 6 | 8 | 10 | 12;
export const CADENCE_WEEKS: readonly CadenceWeeks[] = [2, 4, 6, 8, 10, 12];

export type ProductCategory = 'drops' | 'supplement' | 'bundle';

/** One supplement-facts / ingredients row. */
export interface ProductFactRow {
  name: string;
  detail: string | null;
}

export interface ProductFaq {
  question: string;
  answer: string;
}

/** Product-page content, drafted from the program documents and edited by HQ. */
export interface ProductPageContent {
  category: ProductCategory;
  tagline: string;
  /** e.g. "Dietary Supplement · 60 Vegetarian Capsules". */
  format: string;
  benefits: string[];
  how_to_take: string;
  /** Heading for `facts` (e.g. "Key Ingredients", "Active Ingredients (HPUS)"). */
  facts_title: string;
  facts: ProductFactRow[];
  faqs: ProductFaq[];
  /** Regulatory disclaimer that travels with the copy. */
  disclaimer: string;
}

/** Which subscription cadences a product offers and which one is preselected. */
export interface ProductCadences {
  offered_cadences_weeks: CadenceWeeks[];
  default_cadence_weeks: CadenceWeeks;
}

export type ProductStatus = 'draft' | 'active' | 'retired' | 'archived';

/** One product image. `url` is an open, cache-friendly redirect to a short-lived signed URL. */
export interface ProductImage {
  id: string;
  url: string;
  content_type: string;
  size_bytes: number;
  sort_order: number;
  is_default: boolean;
  created_at: string;
}

export interface CatalogProduct extends ProductPageContent, ProductCadences {
  id: string;
  slug: string;
  name: string;
  description: string;
  floor_price_cents: number;
  hard_cost_cents: number;
  active: boolean;
  status: ProductStatus;
  retired_at: string | null;
  archived_at: string | null;
  /** Default image, when one is set. */
  image_url: string | null;
  image_count: number;
  updated_at: string;
  sort_order: number;
  thinnr_share_cents: number;
  break_even_minimum_cents: number;
  hq_profit_per_unit_cents: number;
  offices_offering: number;
  offices_below_minimum: number;
}

export type CatalogChangeKind =
  | 'product_created'
  | 'product_updated'
  | 'product_retired'
  | 'product_reactivated'
  | 'product_published'
  | 'product_archived'
  | 'product_unarchived'
  | 'product_image_added'
  | 'product_image_removed'
  | 'product_default_image'
  | 'products_reordered'
  | 'office_price_updated'
  | 'settings_updated';

export interface CatalogChange {
  id: string;
  product_id: string | null;
  product_name: string | null;
  kind: CatalogChangeKind;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor_user_id: string | null;
  /** Resolved from the HQ team roster (display name), then the profile. */
  actor_name: string | null;
  /** HQ roster id of the actor, when they are (still) an HQ teammate; links to their Team profile. */
  actor_member_id: string | null;
  /** Office whose price changed (office_price_updated only). */
  provider_id: string | null;
  office_name: string | null;
  created_at: string;
}

export interface OfficePrice extends ProductCadences {
  product_id: string;
  slug: string;
  name: string;
  description: string;
  category: ProductCategory;
  tagline: string;
  image_url: string | null;
  active: boolean;
  floor_price_cents: number;
  break_even_minimum_cents: number;
  sell_price_cents: number | null;
  subscription_enabled: boolean;
  offered: boolean;
  below_minimum: boolean;
  /** Effective subscribe-and-save percent (0 while the HQ setting is off). */
  subscribe_save_percent: number;
  /** Per-renewal unit price after subscribe-and-save; null unless priced with subscriptions on. */
  subscription_price_cents: number | null;
}

export interface PaymentLink {
  id: string;
  token: string;
  url: string;
  provider_id: string;
  patient_id: string | null;
  patient_name: string | null;
  label: string | null;
  active: boolean;
  uses: number;
  last_used_at: string | null;
  created_at: string;
  /** Preselected product on the public pay page; null lets the payer choose. */
  product_id: string | null;
  product_name: string | null;
  expires_at: string | null;
  /** Null = unlimited. 1 = single-use. A link is exhausted once uses >= max_uses. */
  max_uses: number | null;
  /** Server-derived: false once inactive, expired, or exhausted. */
  usable: boolean;
}

export interface PaymentLinkInput {
  patient_id?: string | null;
  label?: string | null;
  product_id?: string | null;
  /** Hours from creation; null = never expires. */
  expires_in_hours?: number | null;
  max_uses?: number | null;
}

export interface PaymentLinkUpdate {
  label?: string | null;
  active?: boolean;
  /** Absolute timestamp; null clears the expiry. */
  expires_at?: string | null;
  max_uses?: number | null;
}

export interface Payer {
  id: string;
  patient_id: string | null;
  name: string;
  email: string | null;
  phone: string | null;
}

export interface OrderItem {
  id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price_cents: number;
  floor_price_cents: number;
  thinnr_share_cents: number;
  hard_cost_cents: number;
}

export interface FeeBreakdown {
  subtotal_cents: number;
  shipping_charge_cents: number;
  tax_cents: number;
  total_cents: number;
  thinnr_share_cents: number;
  application_fee_cents: number;
  application_fee_collected_cents: number | null;
  stripe_fee_cents: number | null;
  stripe_fee_estimate_cents: number;
  office_net_cents: number | null;
  office_net_estimate_cents: number;
}

export interface HqProfit {
  hard_cost_cents: number;
  shipping_cost_cents: number;
  hq_profit_cents: number;
}

export interface Refund {
  id: string;
  stripe_refund_id: string;
  amount_cents: number;
  reason: string | null;
  status: string;
  requested_by_name: string | null;
  created_at: string;
}

export interface Dispute {
  id: string;
  stripe_dispute_id: string;
  amount_cents: number;
  status: string;
  reason: string | null;
  evidence_due_by: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface LedgerLine {
  id: string;
  kind:
    | 'sale'
    | 'refund'
    | 'dispute_opened'
    | 'dispute_won'
    | 'dispute_lost'
    | 'application_fee_adjustment'
    | 'fee_discrepancy'
    | 'payout';
  amount_cents: number;
  application_fee_cents: number;
  stripe_ref: string | null;
  detail: Record<string, unknown>;
  occurred_at: string;
}

export interface OrderSummary {
  id: string;
  order_number: string;
  provider_id: string;
  office_name: string;
  payer: Payer;
  kind: OrderKind;
  status: OrderStatus;
  fulfillment_status: FulfillmentStatus;
  total_cents: number;
  application_fee_cents: number;
  item_count: number;
  items_label: string;
  livemode: boolean;
  created_at: string;
  paid_at: string | null;
}

export interface OrderDetail extends OrderSummary {
  items: OrderItem[];
  shipping_address: ShippingAddress;
  fees: FeeBreakdown;
  /** HQ only; absent on office routes. */
  profit?: HqProfit;
  subscription_id: string | null;
  tracking_number: string | null;
  carrier: string | null;
  shipped_at: string | null;
  shipped_by_name: string | null;
  canceled_reason: string | null;
  refunds: Refund[];
  disputes: Dispute[];
  ledger: LedgerLine[];
  stripe: {
    account_id: string;
    invoice_id: string | null;
    payment_intent_id: string | null;
    charge_id: string | null;
    balance_transaction_id: string | null;
  };
}

export interface SubscriptionRow {
  id: string;
  provider_id: string;
  office_name: string;
  payer: Payer;
  product_id: string;
  product_name: string;
  status: SubscriptionStatus;
  unit_price_cents: number;
  shipping_charge_cents: number;
  application_fee_cents: number;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  payment_failure_count: number;
  last_payment_failed_at: string | null;
  last_failure_message: string | null;
  renewals: number;
  livemode: boolean;
  created_at: string;
  /** Set while Stripe pause_collection is active; renewals are skipped until resumed. */
  paused_at: string | null;
  /** A product/price change already applied in Stripe that takes effect at the next renewal. */
  pending_change: { product_id: string; product_name: string; unit_price_cents: number; effective_at: string | null } | null;
}

export interface SubscriptionChangeInput {
  product_id: string;
}

export interface SubscriptionChangeQuote {
  current: { product_id: string; product_name: string; unit_price_cents: number };
  next: { product_id: string; product_name: string; unit_price_cents: number; shipping_charge_cents: number; application_fee_cents: number };
  effective_at: string | null;
}

export interface PayoutRow {
  id: string;
  stripe_payout_id: string;
  amount_cents: number;
  status: string;
  arrival_date: string | null;
  method: string | null;
  created_at: string;
}

export interface Balance {
  available_cents: number;
  pending_cents: number;
}

export interface SeriesPoint {
  date: string;
  /** Gross collected (order totals) for payments that landed this day. */
  collected_cents: number;
  /** Office net for those payments (total − THINNR fee − Stripe fee). */
  net_cents: number;
  /** THINNR application fees for those payments. */
  fee_cents: number;
  /** Refunds issued this day (positive amount). */
  refunded_cents: number;
  /** Number of payments that landed this day. */
  orders: number;
}

/** One ledger line on the HQ activity feed, with its office and order resolved. */
export interface HqActivityRow {
  id: string;
  kind: LedgerLine['kind'];
  label: string;
  provider_id: string;
  office_name: string;
  /** Signed: sales carry the gross order total, refunds/payouts are negative. */
  amount_cents: number | null;
  occurred_at: string;
  order_id: string | null;
  order_number: string | null;
}

export interface Paged<T> {
  items: T[];
  next_cursor: string | null;
}

// ---------- office ----------

export interface OfficeBillingStatus {
  account: ConnectedAccount | null;
  offered_products: number;
  links: number;
  sandbox: boolean;
  oauth_available: boolean;
  viewer: { office_role: OfficeRole; can_manage: boolean };
  office: { provider_id: string; office_name: string };
}

export interface AccountSessionResponse {
  client_secret: string;
  publishable_key: string;
  sandbox: boolean;
}

export interface OfficeDashboard {
  balance: Balance;
  next_payout: { amount_cents: number; arrival_date: string | null } | null;
  collected_cents: number;
  thinnr_fee_cents: number;
  stripe_fee_cents: number;
  refunded_cents: number;
  net_cents: number;
  orders: number;
  active_subscriptions: number;
  needs_attention_subscriptions: number;
  to_ship: number;
  series: SeriesPoint[];
}

/**
 * A refund or dispute on one of the office's orders. Refunds are issued from
 * the transaction; this list is the office's read-only ledger of them.
 */
export interface OfficeRefundRow {
  id: string;
  kind: 'refund' | 'dispute';
  order_id: string;
  order_number: string;
  payer_name: string | null;
  amount_cents: number;
  status: string;
  reason: string | null;
  evidence_due_by: string | null;
  closed_at: string | null;
  created_at: string;
}

export interface OfficePricesResponse {
  products: OfficePrice[];
  settings: {
    shipping_charge_cents: number; card_fee_bps: number; card_fee_fixed_cents: number;
    subscribe_save_enabled: boolean; subscribe_save_percent: number;
  };
}

export interface PatientSearchHit {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

export interface OfficePayoutsResponse {
  balance: Balance;
  items: PayoutRow[];
}

// ---------- HQ ----------

/** One clock hour of the HQ "today" chart, in the requested time zone. */
export interface HourPoint {
  /** 0-23 local hour. */
  hour: number;
  /** Gross collected for payments that landed this hour. */
  collected_cents: number;
  /** Gross minus refunds issued this hour. */
  net_cents: number;
  /** THINNR application fees for those payments. */
  fee_cents: number;
  /** HQ profit after product and shipping costs for those payments. */
  profit_cents: number;
  refunded_cents: number;
  orders: number;
}
export interface HqTodayOverview {
  /** Local calendar date (YYYY-MM-DD) in `time_zone`. */
  date: string;
  time_zone: string;
  /** Local hour that is in progress right now (0-23). */
  current_hour: number;
  /** Always 24 points, hour 0 through 23; hours after `current_hour` are zero. */
  hours: HourPoint[];
  collected_cents: number;
  net_cents: number;
  fee_cents: number;
  profit_cents: number;
  refunded_cents: number;
  orders: number;
}

export interface HqOverview {
  collected_cents: number;
  thinnr_fee_cents: number;
  shipping_charge_cents: number;
  hard_cost_cents: number;
  shipping_cost_cents: number;
  profit_cents: number;
  refunded_cents: number;
  disputed_cents: number;
  orders: number;
  active_subscriptions: number;
  needs_attention_subscriptions: number;
  providers_onboarded: number;
  providers_pending: number;
  to_ship: number;
  series: SeriesPoint[];
  recent: HqActivityRow[];
}

export interface HqProviderRow {
  provider_id: string;
  office_name: string;
  provider_name: string;
  account: ConnectedAccount | null;
  offered_products: number;
  orders_30d: number;
  collected_30d_cents: number;
  fees_30d_cents: number;
  below_minimum_count: number;
}

export interface HqProviderDetail {
  office: { provider_id: string; office_name: string; provider_name: string; email: string | null; phone: string | null };
  account: ConnectedAccount | null;
  events: AccountEvent[];
  prices: OfficePrice[];
  subscriptions: { active: number; past_due: number; canceled: number };
  /** Last 30 days of activity, same numbers the office sees on its own dashboard. */
  activity_30d: {
    collected_cents: number; thinnr_fee_cents: number; refunded_cents: number; net_cents: number;
    orders: number; to_ship: number;
  };
  recent_orders: OrderSummary[];
  payouts: PayoutRow[];
  links: number;
}

export interface HqCatalogResponse {
  products: CatalogProduct[];
  settings: BillingSettings;
  offices_below_minimum: number;
}

export interface CatalogProductInput extends Partial<ProductPageContent>, Partial<ProductCadences> {
  name: string;
  slug?: string;
  description?: string;
  floor_price_cents: number;
  hard_cost_cents: number;
  sort_order?: number;
  /** New products start active unless saved as a draft. */
  status?: 'draft' | 'active';
}

export interface CatalogProductDetail extends CatalogProduct {
  images: ProductImage[];
}

export interface FulfillmentUpdate {
  /** `delivered` is a shipment transition; the order's fulfillment_status stays `shipped`. */
  status: FulfillmentStatus | 'delivered';
  tracking_number?: string | null;
  carrier?: string | null;
  canceled_reason?: string | null;
}

// ---------- public ----------

export interface PublicLinkProduct extends ProductPageContent {
  product_id: string;
  name: string;
  description: string;
  image_url: string | null;
  /** The office's price, or the catalog floor price when the office has not priced the product. */
  unit_price_cents: number;
  /** False when the office has not set its own price (floor fallback). */
  office_priced: boolean;
  subscription_available: boolean;
  /** Cadences the patient may subscribe on (empty unless subscription_available). */
  subscription_cadences_weeks: CadenceWeeks[];
  default_cadence_weeks: CadenceWeeks;
  /** Effective subscribe-and-save percent (0 while off or when subscriptions are unavailable). */
  subscribe_save_percent: number;
  /** Per-renewal unit price after subscribe-and-save; null when subscriptions are unavailable. */
  subscription_unit_price_cents: number | null;
}

export interface PublicLink {
  token: string;
  office: { name: string; city: string | null; state: string | null };
  products: PublicLinkProduct[];
  shipping_charge_cents: number;
  tax_enabled: boolean;
  locked_payer: { name: string; email: string | null; phone: string | null } | null;
  sandbox: boolean;
  publishable_key: string;
  stripe_account_id: string;
  active: boolean;
  /** Preselected product id from the link, or null when the payer chooses. */
  preselected_product_id: string | null;
}

export interface PublicOrderRequest {
  items: Array<{ product_id: string; quantity: number }>;
  payer?: { name: string; email: string; phone: string };
  shipping_address: ShippingAddress;
  purchase: 'one_time' | 'subscription';
}

export interface PublicOrderResponse {
  order_id: string;
  order_number: string;
  client_secret: string;
  stripe_account_id: string;
  publishable_key: string;
  sandbox: boolean;
  totals: { subtotal_cents: number; shipping_charge_cents: number; tax_cents: number; total_cents: number };
  subscription: { every_weeks: 4; renews_on: string } | null;
}

export interface PublicOrderStatus {
  order_id: string;
  order_number: string;
  status: OrderStatus;
  total_cents: number;
  tax_cents: number;
  subtotal_cents: number;
  shipping_charge_cents: number;
  items: Array<{ name: string; quantity: number; unit_price_cents: number }>;
  office_name: string;
  payer_email: string | null;
  subscription: { every_weeks: 4; renews_on: string | null } | null;
}

export interface PublicSubscription {
  product_name: string;
  office_name: string;
  unit_price_cents: number;
  shipping_charge_cents: number;
  status: SubscriptionStatus;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

export interface PaymentsHealth {
  sandbox: boolean;
  livemode: boolean;
  credentials_ok: boolean;
  connect_client_id_configured: boolean;
  public_origin: string | null;
  webhooks: {
    registered: boolean;
    endpoints: Array<{ kind: 'platform' | 'connect'; url: string; enabled_events: number; status: string }>;
    last_error: string | null;
    last_checked_at: string | null;
  };
  last_webhook_received_at: string | null;
  pending_orders_over_1h: number;
  unprocessed_webhook_events: number;
  last_reconcile_run: { at: string; status: string } | null;
  failed_events_24h: number;
  /** Stripe-originated customer email posture: the platform never charges, connected accounts are tracked per office. */
  stripe_customer_emails?: {
    platform: 'not_applicable';
    accounts_off: number;
    accounts_unverified: string[];
    accounts_on: string[];
  };
}

/* ------------------------------------------------------------------ */
/* Patient billing (mobile app, authenticated patient routes)          */
/* ------------------------------------------------------------------ */

/** The patient's own office as a place to pay. */
export interface PatientBillingOffice {
  provider_id: string;
  office_name: string;
  /** True only when the office can take payments today (connected, charges enabled, at least one product priced). */
  payments_available: boolean;
}

export interface PatientBillingOrder {
  id: string;
  order_number: string;
  kind: OrderKind;
  status: OrderStatus;
  fulfillment_status: FulfillmentStatus;
  total_cents: number;
  refunded_cents: number;
  item_count: number;
  items_label: string;
  created_at: string;
  paid_at: string | null;
  /** True when a Stripe receipt or invoice can be fetched for this order. */
  receipt_available: boolean;
  /** Parcel state; "processing" until a carrier and tracking number are recorded. */
  shipment: PatientShipment;
  subscription_id: string | null;
  /** Groups the orders one in-app checkout created together. */
  cart_id: string | null;
}

export interface PatientBillingSubscription {
  id: string;
  product_name: string;
  unit_price_cents: number;
  shipping_charge_cents: number;
  status: SubscriptionStatus;
  paused: boolean;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  /** Stripe-hosted page to settle an open failed invoice, when one exists. */
  last_hosted_invoice_url: string | null;
  last_failure_message: string | null;
  product_id: string;
  cadence_weeks: number;
  quantity: number;
  /** When the next box ships (and is charged); moved by skip / move-next. */
  next_shipment_at: string | null;
  shipping_address: ShippingAddress;
}

export interface PatientBillingOverview {
  office: PatientBillingOffice | null;
  /** What the office currently sells to patients (empty when payments are unavailable). */
  products: PublicLinkProduct[];
  shipping_charge_cents: number;
  orders: PatientBillingOrder[];
  subscriptions: PatientBillingSubscription[];
}

/** Card on file for the patient at this office; "unknown" when Stripe could not be asked. */
export interface PatientPurchasesCard {
  state: 'on_file' | 'none' | 'unknown';
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
}
export interface PatientCheckoutLinkRequest {
  /** Preselect one product on the checkout page; null lets the patient choose. */
  product_id?: string | null;
}

export interface PatientCheckoutLink {
  url: string;
  token: string;
  expires_at: string | null;
}

export interface PatientReceipt {
  order_number: string;
  /** Stripe card receipt (one-time orders). */
  receipt_url: string | null;
  /** Stripe-hosted invoice page (subscription orders). */
  invoice_url: string | null;
  /** Direct PDF download of the invoice (subscription orders). */
  invoice_pdf_url: string | null;
}

/* ------------------------------------------------------------------ */
/* Patient shop (in-app cart, saved cards, orders, subscriptions)      */
/* ------------------------------------------------------------------ */

/** Parcel state for one order. "processing" until staff or the shipping provider records a carrier and tracking number. */
export type ShipmentStatus = 'processing' | 'shipped' | 'delivered' | 'canceled';

export interface PatientShipment {
  status: ShipmentStatus;
  carrier: string | null;
  tracking_number: string | null;
  /** Carrier tracking page when the carrier is recognized (USPS, UPS, FedEx) or the provider supplied one. */
  tracking_url: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  canceled_at: string | null;
  updated_at: string;
}

export type ShopUnavailableReason = 'not_connected' | 'no_products';

/** The patient's office storefront. Empty products + a reason when the office cannot sell today. */
export interface PatientShop {
  office: PatientBillingOffice | null;
  available: boolean;
  unavailable_reason: ShopUnavailableReason | null;
  products: PublicLinkProduct[];
  shipping_charge_cents: number;
  /** Program-wide subscribe-and-save percent (0 when the discount is off). */
  subscribe_save_percent: number;
  /** Address from the patient's most recent order, to prefill checkout. */
  default_address: ShippingAddress | null;
  /** Connected account the app must pass to Stripe for card entry (null when unavailable). */
  stripe_account_id: string | null;
  publishable_key: string | null;
  sandbox: boolean;
}

export type CartPurchase = 'one_time' | 'subscription';

export interface CartLineInput {
  product_id: string;
  quantity: number;
  purchase: CartPurchase;
  /** Required for subscription lines; must be a cadence the product offers. */
  cadence_weeks?: number | null;
}

export interface CartQuoteRequest {
  lines: CartLineInput[];
}

export interface CartQuoteLine {
  product_id: string;
  name: string;
  purchase: CartPurchase;
  quantity: number;
  cadence_weeks: number | null;
  /** Price charged per unit (already discounted for subscription lines). */
  unit_price_cents: number;
  /** Office (or floor) price per unit before the subscribe-and-save discount. */
  list_price_cents: number;
  discount_cents: number;
  line_total_cents: number;
}

/** One charge the checkout will create: the one-time order, or one subscription per subscribed line. */
export interface CartQuoteGroup {
  kind: CartPurchase;
  /** Set for subscription groups. */
  product_id: string | null;
  cadence_weeks: number | null;
  quantity: number;
  subtotal_cents: number;
  /** Shipping is charged once per group (each subscription ships on its own schedule). */
  shipping_charge_cents: number;
  total_cents: number;
}

export interface CartQuote {
  lines: CartQuoteLine[];
  groups: CartQuoteGroup[];
  subtotal_cents: number;
  discount_cents: number;
  shipping_charge_cents: number;
  /** Charged today, before tax (tax is computed by Stripe per office at confirmation). */
  total_cents: number;
}

export interface CartCheckoutRequest extends CartQuoteRequest {
  shipping_address: ShippingAddress;
  /** A Stripe PaymentMethod created on the office's connected account (new card) or one already saved to the patient. */
  payment_method_id: string;
  /** Make this card the default for future renewals (default true for a first card). */
  set_default?: boolean;
  /** Stable per-cart key; the Idempotency-Key header takes precedence. Retrying the same key replays the first attempt. */
  cart_id?: string;
}

export type CheckoutItemStatus = 'paid' | 'requires_action' | 'failed';

export interface CartCheckoutItem {
  kind: CartPurchase;
  order_id: string;
  order_number: string;
  subscription_id: string | null;
  status: CheckoutItemStatus;
  /** PaymentIntent secret to finish 3DS in the app when status is requires_action. */
  client_secret: string | null;
  error: string | null;
  total_cents: number;
}

export type CheckoutStatus = 'paid' | 'requires_action' | 'partial' | 'failed';

export interface CartCheckoutResponse {
  cart_id: string;
  status: CheckoutStatus;
  items: CartCheckoutItem[];
  stripe_account_id: string;
  publishable_key: string;
  sandbox: boolean;
}

export interface PatientCard {
  id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  is_default: boolean;
}

export interface PatientCardList {
  cards: PatientCard[];
  default_payment_method_id: string | null;
}

/** SetupIntent for adding a card outside checkout. */
export interface PatientCardSetup {
  client_secret: string;
  stripe_account_id: string;
  publishable_key: string;
  sandbox: boolean;
}

export interface PatientCardAddRequest {
  payment_method_id: string;
  set_default?: boolean;
}

export interface PatientOrderItem {
  product_id: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
}

export interface PatientOrderRefund {
  amount_cents: number;
  status: string;
  created_at: string;
}

export interface PatientOrderDetail extends PatientBillingOrder {
  items: PatientOrderItem[];
  subtotal_cents: number;
  shipping_charge_cents: number;
  tax_cents: number;
  refunds: PatientOrderRefund[];
  shipping_address: ShippingAddress;
  failure_message: string | null;
}

export interface PatientOrderList {
  items: PatientBillingOrder[];
  next_cursor: string | null;
}

export interface PatientSubscriptionDetail extends PatientBillingSubscription {
  /** Card charged at renewal (null when Stripe has none on the subscription yet). */
  card: PatientCard | null;
  /** Cadences the product offers today (for the change-plan sheet). */
  offered_cadences_weeks: number[];
}

export interface SubscriptionMoveNextRequest {
  /** Calendar date (YYYY-MM-DD) or ISO timestamp; must be in the future and within a year. */
  next_shipment_at: string;
}

export interface SubscriptionAddressRequest {
  shipping_address: ShippingAddress;
}

export interface SubscriptionPlanRequest {
  cadence_weeks?: number;
  quantity?: number;
}

export interface SubscriptionCardRequest {
  payment_method_id: string;
}

/** The most recent failed charge, whether a renewal or a one-off order. */
export interface PatientPaymentProblem {
  source: 'subscription' | 'order';
  subscription_id: string | null;
  order_id: string | null;
  order_number: string | null;
  at: string;
  message: string | null;
  /** Stripe-hosted page to settle an open failed invoice, when one exists. */
  hosted_invoice_url: string | null;
}

/** Staff-facing purchases summary for one patient, scoped to one office. */
export interface PatientPurchasesSummary {
  patient_id: string;
  /** Every subscription at this office, newest first (canceled ones included). */
  subscriptions: PatientBillingSubscription[];
  /** The most recent orders with shipment state, newest first. */
  orders: PatientBillingOrder[];
  totals: PatientPurchasesTotals;
  saved_card: PatientPurchasesCard;
  last_payment_problem: PatientPaymentProblem | null;
}

export interface PatientPurchasesTotals {
  /** Every order ever placed at this office, not just the recent slice. */
  order_count: number;
  lifetime_paid_cents: number;
  lifetime_refunded_cents: number;
  /** paid minus refunded. */
  lifetime_net_cents: number;
  last_paid_at: string | null;
  active_subscription_count: number;
}
