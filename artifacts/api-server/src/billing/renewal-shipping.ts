/**
 * Subscription renewals are re-quoted, never frozen at first checkout: shortly
 * before Stripe finalizes each renewal invoice the shipment is rated again for
 * the subscription's current address and method through the same rater the
 * cart uses. A live rate adjusts the invoice's Shipping & handling line; a
 * failed or unratable quote falls back to the flat HQ charge (a bad address
 * cannot be fixed mid-renewal, so it is a fallback too, never an error).
 */
import { getSettings, productFulfillment, shippingRules } from "./catalog";
import { rateShipment, resolvePassThrough, selectMethod, type ShipmentQuote } from "../shipping/rating";
import { selectMany, selectOne, type BillingSubscriptionRow } from "./store";
import type { ShippingAddress } from "./types";

const enc = encodeURIComponent;

export interface RenewalShippingQuote {
  quote: ShipmentQuote;
  /** THINNR's product share (fee minus shipping recovery), unchanged by the re-quote. */
  share_cents: number;
  /** share + carrier cost + pick-and-pack + packaging: the platform fee for this renewal. */
  application_fee_cents: number;
  product_id: string;
  unit_price_cents: number;
  quantity: number;
}

/**
 * THINNR's product share of a subscription's fee. The initial order's items
 * carry it exactly for every subscription generation; rows without one (very
 * old links) were built as fee = share + flat charge.
 */
export async function subscriptionThinnrShare(subscription: BillingSubscriptionRow): Promise<number> {
  const initial = await selectMany("billing_orders",
    `subscription_id=eq.${enc(subscription.id)}&kind=in.(subscription_initial,one_time)&order=created_at.asc&limit=1&select=id`);
  const orderId = initial[0]?.id;
  if (orderId) {
    const items = await selectMany("billing_order_items", `order_id=eq.${enc(orderId)}&select=thinnr_share_cents`);
    if (items.length > 0) return items.reduce((sum, item) => sum + item.thinnr_share_cents, 0);
  }
  return subscription.application_fee_cents - subscription.shipping_charge_cents;
}

/**
 * Rates the subscription's next shipment. `pending` = the invoice already bills
 * the pending plan change, so the renewal ships the pending product at the
 * pending price (its share was built on the flat charge, like all changes).
 */
export async function quoteRenewalShipping(subscription: BillingSubscriptionRow, pending: boolean): Promise<RenewalShippingQuote | null> {
  const productId = pending ? subscription.pending_product_id ?? subscription.product_id : subscription.product_id;
  const unitPrice = pending ? subscription.pending_unit_price_cents ?? subscription.unit_price_cents : subscription.unit_price_cents;
  const quantity = Math.max(1, subscription.quantity ?? 1);
  const [product, settings, officeSettings] = await Promise.all([
    selectOne("billing_products", `id=eq.${enc(productId)}`),
    getSettings(),
    selectOne("billing_office_settings", `provider_id=eq.${enc(subscription.provider_id)}`),
  ]);
  if (!product) return null;
  const rules = shippingRules(settings);
  const fulfillment = productFulfillment(product);
  const share = pending
    ? (subscription.pending_application_fee_cents ?? subscription.application_fee_cents) - (subscription.pending_shipping_charge_cents ?? subscription.shipping_charge_cents)
    : await subscriptionThinnrShare(subscription);
  const options = await rateShipment({
    lines: [{
      product_id: product.id, name: product.name, sku: fulfillment.warehousecraft_sku, quantity,
      weight_oz: fulfillment.shipping_weight_oz, oversized: fulfillment.oversized, unit_price_cents: unitPrice,
    }],
    subtotal_cents: unitPrice * quantity, settings: rules,
    pass_through: resolvePassThrough(rules, officeSettings?.pick_pack_pass_through),
    address: (subscription.shipping_address as unknown as ShippingAddress | null) ?? null,
  }).catch(() => null);
  const quote = options
    ? selectMethod(options, subscription.shipping_method ?? "standard")
    // Unratable address: the flat charge, exactly what an address-less quote gets.
    : selectMethod(await rateShipment({
      lines: [], subtotal_cents: unitPrice * quantity, settings: rules,
      pass_through: resolvePassThrough(rules, officeSettings?.pick_pack_pass_through), address: null,
    }), subscription.shipping_method ?? "standard");
  return {
    quote, share_cents: Math.max(0, share), application_fee_cents: Math.max(0, share) + quote.thinnr_shipping_cost_cents,
    product_id: product.id, unit_price_cents: unitPrice, quantity,
  };
}

/** The Shipping & handling line of a renewal invoice: the line that is not the plan's own price. */
export function invoiceShippingLineAmount(invoice: any, planPriceIds: Array<string | null | undefined>): number | null {
  const plans = new Set(planPriceIds.filter((id): id is string => typeof id === "string" && id.length > 0));
  const lines: any[] = Array.isArray(invoice?.lines?.data) ? invoice.lines.data : [];
  const shipping = lines.find((line) => {
    const value = line.price ?? line.pricing?.price_details?.price;
    const id = typeof value === "string" ? value : value?.id;
    return line.type !== "invoiceitem" && (!id || !plans.has(id));
  });
  return shipping && Number.isInteger(Number(shipping.amount)) ? Number(shipping.amount) : null;
}
