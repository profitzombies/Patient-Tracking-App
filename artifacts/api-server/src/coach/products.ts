import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./repo-paths";

/**
 * Curated THINNR product catalog for coach suggestions.
 *
 * The catalog JSON lives in the mobile app (single source of truth for both
 * surfaces) and is read from the repo at runtime, mirroring how the docs
 * archive is loaded. Every field shown to the model or the patient comes from
 * this file — model output never contributes product facts.
 *
 * Suggestion gating happens in two layers:
 *  1. `matchProducts` — a product is only *offered* to the model when the
 *     latest patient message contains one of its intent topics. No match, no
 *     product instructions in the prompt at all.
 *  2. The route accepts a marker only for an offered product id, and keeps at
 *     most one card per reply.
 */

export interface CatalogFactRow {
  name: string;
  detail?: string;
}

export interface CatalogProduct {
  id: string;
  slug: string;
  name: string;
  category: string;
  tagline: string;
  cardLine: string;
  description: string;
  format: string;
  price: number;
  factsTitle: string;
  facts: CatalogFactRow[];
  benefits: string[];
  suggestedUse?: string;
  disclaimer: string;
  sourceUrl: string;
  sourceNote: string;
  topics: string[];
  /**
   * Bundled mirror of the HQ suggestion rule (billing_products.coach_suggestion)
   * so the demo persona and offline readers see the same defaults; the live
   * pipeline reads the HQ-edited rule, never this copy.
   */
  suggestion?: {
    signals: string[];
    avoid_signals: string[];
    phrasing: string;
    bloodwork_covered: boolean;
  };
}

const catalogPath = path.join(
  repoRoot,
  "artifacts",
  "thinnr-mobile",
  "data",
  "product-catalog.json",
);

let cachedCatalog: CatalogProduct[] | null = null;

export function loadProductCatalog(): CatalogProduct[] {
  if (!cachedCatalog) {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as {
      products?: CatalogProduct[];
    };
    if (!parsed.products || parsed.products.length === 0) {
      throw new Error("Product catalog contained no products");
    }
    cachedCatalog = parsed.products;
  }
  return cachedCatalog;
}

/**
 * Case/punctuation-insensitive phrase matching: both sides are lowercased and
 * non-alphanumerics collapse to single spaces, so "GLP-1" matches "glp 1" and
 * "Creatine+" matches "creatine". Padding spaces keep matches on word
 * boundaries ("fiber" does not match "fiberglass").
 */
function normalizeForMatch(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/**
 * The subset of a product the coach pipeline needs to offer it: the marker
 * id, storefront slug, quoted copy for the prompt, and conversation topics.
 * Bundled demo products satisfy it directly; real accounts build it from the
 * office's live offering (HQ-edited name, copy, image) plus the HQ rule.
 */
export interface OfferProduct {
  /** Marker id the model echoes back: bundled id (demo) or storefront product id (live). */
  id: string;
  slug: string;
  name: string;
  category: string;
  tagline: string;
  cardLine: string;
  description: string;
  format: string;
  /** Dollars; demo price for bundled products, the office price when live. */
  price: number;
  topics: string[];
  imageUrl?: string | null;
}

/** Products whose intent topics appear in the latest patient message. */
export function matchProducts<T extends { topics: string[] }>(latestUserMessage: string, catalog: T[]): T[];
export function matchProducts(latestUserMessage: string): CatalogProduct[];
export function matchProducts(latestUserMessage: string, catalog: Array<{ topics: string[] }> = loadProductCatalog()): Array<{ topics: string[] }> {
  const haystack = normalizeForMatch(latestUserMessage);
  return catalog.filter((product) =>
    product.topics.some((topic) => {
      const needle = normalizeForMatch(topic);
      return needle.trim().length > 0 && haystack.includes(needle);
    }),
  );
}

export function findProduct(id: string): CatalogProduct | undefined {
  return loadProductCatalog().find((product) => product.id === id);
}

/** Live office pricing carried on a real patient's card; absent for the demo persona. */
export interface ProductCardPricing {
  productId: string;
  priceCents: number;
  available: boolean;
  subscriptionAvailable: boolean;
}

export interface ProductCardPayload {
  id: string;
  slug: string;
  name: string;
  line: string;
  /** Dollars shown on the card: the office price when live, the bundled demo price otherwise. */
  price: number;
  /** Exact office price in cents (live accounts only). */
  priceCents: number | null;
  /** Storefront product id the shop resolves (live accounts only). */
  productId: string | null;
  /** False when the office cannot sell right now: the card still opens the informational product page. */
  available: boolean;
  subscriptionAvailable: boolean;
  /** Storefront image for the card (live accounts); null means the app shows its bundled artwork for the slug, if any. */
  imageUrl: string | null;
  /** Why the coach offered it: a signal id, or "conversation" for a topic match. */
  reason: string;
  cta: string;
}

/**
 * Payload for the SSE `card` event. Built entirely from the catalog and the
 * office's own price list — the model only ever supplies the id. The client
 * re-resolves the slug against the storefront (or its bundled copy of the
 * same catalog for the demo persona) for imagery and the product page.
 */
export function productCardPayload(
  product: OfferProduct,
  pricing: ProductCardPricing | null = null,
  reason: string = "conversation",
): ProductCardPayload {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    line: product.cardLine,
    price: pricing ? pricing.priceCents / 100 : product.price,
    priceCents: pricing ? pricing.priceCents : null,
    productId: pricing ? pricing.productId : null,
    available: pricing ? pricing.available : true,
    subscriptionAvailable: pricing ? pricing.subscriptionAvailable : product.category !== "bundle",
    imageUrl: product.imageUrl ?? null,
    reason,
    cta: "Tap to open",
  };
}

