/**
 * Wire contract for the provider payments (Stripe Connect) API (server copy).
 * Mirrors docs/billing-connect/SPEC.md §6. Every money field is integer cents.
 * The API server is authoritative; keep these shapes in lockstep with
 * artifacts/thinnr-operations/src/lib/billing-types.ts (web copy).
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
  last_synced_at: string | null;
  disconnected_at: string | null;
  created_at: string;
}

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
    | 'tax_disabled';
  detail: Record<string, unknown>;
  created_at: string;
}

export interface BillingSettings {
  shipping_charge_cents: number;
  shipping_cost_cents: number;
  card_fee_bps: number;
  card_fee_fixed_cents: number;
  version: number;
  updated_at: string | null;
}

export interface CatalogProduct {
  id: string;
  slug: string;
  name: string;
  floor_price_cents: number;
  hard_cost_cents: number;
  active: boolean;
  retired_at: string | null;
  sort_order: number;
  thinnr_share_cents: number;
  break_even_minimum_cents: number;
  hq_profit_per_unit_cents: number;
  offices_offering: number;
  offices_below_minimum: number;
}

export interface CatalogChange {
  id: string;
  product_id: string | null;
  product_name: string | null;
  kind: 'product_created' | 'product_updated' | 'product_retired' | 'product_reactivated' | 'settings_updated';
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor_user_id: string | null;
  actor_name: string | null;
  created_at: string;
}

export interface OfficePrice {
  product_id: string;
  slug: string;
  name: string;
  active: boolean;
  floor_price_cents: number;
  break_even_minimum_cents: number;
  sell_price_cents: number | null;
  subscription_enabled: boolean;
  offered: boolean;
  below_minimum: boolean;
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
  renewals: number;
  livemode: boolean;
  created_at: string;
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
  collected_cents: number;
  net_cents: number;
  fee_cents: number;
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
  to_ship: number;
  series: SeriesPoint[];
}

export interface OfficePricesResponse {
  products: OfficePrice[];
  settings: { shipping_charge_cents: number; card_fee_bps: number; card_fee_fixed_cents: number };
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
  providers_onboarded: number;
  providers_pending: number;
  to_ship: number;
  series: SeriesPoint[];
  recent: Array<{
    id: string;
    kind: LedgerLine['kind'] | 'order_paid' | 'account_onboarded' | 'shipped';
    label: string;
    office_name: string;
    amount_cents: number | null;
    occurred_at: string;
    order_id: string | null;
  }>;
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

export interface CatalogProductInput {
  name: string;
  slug?: string;
  floor_price_cents: number;
  hard_cost_cents: number;
  sort_order?: number;
}

export interface FulfillmentUpdate {
  status: FulfillmentStatus;
  tracking_number?: string | null;
  carrier?: string | null;
  canceled_reason?: string | null;
}

// ---------- public ----------

export interface PublicLinkProduct {
  product_id: string;
  name: string;
  unit_price_cents: number;
  subscription_available: boolean;
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
