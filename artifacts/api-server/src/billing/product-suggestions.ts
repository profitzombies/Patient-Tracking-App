import { z } from "zod";
import { officeOffering } from "./catalog";
import type { PublicLinkProduct } from "./types";

export const productSuggestionInputSchema = z.object({
  mode: z.enum(["individual", "bundle"]),
  items: z.array(z.object({
    productId: z.string().min(1).max(120),
    purchase: z.enum(["one_time", "subscription"]),
    cadenceWeeks: z.number().nullable().optional(),
    quantity: z.number().int().min(1).max(20),
  }).strict()).min(1).max(8),
}).strict();

export type ProductSuggestionInput = z.infer<typeof productSuggestionInputSchema>;

export interface ProductSuggestion {
  mode: "individual" | "bundle";
  items: Array<{
    productId: string;
    slug: string;
    name: string;
    imageUrl: string | null;
    purchase: "one_time" | "subscription";
    cadenceWeeks: number | null;
    quantity: number;
    unitPriceCents: number;
  }>;
  totalCents: number;
}

export class ProductSuggestionError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
  }
}

export async function buildProductSuggestion(
  providerId: string,
  input: ProductSuggestionInput,
  loadOffering: (providerId: string) => Promise<PublicLinkProduct[]> = officeOffering,
): Promise<ProductSuggestion> {
  const offering = await loadOffering(providerId);
  const products = new Map(offering.map(product => [product.product_id, product]));
  const pairs = new Set<string>();

  const items = input.items.map((requested, index) => {
    const product = products.get(requested.productId);
    if (!product) {
      throw new ProductSuggestionError("That product isn't on your office's price list.", `suggestion.items.${index}.productId`);
    }
    const pair = `${requested.productId}:${requested.purchase}`;
    if (pairs.has(pair)) {
      throw new ProductSuggestionError("The same product and purchase option can only be suggested once.", `suggestion.items.${index}`);
    }
    pairs.add(pair);

    let cadenceWeeks: number | null = null;
    let unitPriceCents = product.unit_price_cents;
    if (requested.purchase === "subscription") {
      if (!product.subscription_available || product.subscription_unit_price_cents === null) {
        throw new ProductSuggestionError("That product isn't available as a subscription.", `suggestion.items.${index}.purchase`);
      }
      cadenceWeeks = requested.cadenceWeeks ?? product.default_cadence_weeks;
      if (!product.subscription_cadences_weeks.includes(cadenceWeeks as never)) {
        throw new ProductSuggestionError("Choose a subscription cadence offered for that product.", `suggestion.items.${index}.cadenceWeeks`);
      }
      unitPriceCents = product.subscription_unit_price_cents;
    }

    return {
      productId: product.product_id,
      slug: product.slug,
      name: product.name,
      imageUrl: product.image_url,
      purchase: requested.purchase,
      cadenceWeeks,
      quantity: requested.quantity,
      unitPriceCents,
    };
  });

  return {
    mode: input.mode,
    items,
    totalCents: items.reduce((total, item) => total + item.unitPriceCents * item.quantity, 0),
  };
}

/**
 * Lock-screen copy for a suggestion. It never names a product or says how
 * many: the push rides Expo's servers (no BAA) and a product name sits next
 * to a person's care. The card inside the chat carries the detail.
 */
export const SUGGESTION_PUSH_BODY = "Your care team suggested something for you. Open the app to see it.";
export function suggestionPushBody(_suggestion: ProductSuggestion): string {
  return SUGGESTION_PUSH_BODY;
}

export function suggestionFromCard(card: unknown): ProductSuggestion | null {
  if (!card || typeof card !== "object" || Array.isArray(card)) return null;
  const row = card as Record<string, unknown>;
  if (row.kind !== "product_suggestion" || !row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) {
    return null;
  }
  return row.payload as ProductSuggestion;
}