import { describe, expect, it } from "vitest";
import type { PublicLinkProduct } from "./types";
import {
  buildProductSuggestion,
  productSuggestionInputSchema,
  suggestionFromCard,
  suggestionPushBody,
} from "./product-suggestions";

function product(overrides: Partial<PublicLinkProduct> = {}): PublicLinkProduct {
  return {
    product_id: "product-a",
    slug: "daily-balance",
    name: "Daily Balance",
    description: "",
    image_url: "/api/billing/public/product-images/image-a",
    image_urls: [],
    unit_price_cents: 2500,
    office_priced: true,
    subscription_available: true,
    subscription_cadences_weeks: [2, 4],
    default_cadence_weeks: 4,
    subscribe_save_percent: 10,
    subscription_unit_price_cents: 2250,
    category: "supplement",
    tagline: "",
    format: "",
    benefits: [],
    how_to_take: "",
    facts_title: "",
    facts: [],
    faqs: [],
    disclaimer: "",
    ...overrides,
  };
}

const load = (products: PublicLinkProduct[]) => async () => products;

describe("product suggestion snapshots", () => {
  it("builds one-time and subscription snapshots entirely from the current office offering", async () => {
    const suggestion = await buildProductSuggestion("office-a", {
      mode: "bundle",
      items: [
        { productId: "product-a", purchase: "one_time", cadenceWeeks: 12, quantity: 2 },
        { productId: "product-a", purchase: "subscription", cadenceWeeks: null, quantity: 1 },
      ],
    }, load([product()]));

    expect(suggestion).toEqual({
      mode: "bundle",
      items: [
        {
          productId: "product-a", slug: "daily-balance", name: "Daily Balance",
          imageUrl: "/api/billing/public/product-images/image-a", purchase: "one_time",
          cadenceWeeks: null, quantity: 2, unitPriceCents: 2500,
        },
        {
          productId: "product-a", slug: "daily-balance", name: "Daily Balance",
          imageUrl: "/api/billing/public/product-images/image-a", purchase: "subscription",
          cadenceWeeks: 4, quantity: 1, unitPriceCents: 2250,
        },
      ],
      totalCents: 7250,
    });
  });

  const invalidCases: Array<[
    string,
    Array<{ productId: string; purchase: "one_time" | "subscription"; cadenceWeeks?: number; quantity: number }>,
    string,
    Partial<PublicLinkProduct>?,
  ]> = [
    ["missing product", [{ productId: "missing", purchase: "one_time" as const, quantity: 1 }],
      "That product isn't on your office's price list."],
    ["unavailable subscription", [{ productId: "product-a", purchase: "subscription" as const, quantity: 1 }],
      "That product isn't available as a subscription.", { subscription_available: false, subscription_unit_price_cents: null }],
    ["bad cadence", [{ productId: "product-a", purchase: "subscription" as const, cadenceWeeks: 12, quantity: 1 }],
      "Choose a subscription cadence offered for that product."],
    ["duplicate pair", [
      { productId: "product-a", purchase: "one_time" as const, quantity: 1 },
      { productId: "product-a", purchase: "one_time" as const, quantity: 2 },
    ], "The same product and purchase option can only be suggested once."],
  ];

  it.each(invalidCases)("rejects %s with a clear error", async (_name, items, message, overrides = {}) => {
    await expect(buildProductSuggestion("office-a", {
      mode: "individual",
      items,
    }, load([product(overrides)]))).rejects.toThrow(message);
  });

  it("strictly validates quantity and unknown input fields", () => {
    for (const quantity of [0, 21, 1.5]) {
      expect(productSuggestionInputSchema.safeParse({
        mode: "individual",
        items: [{ productId: "product-a", purchase: "one_time", quantity }],
      }).success).toBe(false);
    }
    expect(productSuggestionInputSchema.safeParse({
      mode: "individual",
      items: [{ productId: "product-a", purchase: "one_time", quantity: 1, name: "Untrusted" }],
    }).success).toBe(false);
  });

  it("creates suggestion-only push copy and never exposes another card kind", async () => {
    const suggestion = await buildProductSuggestion("office-a", {
      mode: "individual", items: [{ productId: "product-a", purchase: "one_time", quantity: 1 }],
    }, load([product()]));
    // The push rides a vendor without a BAA: the product name and count stay inside the chat card.
    expect(suggestionPushBody(suggestion)).toBe("Your care team suggested something for you. Open the app to see it.");
    expect(suggestionPushBody(suggestion)).not.toContain("Daily Balance");
    expect(suggestionPushBody({ ...suggestion, mode: "bundle" })).toBe(suggestionPushBody(suggestion));
    expect(suggestionPushBody({ ...suggestion, items: [...suggestion.items, suggestion.items[0]] })).toBe(suggestionPushBody(suggestion));
    expect(suggestionPushBody({
      ...suggestion,
      items: [{ ...suggestion.items[0], name: "A".repeat(200) }],
    }).length).toBeLessThanOrEqual(140);
    expect(suggestionFromCard({ kind: "product_suggestion", payload: suggestion })).toEqual(suggestion);
    expect(suggestionFromCard({ kind: "ai_coach_card", payload: { private: true } })).toBeNull();
  });
});