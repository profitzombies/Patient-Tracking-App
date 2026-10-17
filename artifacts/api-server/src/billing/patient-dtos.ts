import { shipmentDto } from "./shipments";
import {
  shipmentTerms, type BillingOrderItemRow, type BillingOrderRow, type BillingRefundRow, type BillingShipmentRow, type BillingSubscriptionRow,
} from "./store";
import type { PatientBillingOrder, PatientBillingSubscription, PatientShippingChoice, ShippingAddress } from "./types";

/**
 * Patient-facing order and subscription DTOs. Staff summaries (the patient
 * record's Purchases panel) reuse these same shapes so both sides of the
 * counter describe an order identically.
 */
const enc = encodeURIComponent;
export const paidStatuses = new Set(["paid", "partially_refunded", "refunded"]);

export function shippingChoice(row: Parameters<typeof shipmentTerms>[0]): PatientShippingChoice {
  const terms = shipmentTerms(row);
  return {
    method: terms.shipping_method, source: terms.shipping_source, carrier_service_name: terms.carrier_service_name,
    delivery_window_start: terms.delivery_window_start, delivery_window_end: terms.delivery_window_end,
  };
}

export function subscriptionDto(row: BillingSubscriptionRow, productName: string): PatientBillingSubscription {
  return {
    id: row.id,
    kind: row.kind === "app_access" ? "app_access" : "product",
    product_name: productName,
    unit_price_cents: row.unit_price_cents,
    shipping_charge_cents: row.shipping_charge_cents,
    status: row.status as PatientBillingSubscription["status"],
    paused: row.paused_at != null,
    current_period_end: row.current_period_end,
    cancel_at_period_end: row.cancel_at_period_end,
    last_hosted_invoice_url: row.last_hosted_invoice_url,
    last_failure_message: row.last_failure_message,
    product_id: row.product_id,
    cadence_weeks: row.cadence_weeks ?? 4,
    quantity: row.quantity ?? 1,
    next_shipment_at: row.next_shipment_at ?? row.current_period_end,
    shipping_address: row.shipping_address as unknown as ShippingAddress,
    shipping: shippingChoice(row),
  };
}

export function orderDto(
  order: BillingOrderRow, items: BillingOrderItemRow[], refunds: BillingRefundRow[], shipment: BillingShipmentRow | null,
): PatientBillingOrder {
  return {
    id: order.id,
    order_number: order.order_number,
    kind: order.kind,
    status: order.status as PatientBillingOrder["status"],
    fulfillment_status: order.fulfillment_status as PatientBillingOrder["fulfillment_status"],
    total_cents: order.total_cents,
    refunded_cents: refunds.reduce((sum, refund) => sum + refund.amount_cents, 0),
    item_count: items.reduce((sum, item) => sum + item.quantity, 0),
    items_label: items.map((item) => `${item.product_name_snapshot} × ${item.quantity}`).join(", "),
    created_at: order.created_at,
    paid_at: order.paid_at,
    receipt_available: paidStatuses.has(order.status) &&
      Boolean(order.stripe_charge_id || order.stripe_payment_intent_id || order.stripe_invoice_id),
    shipment: shipmentDto(order, shipment),
    subscription_id: order.subscription_id,
    cart_id: order.cart_id ?? null,
    shipping: shippingChoice(order),
  };
}

export function list(values: string[]): string {
  return `in.(${values.map(enc).join(",")})`;
}
