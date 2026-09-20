import { logger } from "../lib/logger";
import { breakEvenMinimum, belowMinimum } from "./fees";
import {
  getSettings, loadDefaultImages, pageContent, productCadences, productImageUrl, recordCatalogChange,
  subscribeSavePercent, subscriptionUnitPrice,
} from "./catalog";
import { connectedOpts, getStripe, isStripeMissing } from "./stripe-client";
import { remove, selectMany, selectOne, update, upsert, type CadencePriceMirror } from "./store";
import type { OfficePrice, OfficePricesResponse } from "./types";

export class BillingPriceError extends Error {
  constructor(message: string, readonly status = 400, readonly field?: string) { super(message); }
}
export async function listOfficePrices(providerId: string): Promise<OfficePricesResponse> {
  const [products, rows, settings, images] = await Promise.all([
    selectMany("billing_products", "order=sort_order.asc,name.asc"),
    selectMany("billing_office_prices", `provider_id=eq.${encodeURIComponent(providerId)}`),
    getSettings(), loadDefaultImages(),
  ]);
  const prices = new Map(rows.map((row) => [row.product_id, row]));
  const percent = subscribeSavePercent(settings);
  // Offices see active products plus anything they already price, except
  // archived products, which leave every office surface.
  const visible = products.filter((product) => product.status !== "archived" && (product.active || prices.has(product.id)));
  return {
    products: visible.map((product): OfficePrice => {
      const price = prices.get(product.id);
      const image = images.get(product.id);
      const page = pageContent(product);
      const subscribable = Boolean(price?.subscription_enabled);
      return {
        product_id: product.id, slug: product.slug, name: product.name, description: product.description ?? "",
        category: page.category, tagline: page.tagline, ...productCadences(product),
        image_url: image ? productImageUrl(image.id) : null, active: product.active,
        floor_price_cents: product.floor_price_cents,
        break_even_minimum_cents: breakEvenMinimum(product.floor_price_cents, settings),
        sell_price_cents: price?.sell_price_cents ?? null,
        subscription_enabled: subscribable, offered: Boolean(price),
        below_minimum: belowMinimum(price?.sell_price_cents ?? null, product.floor_price_cents, settings),
        subscribe_save_percent: subscribable ? percent : 0,
        subscription_price_cents: price && subscribable ? subscriptionUnitPrice(price.sell_price_cents, percent) : null,
      };
    }),
    settings: {
      shipping_charge_cents: settings.shipping_charge_cents,
      card_fee_bps: settings.card_fee_bps, card_fee_fixed_cents: settings.card_fee_fixed_cents,
      subscribe_save_enabled: settings.subscribe_save_enabled, subscribe_save_percent: settings.subscribe_save_percent,
    },
  };
}

type StripeClient = Awaited<ReturnType<typeof getStripe>>;
type RecurringTarget = { product: string; unit_amount: number; weeks: number };
/**
 * A recurring price on the connected account that still matches its target
 * exactly (active, same amount, same weekly interval). Missing resources
 * read as "not usable"; any other Stripe failure propagates.
 */
async function usableRecurring(stripe: StripeClient, acct: string, priceId: string | null | undefined, target: RecurringTarget): Promise<boolean> {
  if (!priceId) return false;
  try {
    const current = await stripe.prices.retrieve(priceId, {}, connectedOpts(acct));
    return current.active && current.unit_amount === target.unit_amount
      && current.recurring?.interval === "week" && current.recurring?.interval_count === target.weeks;
  } catch (error) {
    if (!isStripeMissing(error)) throw error;
    return false;
  }
}

/**
 * Mirrors one recurring Stripe price per offered cadence (plus the matching
 * shipping price, since every item on a Stripe subscription must share an
 * interval). Idempotency keys are versioned by cadence, amount, and the id
 * they replace, so a changed price never replays a stale key; prices that
 * still match are reused untouched. The legacy 4-week ids are recognized as
 * the 4-week cadence whenever their amounts still match. Cadences HQ stops
 * offering keep their entries (still valid for renewals) but are not
 * refreshed.
 */
