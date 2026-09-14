import { logger } from "../lib/logger";
import { breakEvenMinimum, belowMinimum } from "./fees";
import { getSettings } from "./catalog";
import { connectedOpts, getStripe } from "./stripe-client";
import { remove, selectMany, selectOne, update, upsert } from "./store";
import type { OfficePrice, OfficePricesResponse } from "./types";

export class BillingPriceError extends Error {
  constructor(message: string, readonly status = 400, readonly field?: string) { super(message); }
}
export async function listOfficePrices(providerId: string): Promise<OfficePricesResponse> {
  const [products, rows, settings] = await Promise.all([
    selectMany("billing_products", "order=sort_order.asc,name.asc"),
    selectMany("billing_office_prices", `provider_id=eq.${encodeURIComponent(providerId)}`),
    getSettings(),
  ]);
  const prices = new Map(rows.map((row) => [row.product_id, row]));
  const visible = products.filter((product) => product.active || prices.has(product.id));
  return {
    products: visible.map((product): OfficePrice => {
      const price = prices.get(product.id);
      return {
        product_id: product.id, slug: product.slug, name: product.name, active: product.active,
        floor_price_cents: product.floor_price_cents,
        break_even_minimum_cents: breakEvenMinimum(product.floor_price_cents, settings),
        sell_price_cents: price?.sell_price_cents ?? null,
        subscription_enabled: price?.subscription_enabled ?? false, offered: Boolean(price),
        below_minimum: belowMinimum(price?.sell_price_cents ?? null, product.floor_price_cents, settings),
      };
    }),
    settings: {
      shipping_charge_cents: settings.shipping_charge_cents,
      card_fee_bps: settings.card_fee_bps, card_fee_fixed_cents: settings.card_fee_fixed_cents,
    },
  };
}

export async function ensureRecurringPrices(providerId: string, productId: string) {
  const [price, product, account, settings] = await Promise.all([
    selectOne("billing_office_prices", `provider_id=eq.${encodeURIComponent(providerId)}&product_id=eq.${encodeURIComponent(productId)}`),
    selectOne("billing_products", `id=eq.${encodeURIComponent(productId)}`),
    selectOne("billing_connected_accounts", `provider_id=eq.${encodeURIComponent(providerId)}&disconnected_at=is.null`),
    getSettings(),
  ]);
  if (!price || !product || !account) throw new BillingPriceError("The recurring price cannot be created.", 409);
  const stripe = await getStripe();
  let stripeProductId = price.stripe_product_id;
  if (!stripeProductId) {
    const stripeProduct = await stripe.products.create(
      { name: product.name, metadata: { thinnr_product_id: product.id } },
      connectedOpts(account.stripe_account_id, `product:${providerId}:${productId}`),
    );
    stripeProductId = stripeProduct.id;
  }
  let recurringId = price.stripe_price_id;
  let replaceRecurring = true;
  if (recurringId) {
    try {
      const current = await stripe.prices.retrieve(recurringId, {}, connectedOpts(account.stripe_account_id));
      replaceRecurring = !current.active || current.unit_amount !== price.sell_price_cents;
    } catch {
      replaceRecurring = true;
    }
  }
  if (replaceRecurring) {
    const oldId = recurringId;
    const recurring = await stripe.prices.create({
      product: stripeProductId, currency: "usd", unit_amount: price.sell_price_cents,
      recurring: { interval: "week", interval_count: 4 },
    }, connectedOpts(account.stripe_account_id,
      `price:${providerId}:${productId}:${price.sell_price_cents}:${oldId ?? "initial"}`));
    recurringId = recurring.id;
    if (oldId && oldId !== recurring.id) {
      await stripe.prices.update(oldId, { active: false }, connectedOpts(account.stripe_account_id));
    }
  }
  let shippingId = price.stripe_shipping_price_id;
  let replaceShipping = true;
  if (shippingId) {
    try {
      const current = await stripe.prices.retrieve(shippingId, {}, connectedOpts(account.stripe_account_id));
      replaceShipping = !current.active || current.unit_amount !== settings.shipping_charge_cents;
    } catch {
      replaceShipping = true;
    }
  }
  if (replaceShipping) {
    const oldShippingId = shippingId;
    const shippingProduct = await stripe.products.create(
      { name: "Shipping", metadata: { thinnr_shipping: "true" } },
      connectedOpts(account.stripe_account_id, `shipping-product:${providerId}:${oldShippingId ?? "initial"}`),
    );
    const shipping = await stripe.prices.create({
      product: shippingProduct.id, currency: "usd", unit_amount: settings.shipping_charge_cents,
      recurring: { interval: "week", interval_count: 4 },
    }, connectedOpts(account.stripe_account_id,
      `shipping-price:${providerId}:${settings.shipping_charge_cents}:${oldShippingId ?? "initial"}`));
    shippingId = shipping.id;
    if (oldShippingId && oldShippingId !== shipping.id) {
      await stripe.prices.update(oldShippingId, { active: false }, connectedOpts(account.stripe_account_id));
    }
  }
  return update("billing_office_prices",
    `provider_id=eq.${encodeURIComponent(providerId)}&product_id=eq.${encodeURIComponent(productId)}`,
    { stripe_product_id: stripeProductId, stripe_price_id: recurringId, stripe_shipping_price_id: shippingId });
}

export async function setOfficePrice(
  providerId: string, productId: string,
  input: { sell_price_cents: number | null; subscription_enabled: boolean }, actor: string,
): Promise<{ product: OfficePrice; stripe_mirror?: "failed" }> {
  const [product, settings] = await Promise.all([
    selectOne("billing_products", `id=eq.${encodeURIComponent(productId)}`), getSettings(),
  ]);
  if (!product) throw new BillingPriceError("Product not found.", 404);
  if (input.sell_price_cents === null) {
    await remove("billing_office_prices", `provider_id=eq.${encodeURIComponent(providerId)}&product_id=eq.${encodeURIComponent(productId)}`);
  } else {
    const minimum = breakEvenMinimum(product.floor_price_cents, settings);
    if (input.sell_price_cents < minimum) {
      throw new BillingPriceError(`Price must be at least ${minimum} cents to cover processing costs.`, 400, "sell_price_cents");
    }
    await upsert("billing_office_prices", {
      provider_id: providerId, product_id: productId, sell_price_cents: input.sell_price_cents,
      subscription_enabled: input.subscription_enabled, updated_by: actor,
    }, "provider_id,product_id");
  }
  let stripe_mirror: "failed" | undefined;
  if (input.sell_price_cents !== null && input.subscription_enabled) {
    try { await ensureRecurringPrices(providerId, productId); }
    catch (error) {
      stripe_mirror = "failed";
      logger.error({ err: error, providerId, productId }, "billing recurring price mirror failed");
    }
  }
  const listed = await listOfficePrices(providerId);
  const mapped = listed.products.find((candidate) => candidate.product_id === productId);
  if (!mapped) throw new BillingPriceError("Product not found.", 404);
  return { product: mapped, ...(stripe_mirror ? { stripe_mirror } : {}) };
}