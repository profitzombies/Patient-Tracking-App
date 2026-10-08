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

export type OfficeAccessSlot = 'bank' | 'card_primary' | 'card_backup';
export type OfficeAccessStepId = 'connect' | OfficeAccessSlot | 'plan' | 'disclosure';
export type OfficeAccessStepStatus = 'done' | 'pending' | 'todo' | 'blocked';

export interface OfficeAccessInstrument {
  slot: OfficeAccessSlot;
  kind: 'bank' | 'card';
  brand: string | null;
  last4: string;
  expMonth: number | null;
  expYear: number | null;
  bankName: string | null;
  verificationStatus: 'verified' | 'pending' | 'failed';
  verificationDeadline: string | null;
  /** The cardholder / account-holder name saved on the method in Stripe. */
  holderName?: string | null;
  addedAt: string;
}

/** A replacement bank waiting on test deposits; the bank in service stays chargeable meanwhile. */
export interface OfficeAccessBankReplacement {
  bankName: string | null;
  last4: string;
  holderName: string | null;
  deadline: string | null;
  verificationUrl: string | null;
  addedAt: string;
}

export interface OfficeAccessSnapshot {
  office: { providerId: string; officeName: string };
  complete: boolean;
  connectAlreadyDone: boolean;
  steps: Array<{ id: OfficeAccessStepId; status: OfficeAccessStepStatus; detail: string | null }>;
  connect: { state: 'not_started' | 'action_required' | 'pending' | 'ready'; sandbox: boolean };
  instruments: OfficeAccessInstrument[];
  plan: {
    selected: 'monthly' | 'yearly' | null;
    monthlyPriceCents: number;
    yearlyPriceCents: number;
    priceCents: number;
    firstChargeAt: string | null;
    includedPeriodDays: number;
    nextPeriodEndsAt: string | null;
  };
  disclosure: { text: string; version: number; acknowledgedAt: string | null };
  bank: {
    verificationPending: boolean; deadline: string | null; overdue: boolean; windowHours: number; verificationUrl: string | null;
    replacement?: OfficeAccessBankReplacement | null;
  };
  balance: { state: 'setup_incomplete' | 'included_period' | 'paid_current' | 'past_due' | 'restricted'; outstanding: boolean; amountCents: number; graceEndsAt: string | null };
  canManage: boolean;
  canChoosePlan: boolean;
}

export interface OfficeAccessSetupIntent {
  clientSecret: string;
  setupIntentId: string;
  publishableKey: string;
  slot: OfficeAccessSlot;
  /** What the form's holder name and email start as; the office may edit both. */
  billingDetails?: { name: string | null; email: string | null };
}

export interface AiCostTotals {
  calls: number;
  ok_calls: number;
  error_calls: number;
  aborted_calls: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_share: number;
  cost_usd: number;
  unpriced_calls: number;
  active_patients: number;
  ai_patients: number;
  cost_per_active_patient_usd: number | null;
  cost_per_ai_patient_usd: number | null;
}
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

