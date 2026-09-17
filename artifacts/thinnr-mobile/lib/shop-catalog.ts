/**
 * Storefront helpers shared by the shop grid, product page, cart, and
 * checkout: resolving the product a route or coach card points at, picking
 * image sources, and the demo persona's storefront.
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
import type { CadenceWeeks, PatientShop, ProductFaq, PublicLinkProduct, ShippingAddress } from '@/lib/patient-billing-types';

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

/* ------------------------------ demo persona ------------------------------ */

export const DEMO_SHIPPING_CHARGE_CENTS = 1000;
export const DEMO_SUBSCRIBE_SAVE_PERCENT = 10;
const DEMO_CADENCES: CadenceWeeks[] = [4, 8, 12];

export const DEMO_SHIPPING_ADDRESS: ShippingAddress = {
  name: 'Demo Patient',
  line1: '100 Wellness Way',
  line2: null,
  city: 'Austin',
  state: 'TX',
  postal_code: '78701',
  country: 'US',
  phone: null,
};

/**
 * Demo FAQs cover how the SHOP works (shipping, subscriptions), plus the
 * catalog's own suggested-use text verbatim; program claims are never
 * paraphrased here. Real offices author their FAQs in HQ.
 */
function demoFaqs(suggestedUse: string, subscribable: boolean): ProductFaq[] {
  return [
    ...(suggestedUse ? [{ question: 'How do I take it?', answer: suggestedUse }] : []),
    ...(subscribable
      ? [{
          question: 'How does Subscribe & Save work?',
          answer: `Pick a delivery cadence and save ${DEMO_SUBSCRIBE_SAVE_PERCENT}% on every shipment. Renewals charge your saved card and ship on schedule; skip, move, or cancel anytime from Payments & orders.`,
        }]
      : []),
    { question: 'When will my order ship?', answer: 'Your office packs orders and records tracking when the box leaves. Tracking appears in Payments & orders.' },
  ];
}

function demoProduct(id: string): PublicLinkProduct | null {
  const row = findCatalogProduct(id);
  if (!row) return null;
  const unit = Math.round(row.price * 100);
  const subscribable = row.category !== 'bundle';
  const subscriptionUnit = Math.round(unit * (1 - DEMO_SUBSCRIBE_SAVE_PERCENT / 100));
  return {
    product_id: `demo-${row.slug}`,
    slug: row.slug,
    name: row.name,
    description: row.description,
    image_url: null,
    image_urls: [],
    category: row.category,
    tagline: row.tagline,
    format: row.format,
    benefits: row.benefits,
    how_to_take: row.suggestedUse ?? '',
    facts_title: row.factsTitle,
    facts: row.facts.map(fact => ({ name: fact.name, detail: fact.detail ?? null })),
    faqs: demoFaqs(row.suggestedUse ?? '', subscribable),
    disclaimer: row.disclaimer,
    unit_price_cents: unit,
    office_priced: true,
    subscription_available: subscribable,
    subscription_cadences_weeks: subscribable ? DEMO_CADENCES : [],
    default_cadence_weeks: 4,
    subscribe_save_percent: subscribable ? DEMO_SUBSCRIBE_SAVE_PERCENT : 0,
    subscription_unit_price_cents: subscribable ? subscriptionUnit : null,
  };
}

/** The guided demo's storefront: every bundled product, priced from the catalog. */
export function buildDemoShop(): PatientShop {
  return {
    office: { provider_id: 'demo', office_name: 'Jenkins Wellness', payments_available: true },
    available: true,
    unavailable_reason: null,
    products: PRODUCT_CATALOG.map(row => demoProduct(row.id)).filter((row): row is PublicLinkProduct => row !== null),
    shipping_charge_cents: DEMO_SHIPPING_CHARGE_CENTS,
    subscribe_save_percent: DEMO_SUBSCRIBE_SAVE_PERCENT,
    default_address: DEMO_SHIPPING_ADDRESS,
    stripe_account_id: null,
    publishable_key: null,
    sandbox: true,
    tax_enabled: false,
  };
}
