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

export interface PublicLinkProduct {
  product_id: string;
  name: string;
  description: string;
  image_url: string | null;
  unit_price_cents: number;
  subscription_available: boolean;
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