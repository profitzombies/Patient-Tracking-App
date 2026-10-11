/**
 * Storefront helpers shared by the shop grid, product page, cart, and
 * checkout: resolving the product a route or coach card points at, picking
 * image sources.
 *
 * The coach's product card and older deep links are keyed by the bundled
 * catalog id (prod1..prod9). The storefront rows the server sells are keyed
 * by UUID but carry the same catalog slug, so a lookup accepts any of
 * product_id, slug, or catalog id.
 */
import type { ImageSourcePropType } from 'react-native';
import { PRODUCT_CATALOG, findCatalogProduct } from '@/data/product-catalog';
import { PRODUCT_IMAGES } from '@/data/product-images';
import { configuredApiOrigin } from '@/lib/api-origin';
import type { PublicLinkProduct } from '@/lib/patient-billing-types';

/** Product images are served relative to the API origin (`/api/billing/public/product-images/:id`). */
export function absoluteProductImage(url: string | null): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url;
  try {
    return `${configuredApiOrigin()}${url.startsWith('/') ? '' : '/'}${url}`;
  } catch {
    return null;
  }
}

function bundledImage(product: Pick<PublicLinkProduct, 'slug' | 'product_id'>): ImageSourcePropType | null {
  const bySlug = PRODUCT_CATALOG.find(row => row.slug === product.slug || row.id === product.product_id);
  return bySlug ? PRODUCT_IMAGES[bySlug.id] ?? null : null;
}

/**
 * Gallery for a product page: HQ uploads in display order, or the bundled
 * catalog render when the office has uploaded none (the storefront still
 * needs a picture). Empty only for an unknown product with no images.
 */
export function productImageSources(product: PublicLinkProduct): ImageSourcePropType[] {
  const remote = (product.image_urls.length ? product.image_urls : product.image_url ? [product.image_url] : [])
    .map(absoluteProductImage)
    .filter((uri): uri is string => uri !== null)
    .map(uri => ({ uri }));
  if (remote.length) return remote;
  const bundled = bundledImage(product);
  return bundled ? [bundled] : [];
}

export function productThumbnail(product: PublicLinkProduct): ImageSourcePropType | null {
  return productImageSources(product)[0] ?? null;
}

/** Finds a storefront row by product_id, slug, or bundled catalog id. */
export function findShopProduct(products: PublicLinkProduct[], ref: string | undefined | null): PublicLinkProduct | undefined {
  if (!ref) return undefined;
  const direct = products.find(product => product.product_id === ref || product.slug === ref);
  if (direct) return direct;
  const catalog = findCatalogProduct(ref);
  return catalog ? products.find(product => product.slug === catalog.slug) : undefined;
}
