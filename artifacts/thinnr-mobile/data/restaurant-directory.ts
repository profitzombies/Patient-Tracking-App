/**
 * Typed access to the THINNR Restaurant Guide content in
 * data/restaurant-guide.json.
 *
 * Every string exposed here as a quote — the guide tagline, the
 * Before-you-order rules, guidance section quotes, restaurant names, and
 * approved order lines — is quoted word-for-word from the official guide in
 * the docs archive (docs/thinnr-program/restaurant-guide.txt and the manual/
 * knowledge-base files). scripts/check-restaurant-guide-verbatim.mjs verifies
 * every quoted string against the archive, plus count and document-order
 * tripwires. Never edit quote text by hand — copy it from the archive and
 * re-run the check.
 */
import guide from './restaurant-guide.json';

export interface GuideQuote {
  /** Verbatim quoted question, when the source is a KB Q&A entry. */
  question?: string;
  /** Verbatim quoted lines. */
  lines: string[];
  /** Source attribution shown under the quote (app-authored). */
  source: string;
}

export interface GuideSection {
  key: string;
  title: string;
  quotes: GuideQuote[];
}

export interface Restaurant {
  /** Route id — app-authored slug of the verbatim name. */
  id: string;
  /** Verbatim restaurant name from the guide. */
  name: string;
  /** Verbatim approved order lines (menu item plus its modifications). */
  orders: string[];
}

interface RestaurantGuideData {
  sections: GuideSection[];
  beforeYouOrder: GuideSection;
  directory: {
    tagline: string;
    source: string;
    restaurants: Restaurant[];
  };
}

const data = guide as unknown as RestaurantGuideData;

/**
 * Full eating-out guidance in display order: the restaurant guide's
 * Before-you-order rules first, then the manual/knowledge-base sections.
 */
export const GUIDANCE_SECTIONS: GuideSection[] = [data.beforeYouOrder, ...data.sections];

/** Verbatim tagline from the restaurant guide's cover block. */
export const RESTAURANT_GUIDE_TAGLINE: string = data.directory.tagline;

/** Source attribution for directory content (app-authored). */
export const RESTAURANT_GUIDE_SOURCE: string = data.directory.source;

/** Restaurants in the document's order (Applebee’s → Zaxby’s). */
export const RESTAURANTS: Restaurant[] = data.directory.restaurants;

/** Looks up one restaurant by its route id; undefined for unknown ids. */
export function restaurantById(id: string | undefined): Restaurant | undefined {
  return id ? RESTAURANTS.find(r => r.id === id) : undefined;
}
