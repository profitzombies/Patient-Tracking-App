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

/** Products whose intent topics appear in the latest patient message. */
export function matchProducts(latestUserMessage: string): CatalogProduct[] {
  const haystack = normalizeForMatch(latestUserMessage);
  return loadProductCatalog().filter((product) =>
    product.topics.some((topic) => {
      const needle = normalizeForMatch(topic);
      return needle.trim().length > 0 && haystack.includes(needle);
    }),
  );
}

export function findProduct(id: string): CatalogProduct | undefined {
  return loadProductCatalog().find((product) => product.id === id);
}

/**
 * Payload for the SSE `card` event. Built entirely from the catalog — the
 * model only ever supplies the id. The client re-resolves the id against its
 * bundled copy of the same catalog for imagery and the product page.
 */
export function productCardPayload(product: CatalogProduct): {
  id: string;
  name: string;
  line: string;
  price: number;
} {
  return {
    id: product.id,
    name: product.name,
    line: product.cardLine,
    price: product.price,
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
