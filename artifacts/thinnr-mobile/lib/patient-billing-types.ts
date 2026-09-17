/** Verbatim mobile copy of the frozen patient billing wire contract. */
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
export type CadenceWeeks = 2 | 4 | 6 | 8 | 10 | 12;

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

export type ProductCategory = 'drops' | 'supplement' | 'bundle';
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
  /** When given, the quote includes the sales-tax estimate for this destination. */
  shipping_address?: ShippingAddress;
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

export interface SubscriptionRetryPaymentRequest {
  payment_method_id?: string;
}

export interface SubscriptionCardRequest {
  payment_method_id: string;
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

/** One supplement-facts / ingredients row. */
export interface ProductFactRow {
  name: string;
  detail: string | null;
}
