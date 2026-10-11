/**
 * Test fixture: a storefront built from the bundled product catalog so the
 * shop, cart, checkout, and coach-card suites can script a "real office"
 * response without a server. Not imported by app code.
 */
import { PRODUCT_CATALOG, findCatalogProduct } from '../../data/product-catalog';
import type { CadenceWeeks, PatientShop, ProductFaq, PublicLinkProduct, ShippingAddress } from '../../lib/patient-billing-types';
export const SAMPLE_SHIPPING_CHARGE_CENTS = 1000;
export const SAMPLE_SUBSCRIBE_SAVE_PERCENT = 10;
const SAMPLE_CADENCES: CadenceWeeks[] = [4, 8, 12];

export const SAMPLE_SHIPPING_ADDRESS: ShippingAddress = {
  name: 'Pat Example',
  line1: '100 Wellness Way',
  line2: null,
  city: 'Austin',
  state: 'TX',
  postal_code: '78701',
  country: 'US',
  phone: null,
};

/**
 * Sample FAQs cover how the SHOP works (shipping, subscriptions), plus the
 * catalog's own suggested-use text verbatim; program claims are never
 * paraphrased here. Real offices author their FAQs in HQ.
 */
function sampleFaqs(suggestedUse: string, subscribable: boolean): ProductFaq[] {
  return [
    ...(suggestedUse ? [{ question: 'How do I take it?', answer: suggestedUse }] : []),
    ...(subscribable
      ? [{
          question: 'How does Subscribe & Save work?',
          answer: `Pick a delivery cadence and save ${SAMPLE_SUBSCRIBE_SAVE_PERCENT}% on every shipment. Renewals charge your saved card and ship on schedule; skip, move, or cancel anytime from Payments & orders.`,
        }]
      : []),
    { question: 'When will my order ship?', answer: 'Your office packs orders and records tracking when the box leaves. Tracking appears in Payments & orders.' },
  ];
}

function sampleProduct(id: string): PublicLinkProduct | null {
  const row = findCatalogProduct(id);
  if (!row) return null;
  const unit = Math.round(row.price * 100);
  const subscribable = row.category !== 'bundle';
  const subscriptionUnit = Math.round(unit * (1 - SAMPLE_SUBSCRIBE_SAVE_PERCENT / 100));
  return {
    product_id: `sample-${row.slug}`,
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
    faqs: sampleFaqs(row.suggestedUse ?? '', subscribable),
    disclaimer: row.disclaimer,
    unit_price_cents: unit,
    office_priced: true,
    subscription_available: subscribable,
    subscription_cadences_weeks: subscribable ? SAMPLE_CADENCES : [],
    default_cadence_weeks: 4,
    subscribe_save_percent: subscribable ? SAMPLE_SUBSCRIBE_SAVE_PERCENT : 0,
    subscription_unit_price_cents: subscribable ? subscriptionUnit : null,
  };
}

/** A storefront fixture: every bundled product, priced from the catalog. */
export function buildSampleShop(): PatientShop {
  return {
    office: { provider_id: 'sample-office', office_name: 'Jenkins Wellness', payments_available: true },
    available: true,
    unavailable_reason: null,
    products: PRODUCT_CATALOG.map(row => sampleProduct(row.id)).filter((row): row is PublicLinkProduct => row !== null),
    shipping_charge_cents: SAMPLE_SHIPPING_CHARGE_CENTS,
    subscribe_save_percent: SAMPLE_SUBSCRIBE_SAVE_PERCENT,
    default_address: SAMPLE_SHIPPING_ADDRESS,
    stripe_account_id: null,
    publishable_key: null,
    sandbox: true,
    tax_enabled: false,
  };
}
