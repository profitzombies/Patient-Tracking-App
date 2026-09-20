import { getSettings, subscribeSavePercent, subscriptionUnitPrice } from "../billing/catalog";
import { breakEvenMinimum, thinnrSharePerUnit } from "../billing/fees";
import { selectMany } from "../billing/store";
import { currentBillingIdentity } from "../billing/stripe-environment";
import { supabaseAdmin } from "../lib/supabase-admin";

export class LaunchProductsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export interface LaunchProductInput {
  productId: string;
  enabled: boolean;
  sellPriceCents: number;
  subscriptionEnabled: boolean;
}
export function suggestedPriceCents(floor: number): number {
  return 2 * thinnrSharePerUnit(floor);
}
export async function getLaunchProducts(providerId: string) {
  const [products, prices, settings] = await Promise.all([
    selectMany("billing_products", "active=eq.true&order=sort_order.asc,name.asc"),
    selectMany("billing_office_prices", `provider_id=eq.${encodeURIComponent(providerId)}`),
    getSettings(),
  ]);
  const priceMap = new Map(prices.map(price => [price.product_id, price]));
  const discount = subscribeSavePercent(settings);
  return products.map(product => {
    const existing = priceMap.get(product.id);
    const suggested = suggestedPriceCents(product.floor_price_cents);
    const price = existing?.sell_price_cents ?? suggested;
    const minimum = breakEvenMinimum(product.floor_price_cents, settings);
    const subscriptionEligible = subscriptionUnitPrice(price, discount) >= minimum;
    return {
      productId: product.id, name: product.name,
      enabled: existing ? existing.enabled !== false : price >= minimum,
      sellPriceCents: price, suggestedPriceCents: suggested, minimumPriceCents: minimum,
      subscriptionEnabled: existing?.subscription_enabled ?? subscriptionEligible,
      subscriptionEligible, existingPrice: Boolean(existing), available: product.active,
    };
  });
}

/** One database transaction revalidates catalog/minimums and writes all choices + checklist. */
export async function saveLaunchProducts(
  providerId: string, actorUserId: string, expectedVersion: number, products: LaunchProductInput[],
) {
  const identity = currentBillingIdentity();
  if (!identity) throw new LaunchProductsError("Billing identity is required.", 503);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || !Array.isArray(products)
    || products.some(p => !p || typeof p.productId !== "string" || typeof p.enabled !== "boolean"
      || typeof p.subscriptionEnabled !== "boolean" || !Number.isSafeInteger(p.sellPriceCents)
      || p.sellPriceCents < 0 || p.sellPriceCents > 2147483647)) {
    throw new LaunchProductsError("Check the product choices and prices.");
  }
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/save_practice_launch_products", {
    p_provider_id: providerId, p_actor_user_id: actorUserId, p_expected_version: expectedVersion,
    p_products: [...products].sort((a, b) => a.productId.localeCompare(b.productId)),
    p_stripe_mode: identity.mode, p_platform_account_id: identity.platformAccountId,
  });
  if (result.status >= 300) {
    const code = result.json?.code;
    throw new LaunchProductsError(
      typeof result.json?.message === "string" ? result.json.message : "Product choices could not be saved.",
      code === "40001" ? 409 : code === "22023" || code === "23514" ? 400 : 503,
    );
  }
  return result.json;
}