/**
 * Verbatim grounding text for the product-catalog compartment: only the
 * quoted catalog fields (copy, facts, price, disclaimer, source), never the
 * editorial metadata (ids, topics, image keys).
 */
export function productGroundingText(): string {
  const blocks = loadProductCatalog().map((product) => {
    const facts = product.facts
      .map((fact) => (fact.detail ? `${fact.name}: ${fact.detail}` : fact.name))
      .join("\n");
    return [
      `${product.name}: ${product.tagline}`,
      product.format,
      product.description,
      ...product.benefits,
      `${product.factsTitle}:`,
      facts,
      ...(product.suggestedUse ? [`Suggested use: ${product.suggestedUse}`] : []),
      `Price: $${product.price} (demo pricing)`,
      product.disclaimer,
      `(Source: ${product.sourceUrl})`,
    ].join("\n");
  });
  return blocks.join("\n\n");
}

/* ------------------------- live storefront grounding ------------------------ */

/** The office's storefront row fields the coach may quote. */
export interface LiveStorefrontProduct {
  name: string;
  tagline: string;
  format: string;
  description: string;
  benefits: string[];
  how_to_take: string;
  facts_title: string;
  facts: Array<{ name: string; detail: string | null }>;
  disclaimer: string;
  unit_price_cents: number;
  subscription_unit_price_cents: number | null;
}

export const LIVE_PRODUCT_COMPARTMENT_ID = "office-storefront";

/**
 * Verbatim product grounding for a REAL account, built from the office's live
 * offering (HQ copy, office price) instead of the bundled demo catalog. Only
 * products this office actually sells appear; when ordering is closed the copy
 * still grounds answers but no price is quoted. Never mixes in demo pricing.
 */
export function liveStorefrontGroundingText(offering: LiveStorefrontProduct[], available: boolean): string {
  const blocks = offering.map((product) => {
    const facts = product.facts
      .map((fact) => (fact.detail ? `${fact.name}: ${fact.detail}` : fact.name))
      .join("\n");
    const price = available
      ? [
        `Price at this office: $${(product.unit_price_cents / 100).toFixed(2)}`
          + (product.subscription_unit_price_cents !== null
            ? ` (subscribe: $${(product.subscription_unit_price_cents / 100).toFixed(2)} per delivery)`
            : ""),
      ]
      : ["Ordering is not open at this office yet; the patient can ask about it at their next visit."];
    return [
      `${product.name}: ${product.tagline}`,
      product.format,
      product.description,
      ...product.benefits,
      `${product.facts_title}:`,
      facts,
      ...(product.how_to_take ? [`Suggested use: ${product.how_to_take}`] : []),
      ...price,
      product.disclaimer,
    ].filter(Boolean).join("\n");
  });
  return blocks.join("\n\n");
}

/**
 * A compartment carrying the live storefront text. It REPLACES the bundled
 * `product-catalog` compartment for real accounts so the model never sees
 * demo copy or demo prices; an empty offering yields no compartment at all.
 */
export function liveStorefrontCompartment(offering: LiveStorefrontProduct[], available: boolean): {
  id: string;
  title: string;
  keywords: RegExp[];
  load: () => string;
} | null {
  if (offering.length === 0) return null;
  const text = liveStorefrontGroundingText(offering, available);
  return {
    id: LIVE_PRODUCT_COMPARTMENT_ID,
    title: available
      ? "Products this office sells (office prices)"
      : "Products this office carries (ordering not open yet)",
    keywords: [],
    load: () => text,
  };
}