async function ensureCadencePrices(input: {
  stripe: StripeClient; acct: string; providerId: string; productId: string;
  stripeProductId: string; shippingProductId: string; legacyPriceId: string | null; legacyShippingPriceId: string | null;
  sellPriceCents: number; shippingChargeCents: number; percent: number; cadences: number[];
  previous: Record<string, CadencePriceMirror>;
}): Promise<Record<string, CadencePriceMirror>> {
  const { stripe, acct, providerId, productId } = input;
  const unit = subscriptionUnitPrice(input.sellPriceCents, input.percent);
  const next: Record<string, CadencePriceMirror> = { ...input.previous };
  for (const weeks of input.cadences) {
    const key = String(weeks);
    const current = input.previous[key];
    const priceTarget: RecurringTarget = { product: input.stripeProductId, unit_amount: unit, weeks };
    const shippingTarget: RecurringTarget = { product: input.shippingProductId, unit_amount: input.shippingChargeCents, weeks };
    let priceId: string | null = null;
    let priceOnAccount: string | null = null;
    // Reuse order: this cadence's own mirror, then the legacy 4-week price.
    for (const candidate of [current?.price_id, weeks === 4 && unit === input.sellPriceCents ? input.legacyPriceId : null]) {
      if (!candidate || priceId) continue;
      if (await usableRecurring(stripe, acct, candidate, priceTarget)) priceId = candidate;
      else if (candidate === current?.price_id) priceOnAccount = candidate;
    }
    if (!priceId) {
      const created = await stripe.prices.create({
        product: input.stripeProductId, currency: "usd", unit_amount: unit,
        recurring: { interval: "week", interval_count: weeks },
        metadata: { thinnr_cadence_weeks: key, thinnr_subscribe_save_percent: String(input.percent) },
      }, connectedOpts(acct, `price:${providerId}:${productId}:${weeks}w:${unit}:${priceOnAccount ?? "initial"}:${acct}`));
      priceId = created.id;
      if (priceOnAccount && priceOnAccount !== created.id && priceOnAccount !== input.legacyPriceId) {
        try { await stripe.prices.update(priceOnAccount, { active: false }, connectedOpts(acct)); }
        catch (error) { if (!isStripeMissing(error)) throw error; }
      }
    }
    let shippingId: string | null = null;
    let shippingOnAccount: string | null = null;
    for (const candidate of [current?.shipping_price_id, weeks === 4 ? input.legacyShippingPriceId : null]) {
      if (!candidate || shippingId) continue;
      if (await usableRecurring(stripe, acct, candidate, shippingTarget)) shippingId = candidate;
      else if (candidate === current?.shipping_price_id) shippingOnAccount = candidate;
    }
    if (!shippingId) {
      const created = await stripe.prices.create({
        product: input.shippingProductId, currency: "usd", unit_amount: input.shippingChargeCents,
        recurring: { interval: "week", interval_count: weeks },
        metadata: { thinnr_cadence_weeks: key },
      }, connectedOpts(acct, `shipping-price:${providerId}:${weeks}w:${input.shippingChargeCents}:${shippingOnAccount ?? "initial"}:${acct}`));
      shippingId = created.id;
      if (shippingOnAccount && shippingOnAccount !== created.id && shippingOnAccount !== input.legacyShippingPriceId) {
        try { await stripe.prices.update(shippingOnAccount, { active: false }, connectedOpts(acct)); }
        catch (error) { if (!isStripeMissing(error)) throw error; }
      }
    }
    next[key] = { price_id: priceId, unit_amount_cents: unit, shipping_price_id: shippingId };
  }
  return next;
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
  const acct = account.stripe_account_id;
  // Mirrored ids are only meaningful on the account they were created on. An
  // office that disconnects and reconnects a different Stripe account must
  // get fresh objects, and the stale ones must not be touched.
  let stripeProductId = price.stripe_product_id;
  let productFresh = false;
  if (stripeProductId) {
    try { await stripe.products.retrieve(stripeProductId, {}, connectedOpts(acct)); }
    catch (error) { if (!isStripeMissing(error)) throw error; stripeProductId = null; }
  }
  if (!stripeProductId) {
    const stripeProduct = await stripe.products.create(
      { name: product.name, metadata: { thinnr_product_id: product.id } },
      connectedOpts(acct, `product:${providerId}:${productId}:${acct}`),
    );
    stripeProductId = stripeProduct.id;
    productFresh = true;
  }
  let recurringId = price.stripe_price_id;
  let recurringOnAccount = false;
  let replaceRecurring = true;
  if (recurringId && !productFresh) {
    try {
      const current = await stripe.prices.retrieve(recurringId, {}, connectedOpts(acct));
      recurringOnAccount = true;
      replaceRecurring = !current.active || current.unit_amount !== price.sell_price_cents;
    } catch (error) {
      if (!isStripeMissing(error)) throw error;
      replaceRecurring = true;
    }
  }
  if (replaceRecurring) {
    const oldId = recurringOnAccount ? recurringId : null;
    const recurring = await stripe.prices.create({
      product: stripeProductId, currency: "usd", unit_amount: price.sell_price_cents,
      recurring: { interval: "week", interval_count: 4 },
    }, connectedOpts(acct, `price:${providerId}:${productId}:${price.sell_price_cents}:${oldId ?? "initial"}:${acct}`));
    recurringId = recurring.id;
    if (oldId && oldId !== recurring.id) {
      await stripe.prices.update(oldId, { active: false }, connectedOpts(acct));
    }
  }
  let shippingId = price.stripe_shipping_price_id;
  let shippingOnAccount = false;
  let replaceShipping = true;
  let shippingProductId: string | null = null;
  if (shippingId) {
    try {
      const current = await stripe.prices.retrieve(shippingId, {}, connectedOpts(acct));
      shippingOnAccount = true;
      shippingProductId = typeof current.product === "string" ? current.product : current.product?.id ?? null;
      replaceShipping = !current.active || current.unit_amount !== settings.shipping_charge_cents;
    } catch (error) {
      if (!isStripeMissing(error)) throw error;
      replaceShipping = true;
    }
  }
  if (replaceShipping) {
    const oldShippingId = shippingOnAccount ? shippingId : null;
    const shippingProduct = await stripe.products.create(
      { name: "Shipping", metadata: { thinnr_shipping: "true" } },
      connectedOpts(acct, `shipping-product:${providerId}:${oldShippingId ?? "initial"}:${acct}`),
    );
    const shipping = await stripe.prices.create({
      product: shippingProduct.id, currency: "usd", unit_amount: settings.shipping_charge_cents,
      recurring: { interval: "week", interval_count: 4 },
    }, connectedOpts(acct, `shipping-price:${providerId}:${settings.shipping_charge_cents}:${oldShippingId ?? "initial"}:${acct}`));
    shippingId = shipping.id;
    shippingProductId = shippingProduct.id;
    if (oldShippingId && oldShippingId !== shipping.id) {
      await stripe.prices.update(oldShippingId, { active: false }, connectedOpts(acct));
    }
  }
  const cadencePrices = await ensureCadencePrices({
    stripe, acct, providerId, productId, stripeProductId, shippingProductId: shippingProductId ?? "",
    legacyPriceId: recurringId, legacyShippingPriceId: shippingId,
    sellPriceCents: price.sell_price_cents, shippingChargeCents: settings.shipping_charge_cents,
    percent: subscribeSavePercent(settings), cadences: productCadences(product).offered_cadences_weeks,
    previous: price.stripe_cadence_prices ?? {},
  });
  return update("billing_office_prices",
    `provider_id=eq.${encodeURIComponent(providerId)}&product_id=eq.${encodeURIComponent(productId)}`,
    { stripe_product_id: stripeProductId, stripe_price_id: recurringId, stripe_shipping_price_id: shippingId, stripe_cadence_prices: cadencePrices });
}

