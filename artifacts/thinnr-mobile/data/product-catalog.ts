/**
 * Typed access to the curated THINNR product catalog.
 *
 * product-catalog.json is the single source of truth shared with the API
 * server, which reads the same file from the repo at runtime for coach
 * grounding and product-card enforcement. Content is quoted verbatim from
 * getthinnr.com product pages; prices are demo values consistent with the
 * staff operations dataset.
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
  /** Demo pricing — getthinnr.com sells through licensed providers. */
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
}

export const PRODUCT_CATALOG: CatalogProduct[] = (
  catalogJson as { products: CatalogProduct[] }
).products;

export function findCatalogProduct(id: string): CatalogProduct | undefined {
  return PRODUCT_CATALOG.find(product => product.id === id);
}
