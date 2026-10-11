/**
 * Typed access to the curated THINNR product catalog.
 *
 * product-catalog.json is the single source of truth shared with the API
 * server, which reads the same file from the repo at runtime for coach
 * grounding and product-card enforcement. Content is quoted verbatim from
 * getthinnr.com product pages; prices are reference values — a real office
 * storefront prices from the live catalog.
 */
import catalogJson from './product-catalog.json';

export interface ProductFactRow {
  name: string;
  detail?: string;
}

export interface CatalogProduct {
  id: string;
  slug: string;
  name: string;
  category: 'drops' | 'supplement' | 'bundle';
  tagline: string;
  /** One-liner shown on the chat suggestion card. */
  cardLine: string;
  description: string;
  format: string;
  /** Reference pricing — getthinnr.com sells through licensed providers. */
  price: number;
  factsTitle: string;
  facts: ProductFactRow[];
  benefits: string[];
  suggestedUse?: string;
  disclaimer: string;
  sourceUrl: string;
  sourceNote: string;
  /** Intent keywords that make this product eligible for a chat suggestion. */
  topics: string[];
  /**
   * Bundled mirror of the HQ suggestion rule (which account signals may
   * prompt the coach to offer it). The live coach pipeline reads the
   * HQ-edited rule from the server; this copy documents the shipped defaults.
   */
  suggestion?: {
    signals: string[];
    avoid_signals: string[];
    phrasing: string;
    bloodwork_covered: boolean;
  };
}

export const PRODUCT_CATALOG: CatalogProduct[] = (
  catalogJson as { products: CatalogProduct[] }
).products;

export function findCatalogProduct(id: string): CatalogProduct | undefined {
  return PRODUCT_CATALOG.find(product => product.id === id);
}