export async function setOfficePrice(
  providerId: string, productId: string,
  input: { sell_price_cents: number | null; subscription_enabled: boolean }, actor: string,
): Promise<{ product: OfficePrice; stripe_mirror?: "failed" }> {
  const [product, settings] = await Promise.all([
    selectOne("billing_products", `id=eq.${encodeURIComponent(productId)}`), getSettings(),
  ]);
  if (!product) throw new BillingPriceError("Product not found.", 404);
  const previous = await selectOne("billing_office_prices", `provider_id=eq.${encodeURIComponent(providerId)}&product_id=eq.${encodeURIComponent(productId)}`);
  const priceSnapshot = (row: { sell_price_cents: number; subscription_enabled: boolean } | null) =>
    row ? { sell_price_cents: row.sell_price_cents, subscription_enabled: row.subscription_enabled } : null;
  if (input.sell_price_cents === null) {
    if (previous?.enabled === false) {
      throw new BillingPriceError("This product is disabled. Enable it in practice setup before removing its own price.", 409);
    }
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
  const next = input.sell_price_cents === null ? null : { sell_price_cents: input.sell_price_cents, subscription_enabled: input.subscription_enabled };
  if (JSON.stringify(priceSnapshot(previous)) !== JSON.stringify(next)) {
    await recordCatalogChange({
      productId, kind: "office_price_updated", before: priceSnapshot(previous), after: next, actor, providerId,
    });
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