export type ShippingMethod = 'standard' | 'expedited';
export type ShippingSource = 'live' | 'fallback';
export type PickPackTier = 'under_50' | 'from_51' | 'from_100' | 'from_250' | 'from_500' | 'from_1500';
/** NovEx D2C pick-and-pack schedule (cents); HQ-editable, seeded from the pricing proposal. */
export interface PickPackSchedule {
  order_fee_cents: Record<PickPackTier, number>;
  unit_cents: number;
  oversized_unit_cents: number;
  overweight_pick_cents: number;
  overweight_threshold_lb: number;
  packaging_cents: number;
}
/** HQ shipping rules beyond the flat fallback charge. */
export interface ShippingRules {
  /** Standard shipping is free when a shipment's item subtotal reaches this; null = never free. */
  free_shipping_over_cents: number | null;
  pick_pack_tier: PickPackTier;
  pick_pack_schedule: PickPackSchedule;
  /** Whether patients pay the pick-and-pack fee unless an office overrides it. */
  pick_pack_pass_through_default: boolean;
  /** Offer USPS Priority Mail as "Expedited" at checkout. */
  expedited_enabled: boolean;
}
export interface BillingSettings extends ShippingRules {
  /** Paid one-time orders in the trailing 7 days (hint beside the tier picker; never auto-switches the tier). */
  weekly_paid_orders: number;
  /** Fallback "Shipping & handling" carrier component when WarehouseCraft cannot rate. */
  shipping_charge_cents: number;
  shipping_cost_cents: number;
  card_fee_bps: number;
  card_fee_fixed_cents: number;
  /** Subscribe-and-save: when off, no discount is quoted or charged anywhere. */
  subscribe_save_enabled: boolean;
  /** Whole percent off every subscription renewal while enabled (kept while off). */
  subscribe_save_percent: number;
  /** Kill switch: paid orders keep queueing warehouse intents, but nothing is sent while off. */
  warehouse_auto_submit?: boolean;
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

/**
 * Patient signals the coach may cite when suggesting a product. The
 * vocabulary is fixed here; HQ picks which ids each product responds to
 * (`CoachSuggestionRule`). Bloodwork ids only ever produce "worth asking
 * your provider about" nudges unless the product content covers the marker.
 */
export const COACH_SUGGESTION_SIGNALS = [
  'stall', 'weight_regain', 'off_plan_meals', 'low_logging', 'low_protein', 'low_water', 'program_complete',
  'glp1_medication', 'diabetes_medication', 'blood_thinner_medication',
  'bloodwork_glucose_high', 'bloodwork_lipids_high', 'bloodwork_liver_high', 'bloodwork_b12_low',
  'bloodwork_vitamin_d_low', 'bloodwork_iron_low', 'bloodwork_kidney_flag',
] as const;
export type CoachSuggestionSignal = (typeof COACH_SUGGESTION_SIGNALS)[number];
export const COACH_SIGNAL_LABELS: Record<CoachSuggestionSignal, string> = {
  stall: 'Weight stalled: three weeks of weigh-ins with no real drop',
  weight_regain: 'Weight climbing back: recent weigh-ins above the earlier ones',
  off_plan_meals: 'Repeated off-plan meals in the last two weeks',
  low_logging: 'Logging has lapsed: three or fewer diary days in the last week',
  low_protein: 'Protein running under 70% of target this week',
  low_water: 'Water running under 60% of target this week',
  program_complete: 'Past day 42 of the program',
  glp1_medication: 'Active GLP-1 medication on record',
  diabetes_medication: 'Active diabetes medication on record (metformin, insulin, sulfonylureas)',
  blood_thinner_medication: 'Active blood thinner on record',
  bloodwork_glucose_high: 'Bloodwork: glucose, A1c, or insulin flagged high',
  bloodwork_lipids_high: 'Bloodwork: cholesterol, LDL, or triglycerides flagged high',
  bloodwork_liver_high: 'Bloodwork: liver enzymes (ALT, AST, GGT) flagged high',
  bloodwork_b12_low: 'Bloodwork: B12 or folate flagged low',
  bloodwork_vitamin_d_low: 'Bloodwork: vitamin D flagged low',
  bloodwork_iron_low: 'Bloodwork: iron, ferritin, or hemoglobin flagged low',
  bloodwork_kidney_flag: 'Bloodwork: kidney markers (creatinine, eGFR, BUN) flagged',
};
export function isBloodworkSignal(signal: CoachSuggestionSignal): boolean {
  return signal.startsWith('bloodwork_');
}
/** HQ-edited rule for when the coach may suggest a product; lives with the catalog content. */
export interface CoachSuggestionRule {
  /** Any one of these signals makes the product eligible for a data-driven suggestion. */
  signals: CoachSuggestionSignal[];
  /** Any one of these blocks the product entirely, even for a conversation match (contraindication flags). */
  avoid_signals: CoachSuggestionSignal[];
  /** Guidance the coach model reads when it mentions the product. */
  phrasing: string;
  /** When true the product content explicitly covers the lab markers in its signals; otherwise bloodwork nudges defer to the provider. */
  bloodwork_covered: boolean;
  /** Conversation phrases (lowercase, matched as whole words in the patient's latest message) that make the product eligible for a conversation offer. */
  topics: string[];
}
export const EMPTY_COACH_SUGGESTION: CoachSuggestionRule = { signals: [], avoid_signals: [], phrasing: '', bloodwork_covered: false, topics: [] };

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

/** Per-product fulfillment data used for live shipping rates and pick-and-pack fees. */
export interface ProductFulfillment {
  /** WarehouseCraft SKU (what NovEx picks); null until HQ maps the product. */
  warehousecraft_sku: string | null;
  /** Shipping weight per unit in ounces; live rating needs it, otherwise the flat charge applies. */
  shipping_weight_oz: number | null;
  package_length_in: number | null;
  package_width_in: number | null;
  package_height_in: number | null;
  /** Oversized units carry the higher NovEx unit fee. */
  oversized: boolean;
}
export interface CatalogProduct extends ProductPageContent, ProductCadences, ProductFulfillment {
  /** Coach suggestion rule (HQ editorial data; never sent to payers). */
  coach_suggestion: CoachSuggestionRule;
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
  | 'office_shipping_settings_updated'
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

/** What was quoted and locked for one shipment (order, or a subscription's current period). */
export interface ShipmentTerms {
  shipping_method: ShippingMethod;
  shipping_source: ShippingSource;
  carrier_service_name: string | null;
  /** Carrier price THINNR pays (live) or the flat HQ shipping cost (fallback). */
  carrier_cost_cents: number;
  pick_pack_fee_cents: number;
  packaging_cents: number;
  /** Whether the patient paid the pick-and-pack fee inside Shipping & handling (false = office absorbed it). */
  pick_pack_passed_through: boolean;
  delivery_window_start: string | null;
  delivery_window_end: string | null;
}
export interface FeeBreakdown {
  subtotal_cents: number;
  shipping_charge_cents: number;
  shipping: ShipmentTerms;
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
  /** Carrier cost (live quote) or the flat HQ shipping cost (fallback). */
  shipping_cost_cents: number;
  /** NovEx pick-and-pack + packaging THINNR paid for this shipment. */
  fulfillment_fee_cents: number;
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

/** WarehouseCraft submission outcome for an order (null until the order is paid, and for legacy rows). */
export interface WarehouseSubmission {
  state: "pending" | "sent" | "needs_attention" | "skipped";
  warehouse_order_id: string | null;
  warehouse_status: string | null;
  sent_at: string | null;
  error: string | null;
  attempts: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
}

/** Shipment record state, written by staff or by the WarehouseCraft status feed. */
export interface OrderShipmentState {
  status: "processing" | "shipped" | "delivered" | "canceled";
  /** Who wrote the current state: staff from the fulfillment screens, or the warehouse feed. */
  source: "staff" | "provider";
  delivered_at: string | null;
  /** The warehouse reports the order as back-ordered (staff-facing; patient copy stays neutral). */
  back_ordered: boolean;
  /** Raw WarehouseCraft status as last seen on the feed; null before the first poll. */
  warehouse_status: string | null;
  warehouse_status_at: string | null;
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
  /** Optional: older demo fixtures omit it; live rows carry it once paid. */
  warehouse?: WarehouseSubmission | null;
  /** Optional: demo fixtures and pre-shipment-record orders omit it. */
  shipment?: OrderShipmentState | null;
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
  /** Locked shipment terms for the current period (re-quoted before each renewal bills). */
  shipping: ShipmentTerms;
  /** When the current period's shipping was last re-quoted; null before the first renewal. */
  shipping_requoted_at: string | null;
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
  stripe_account_id?: string;
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
  /** Monthly recurring revenue: active subscriptions' price × quantity normalized from cadence weeks to a month; shipping excluded. */
  mrr_cents: number;
  /** Subscriptions whose renewal payment failed (past_due or unpaid). */
  needs_attention_subscriptions: number;
  to_ship: number;
  /** False until the office has connected a payments account. */
  account_connected: boolean;
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

// ---------- office access subscriptions (what an office pays THINNR) ----------

export type OfficeAccessState = 'setup_incomplete' | 'included_period' | 'paid_current' | 'past_due' | 'restricted';
export type OfficeAccessPlan = 'monthly' | 'yearly';
export type PaidThroughSource = 'stripe' | 'offline' | 'hq_migration';

/**
 * One office's access terms. `state` is null for an office no subscription
 * work has touched yet — honestly nothing, not a zeroed-out subscription.
 */
export interface OfficeAccessTerms {
  state: OfficeAccessState | null;
  plan: OfficeAccessPlan | null;
  priceCents: number | null;
  priceCentsOverride: number | null;
  lifetime: boolean;
  includedPeriodStartedAt: string | null;
  includedPeriodEndsAt: string | null;
  paidThrough: string | null;
  paidThroughSource: PaidThroughSource | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  graceDaysLeft: number | null;
  restrictedAt: string | null;
  setupCompletedAt: string | null;
  bankVerificationDeadline: string | null;
  lastAttemptAt: string | null;
  nextChargeAt: string | null;
  version: number | null;
}

export interface OfficeAccessPolicy {
  monthlyPriceCents: number;
  yearlyPriceCents: number;
  includedPeriodDays: number;
  gracePeriodDays: number;
  normalSharePercent: number;
  restrictedSharePercent: number;
  maxIncludedPeriodDays: number;
}

/** Problems that would stop an office's next access charge going through first time. */
export type AppPaymentFlag = 'no_method' | 'card_expiring' | 'bank_unverified';

/** A bank account or card on file for the access subscription (in service only). */
export interface AppPaymentInstrument {
  slot: OfficeAccessSlot;
  kind: 'bank' | 'card';
  brand: string | null;
  bankName: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  verificationStatus: 'verified' | 'pending' | 'failed';
}

export interface AppPaymentLastPayment {
  at: string;
  amountCents: number;
  outcome: 'succeeded' | 'failed' | 'processing' | 'reversed' | 'offline';
  slot: OfficeAccessSlot | null;
  failureCode: string | null;
}

export interface OfficeAccessBoardRow extends OfficeAccessTerms {
  providerId: string;
  officeName: string;
  locked: boolean;
  /** Payment facts; older servers omit them, so every reader treats them as optional. */
  instruments?: AppPaymentInstrument[];
  trialDaysLeft?: number | null;
  nextChargeCents?: number | null;
  lastPayment?: AppPaymentLastPayment | null;
  paymentFlags?: AppPaymentFlag[];
}

export type AppChargeType = 'trial_conversion' | 'renewal';
export type AppChargeRisk = AppPaymentFlag | 'past_due' | 'restricted' | 'setup_incomplete';

export interface AppScheduledCharge {
  providerId: string;
  officeName: string;
  /** ISO instant the charge is expected. */
  date: string;
  type: AppChargeType;
  plan: OfficeAccessPlan;
  amountCents: number;
  atRisk: boolean;
  riskReasons: AppChargeRisk[];
}

export interface AppForecastTotals {
  totalCents: number;
  renewalCents: number;
  trialConversionCents: number;
  monthlyCents: number;
  yearlyCents: number;
  atRiskCents: number;
  count: number;
}

export interface AppForecastPeriod extends AppForecastTotals {
  /** `YYYY-MM` for months, `YYYY-MM-DD` (the Monday) for weeks. */
  key: string;
  start: string;
}

export interface AppOutstandingBalance {
  providerId: string;
  officeName: string;
  state: OfficeAccessState;
  since: string;
  plan: OfficeAccessPlan;
  amountCents: number;
  inFlight: boolean;
}

/** GET /hq/office-access/forecast — an estimate at current plans and prices. */
export interface AppPaymentsForecast {
  start: string;
  end: string;
  bucket: 'week' | 'month';
  charges: AppScheduledCharge[];
  periods: AppForecastPeriod[];
  totals: AppForecastTotals;
  outstanding: { totalCents: number; offices: AppOutstandingBalance[] };
  estimate: true;
}

export interface AppCollectedMonth {
  key: string;
  collectedCents: number;
  offlineCents: number;
  reversedCents: number;
  netCents: number;
  succeededCount: number;
  failedCount: number;
  failedCents: number;
  processingCount: number;
}

/** GET /hq/office-access/collected — what actually came in over a past range. */
export interface AppPaymentsCollected {
  start: string;
  end: string;
  months: AppCollectedMonth[];
  totals: AppCollectedMonth;
}

export interface OfficeAccessBoard {
  offices: OfficeAccessBoardRow[];
  counts: {
    total: number;
    notStarted: number;
    setupIncomplete: number;
    includedPeriod: number;
    paidCurrent: number;
    pastDue: number;
    restricted: number;
    trialsEndingSoon: number;
  };
  policy: OfficeAccessPolicy;
  trialEndingSoonDays: number;
}

export interface OfficeAccessInstrumentRow {
  id: string;
  slot: OfficeAccessSlot;
  kind: 'bank' | 'card';
  brand: string | null;
  last4: string | null;
  bankName: string | null;
  expMonth: number | null;
  expYear: number | null;
  verificationStatus: 'verified' | 'pending' | 'failed';
  verificationDeadline: string | null;
  removedAt: string | null;
}

export interface OfficeAccessAttempt {
  id: string;
  periodStart: string;
  periodEnd: string;
  cycle: number;
  slot: OfficeAccessSlot;
  plan: OfficeAccessPlan;
  amountCents: number;
  status: 'processing' | 'succeeded' | 'failed';
  failureCode: string | null;
  failureMessage: string | null;
  settledAt: string | null;
  failedAt: string | null;
  createdAt: string;
}

export interface OfficeAccessHistoryEntry {
  id: number;
  event: string;
  fromState: OfficeAccessState | null;
  toState: OfficeAccessState | null;
  actorKind: 'system' | 'hq' | 'provider' | 'team_member' | 'stripe';
  actorUserId: string | null;
  actorName: string | null;
  detail: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface OfficeAccessDetail {
  office: { providerId: string; officeName: string };
  subscription: OfficeAccessTerms | null;
  setup: {
    complete: boolean;
    missing: OfficeAccessSlot[];
    bankVerificationPending: boolean;
    bankVerificationDeadline: string | null;
    bankVerificationOverdue: boolean;
  } | null;
  instruments: OfficeAccessInstrumentRow[];
  attempts: OfficeAccessAttempt[];
  history: OfficeAccessHistoryEntry[];
  policy: OfficeAccessPolicy;
}

export interface OfficeAccessChange {
  subscription: OfficeAccessTerms | null;
}

export interface HqCatalogResponse {
  products: CatalogProduct[];
  settings: BillingSettings;
  offices_below_minimum: number;
}

export interface CatalogProductInput extends Partial<ProductPageContent>, Partial<ProductCadences>, Partial<ProductFulfillment> {
  coach_suggestion?: CoachSuggestionRule;
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

/** How a cancel/address change was mirrored at WarehouseCraft (returned by the cancel and address routes). */
export type WarehouseSync =
  | { kind: 'not_sent' }
  | { kind: 'applied'; warehouse_order_id: string }
  | { kind: 'locked'; warehouse_status: string }
  | { kind: 'unavailable'; message: string };

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
  /** Stable catalog slug (matches the bundled mobile catalog), so app deep links keyed by catalog id can find the storefront row. */
  slug: string;
  name: string;
  description: string;
  image_url: string | null;
  /** Every product image in display order (the default first); empty when HQ has uploaded none. */
  image_urls: string[];
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

export interface BillingModeStatus {
  mode: 'test' | 'live';
  version: number | null;
  selection_loaded?: boolean;
  setup?: { ready: boolean; missing: string[]; message: string | null };
  configuration: Record<'test' | 'live', { configured: boolean; missing: string[]; errors?: string[] }>;
}

/** One Stripe webhook destination as the server judged it ("unknown" when Stripe could not be asked). */
export type PaymentsWebhookStatus =
  | 'missing' | 'wrong_scope' | 'disabled' | 'missing_events' | 'secret_missing'
  | 'version_unknown' | 'version_mismatch' | 'missing_recommended' | 'ok' | 'unknown';

export interface PaymentsWebhookEndpointHealth {
  kind: 'platform' | 'connect';
  url: string;
  status: PaymentsWebhookStatus;
  enabled_events: number;
  missing_events?: string[];
  missing_recommended_events?: string[];
  api_version?: string | null;
  secret_configured?: boolean;
}

export interface PaymentsHealth {
  sandbox: boolean;
  livemode: boolean;
  credentials_ok: boolean;
  connect_client_id_configured: boolean;
  public_origin: string | null;
  webhooks: {
    /** The mode these endpoints were read from (the selected payments mode). */
    mode?: 'test' | 'live';
    /** True only when both endpoints exist, are on, carry every billing event, have their secret saved and speak the server's API version. */
    registered: boolean;
    /** The Stripe API version the server reads events in. */
    expected_api_version?: string;
    endpoints: PaymentsWebhookEndpointHealth[];
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

/** The shipping choice the patient sees on an order or upcoming renewal (costs stay staff-only). */
export interface PatientShippingChoice {
  method: ShippingMethod;
  /** "fallback" = the flat charge applied because no live rate was available (no delivery window). */
  source: ShippingSource;
  carrier_service_name: string | null;
  /** Calendar dates (YYYY-MM-DD) from the live rate; null on fallback. */
  delivery_window_start: string | null;
  delivery_window_end: string | null;
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
  shipping: PatientShippingChoice;
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
  /** The method and last quote for the next box; the renewal is re-quoted before it bills. */
  shipping: PatientShippingChoice;
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
  /** Sales tax is added at payment for this office (estimated once a shipping address is known). */
  tax_enabled: boolean;
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
  /** Defaults to standard. */
  shipping_method?: ShippingMethod;
}

/** One shipping choice for the whole cart (each group is rated on its own; amounts are summed). */
export interface CartShippingOption {
  method: ShippingMethod;
  label: string;
  /** Sum of the per-group Shipping & handling lines for this method. */
  amount_cents: number;
  /** Free-over applied to every group's standard line. */
  free: boolean;
  source: ShippingSource;
  /** Earliest / latest calendar dates across the cart's shipments (YYYY-MM-DD); null on fallback. */
  delivery_window_start: string | null;
  delivery_window_end: string | null;
}
export interface CartGroupShipping {
  method: ShippingMethod;
  source: ShippingSource;
  carrier_service_name: string | null;
  delivery_window_start: string | null;
  delivery_window_end: string | null;
  free_shipping_applied: boolean;
  /** Whether this line includes the pick-and-pack fee. */
  pick_pack_passed_through: boolean;
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
  shipping: CartGroupShipping;
  total_cents: number;
}

export interface CartQuote {
  lines: CartQuoteLine[];
  groups: CartQuoteGroup[];
  subtotal_cents: number;
  discount_cents: number;
  shipping_charge_cents: number;
  /** The method these amounts were priced with. */
  shipping_method: ShippingMethod;
  /** Every offered method for this cart; null before an address is known (flat charge shown until then). */
  shipping_options: CartShippingOption[] | null;
  /** Short patient-facing note when the flat charge is in effect (no live rate). */
  shipping_note: string | null;
  /** Items plus shipping, before tax. */
  total_cents: number;
  /** Whether this office collects sales tax at payment (Stripe Tax on its account). */
  tax_enabled: boolean;
  /**
   * Estimated sales tax for the shipping address in the request; 0 when the
   * office does not collect tax, null when it does and no address was given yet.
   */
  tax_cents: number | null;
  /** total_cents + tax_cents: what the card is charged today; null while tax is still unknown. */
  total_due_cents: number | null;
}

/** Per-office shipping settings; null fields inherit HQ's default. */
export interface OfficeShippingSettings {
  pick_pack_pass_through: boolean | null;
  /** What applies after inheritance. */
  effective_pick_pack_pass_through: boolean;
  hq_default_pick_pack_pass_through: boolean;
  version: number;
  updated_at: string | null;
}
export interface CartCheckoutRequest extends CartQuoteRequest {
  shipping_address: ShippingAddress;
  /** A Stripe PaymentMethod created on the office's connected account (new card) or one already saved to the patient. */
  payment_method_id: string;
  /** Make this card the default for future renewals (default true for a first card). */
  set_default?: boolean;
  /** Stable per-cart key; the Idempotency-Key header takes precedence. Retrying the same key replays the first attempt. */
  cart_id?: string;
  /**
   * The amount the payer authorized on the Pay button: the quote's total_due_cents
   * (tax included). The server refuses (422) a fresh cart whose current price plus
   * tax differs, so the card is never charged an amount the payer did not see.
   */
  expected_total_due_cents: number;
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
  /** Sales tax inside total_cents once Stripe finalized the invoice. */
  tax_cents?: number;
  /** Cart lines this order carries (with kind, they identify the lines a partial result already paid). */
  product_ids: string[];
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

export type PrebuiltCartStatus = 'open' | 'verified' | 'checkout' | 'paid' | 'failed' | 'expired' | 'revoked' | 'locked';

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

export interface PublicCartDetails {
  billing_scope?: string;
  office: { name: string; city: string | null; state: string | null };
  patient: { name: string; email: string | null; phone: string | null } | null;
  lines: CartQuoteLine[];
  quote: CartQuote;
  products: PublicLinkProduct[];
  default_address: ShippingAddress | null;
  shipping_charge_cents: number;
  tax_enabled: boolean;
  stripe_account_id: string;
  publishable_key: string;
  sandbox: boolean;
  expires_at: string;
}

export type PublicCartStatusValue = 'open' | 'verified' | 'expired' | 'used' | 'revoked' | 'locked';

export interface PublicCartPeek {
  status: PublicCartStatusValue;
  office: { name: string };
  sandbox: boolean;
}

export interface StaffSaleContext {
  billing_scope?: string;
  patient: { id: string; name: string; email: string | null; phone: string | null };
  default_address: ShippingAddress | null;
  products: PublicLinkProduct[];
  shipping_charge_cents: number;
  subscribe_save_percent: number;
  stripe_account_id: string | null;
  publishable_key: string;
  sandbox: boolean;
  available: boolean;
  unavailable_reason: ShopUnavailableReason | null;
  tap_to_pay: TapToPayAvailability;
}

/** Why an office cannot take Tap to Pay sales yet; `null` reason = the server side is ready. */
export type TapToPayUnavailableReason = 'not_connected' | 'no_office_address' | 'terminal_unavailable';
export interface PublicCartStatus {
  /** Real cart state (the caller already verified the phone), including paid/failed. */
  status: PrebuiltCartStatus;
  partial: boolean;
  orders: Array<{ order_number: string; kind: CartPurchase; status: string; total_cents: number }>;
  office_name: string;
  paid_at: string | null;
}

export interface PrebuiltCartOrder {
  order_id: string;
  order_number: string;
  kind: CartPurchase;
  status: string;
}

export interface PrebuiltCart {
  id: string;
  token: string;
  url: string;
  status: PrebuiltCartStatus;
  partial: boolean;
  patient: { id: string; name: string } | null;
  lines: CartLineInput[];
  quote: CartQuote;
  label: string | null;
  expires_at: string;
  created_at: string;
  paid_at: string | null;
  orders: PrebuiltCartOrder[];
}

export interface TapToPayAvailability {
  available: boolean;
  reason: TapToPayUnavailableReason | null;
}

export interface TapSaleResponse {
  cart_id: string;
  items: TapSaleItem[];
  stripe_account_id: string;
  location_id: string;
  sandbox: boolean;
}

export interface TapSaleItem {
  kind: CartPurchase;
  order_id: string;
  order_number: string;
  subscription_id: string | null;
  /** Card-present PaymentIntent on the office's account; `null` once the line is paid or failed. */
  payment_intent_id: string | null;
  client_secret: string | null;
  status: TapSaleItemStatus;
  error: string | null;
  total_cents: number;
}

export type TapSaleItemStatus = 'ready' | 'paid' | 'failed';

/** Whether the tapped card is now saved for renewals: `null` for one-time lines. */
export type TapCardOnFile = 'saved' | 'needed' | null;

export interface TerminalConnectionToken {
  secret: string;
  /** The office's Terminal location; the phone registers itself as a reader here. */
  location_id: string;
  stripe_account_id: string;
}

export interface TapCaptureResponse {
  item: CartCheckoutItem;
  card_on_file: TapCardOnFile;
  checkout: CartCheckoutResponse;
}

export interface AiCostDay {
  day: string;
  calls: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  cached_share: number;
  cost_usd: number;
  ai_patients: number;
}

export interface AiCostModel {
  model: string;
  calls: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  cached_share: number;
  cost_usd: number;
  unpriced: boolean;
  rate: { input: number; cached: number; output: number } | null;
}

export interface AiCostOffice {
  provider_id: string;
  office_name: string | null;
  provider_name: string | null;
  calls: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  cached_share: number;
  cost_usd: number;
  ai_patients: number;
  active_patients: number;
  cost_per_active_patient_usd: number | null;
}

export interface AiCostSurface {
  surface: string;
  calls: number;
  error_calls: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_share: number;
  cost_usd: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  model: string | null;
}

export interface AiCostSummary {
  from: string;
  to: string;
  pricing_version: string;
  totals: AiCostTotals;
  unattributed: { calls: number; cost_usd: number };
  by_day: AiCostDay[];
  by_office: AiCostOffice[];
  by_surface: AiCostSurface[];
  by_model: AiCostModel[];
  models: { surface: string; model: string; overridden: boolean }[];
}

// ---------------- customer email ledger (SPEC §6, Customer email ledger) ----------------

export type CustomerEmailKind = 'automatic' | 'resend' | 'send_to_other';
export type CustomerEmailStatus = 'claimed' | 'retrying' | 'sent' | 'skipped' | 'failed';

export interface CustomerEmailAttempt {
  at: string;
  outcome: 'sent' | 'failed';
  error: string | null;
  vendor_message_id: string | null;
  recipient_domain: string | null;
}

export interface CustomerEmailEvent {
  id: string;
  event_type: string;
  occurred_at: string;
}

/** One email to one address, with every delivery attempt. Bodies are never stored; use the preview route. */
export interface CustomerEmail {
  id: string;
  kind: CustomerEmailKind;
  parent_id: string | null;
  contact_id: string | null;
  template_id: string;
  status: CustomerEmailStatus;
  recipient: string | null;
  subject: string | null;
  provider_id: string | null;
  office_name: string | null;
  payer_id: string | null;
  payer_name: string | null;
  patient_id: string | null;
  order_id: string | null;
  order_number: string | null;
  subscription_id: string | null;
  attempts: number;
  max_attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  sent_at: string | null;
  vendor_message_id: string | null;
  error: string | null;
  requested_by: string | null;
  created_at: string;
  attempt_log: CustomerEmailAttempt[];
  events: CustomerEmailEvent[];
  /** Vendor delivery facts folded onto the row by webhook ingestion (first time each was seen). Opens are pixel-based and indicative. */
  delivery: CustomerEmailDelivery;
}

export interface CustomerEmailDelivery {
  delivered_at: string | null;
  delayed_at: string | null;
  bounced_at: string | null;
  complained_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  last_event_type: string | null;
  last_event_at: string | null;
}

/** Counts over every row the active filter matches (not just the page); `truncated` when the tally hit its cap. */
export interface CustomerEmailSummary {
  total: number;
  sent: number;
  failed: number;
  bounced: number;
  opened: number;
  clicked: number;
  truncated: boolean;
}

export interface CustomerEmailList extends Paged<CustomerEmail> {
  payers: { id: string; name: string; email: string | null }[];
  /** Present when the request asked for `summary=1`. */
  summary?: CustomerEmailSummary;
  /** With `summary=1`: whether vendor delivery events can reach the server at all. */
  tracking?: { vendor: string; configured: boolean; last_event_at: string | null };
}

export interface CustomerEmailPreview {
  subject: string;
  html: string;
  text: string;
}

export interface CustomerEmailSendResult {
  email: CustomerEmail;
  outcome: 'sent' | 'retrying' | 'failed';
}

export interface NotificationContact {
  id: string;
  payer_id: string;
  email: string;
  label: string | null;
  active: boolean;
  created_at: string;
  removed_at: string | null;
  /** Staff member who added the address, when the server can still name them. */
  added_by_name: string | null;
}

export interface NotificationContactsResponse {
  payer: { id: string; name: string; email: string | null };
  contacts: NotificationContact[];
}

export interface NotificationContactChange {
  contact: NotificationContact;
  contacts: NotificationContact[];
}
