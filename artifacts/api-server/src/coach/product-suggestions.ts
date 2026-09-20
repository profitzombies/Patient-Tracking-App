/**
 * Data-driven product offers for the coach model.
 *
 * `selectProductOffers` is the pure heart: given the catalog, HQ's per-product
 * suggestion rules, the patient's signals, the latest message, and the
 * suppression state, it decides which products the model may mention this
 * turn and why. Everything the route enforces afterwards (marker allow-list,
 * one card per reply) keys off the ids returned here — the model can never
 * widen the set.
 *
 * Offer sources, in priority order per product:
 *   - `conversation`: the latest message matched the product's intent topics
 *     (the original behaviour, still the only source for the demo persona);
 *   - `signal`: one of the patient's live signals is in the product's HQ
 *     rule. Bloodwork signals become provider nudges ("worth asking your
 *     provider about") unless HQ marked the product content as covering the
 *     marker.
 *
 * Suppression (real accounts only) runs BEFORE the model sees anything:
 *   - the patient asked the coach to stop suggesting products;
 *   - a contraindication flag in the product's `avoid_signals` is present;
 *   - the same product was suggested within the repeat window;
 *   - the patient bought it recently or holds an active subscription to it.
 */
import { isBloodworkSignal, type CoachSuggestionRule, type CoachSuggestionSignal, type PublicLinkProduct } from "../billing/types";
import { coachSuggestionRule, officeOffering } from "../billing/catalog";
import { selectMany, selectOne } from "../billing/store";
import { supabaseAdmin } from "../lib/supabase-admin";
import { loadProductCatalog, matchProducts, type OfferProduct } from "./products";
import { deriveSuggestionSignals, loadSuggestionFacts, type SuggestionSignal } from "./product-signals";
import type { PatientContext } from "./prompt";
import { BillingModeError, getBillingModeStatus } from "../billing/mode-state";
import { BillingConfigError } from "../billing/stripe-client";
import { currentBillingIdentity, runWithBillingIdentity } from "../billing/stripe-environment";

export const SUGGESTION_REPEAT_WINDOW_DAYS = 14;
export const RECENT_PURCHASE_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/** Live price and availability for one product at the patient's office. */
export interface ProductOfferPricing {
  productId: string;
  priceCents: number;
  available: boolean;
  subscriptionAvailable: boolean;
  subscriptionPriceCents: number | null;
}

export interface ProductOffer {
  product: OfferProduct;
  source: "conversation" | "signal";
  /** Signals that justified a `signal` offer (empty for conversation offers). */
  reasons: SuggestionSignal[];
  /** True when every reason is a bloodwork marker the product content does not cover. */
  providerNudge: boolean;
  rule: CoachSuggestionRule | null;
  /** Null for the demo persona (bundled demo price applies). */
  pricing: ProductOfferPricing | null;
}

export interface SuppressionState {
  optOut: boolean;
  /** Catalog slug → ISO timestamp of the last card for that product. */
  lastSuggested: Record<string, string>;
  /** Slugs bought within the purchase window or on an active subscription. */
  recentlyPurchased: Set<string>;
}

export const EMPTY_SUPPRESSION: SuppressionState = { optOut: false, lastSuggested: {}, recentlyPurchased: new Set() };

export interface SelectOffersInput {
  /** Products that may be offered: the bundled demo catalog, or the office's live offering. */
  catalog: OfferProduct[];
  /** HQ rules keyed by catalog slug; a missing slug means conversation-only (bundled topics). */
  rules: Map<string, CoachSuggestionRule>;
  signals: SuggestionSignal[];
  latestMessage: string;
  suppression: SuppressionState;
  /** Live pricing keyed by slug; null = demo persona (no suppression, bundled prices). */
  pricing: Map<string, ProductOfferPricing> | null;
  now: Date;
}

export interface SelectedOffers {
  offers: ProductOffer[];
  /** Products that matched but were held back, with the reason (for logs). */
  suppressed: Array<{ id: string; reason: "opt_out" | "contraindicated" | "repeat_window" | "recent_purchase" }>;
}

export function withinRepeatWindow(lastSuggestedIso: string | undefined, now: Date): boolean {
  if (!lastSuggestedIso) return false;
  const at = Date.parse(lastSuggestedIso);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at < SUGGESTION_REPEAT_WINDOW_DAYS * DAY_MS;
}

/** Demo persona: conversation matches against the bundled catalog, no live pricing or suppression. */
export function demoConversationOffers(latestMessage: string): ProductOffer[] {
  return matchProducts(latestMessage, loadProductCatalog()).map((product) => ({
    product, source: "conversation" as const, reasons: [], providerNudge: false, rule: null, pricing: null,
  }));
}

export function selectProductOffers(input: SelectOffersInput): SelectedOffers {
  const { catalog, rules, signals, latestMessage, suppression, pricing, now } = input;
  const live = pricing !== null;
  const conversationIds = new Set(matchProducts(latestMessage, catalog).map((p) => p.id));
  const signalIds = new Set(signals.map((s) => s.id));
  const offers: ProductOffer[] = [];
  const suppressed: SelectedOffers["suppressed"] = [];

  for (const product of catalog) {
    const rule = rules.get(product.slug) ?? null;
    const reasons = rule ? signals.filter((s) => rule.signals.includes(s.id)) : [];
    const byConversation = conversationIds.has(product.id);
    const bySignal = live && reasons.length > 0;
    if (!byConversation && !bySignal) continue;
    if (live) {
      if (suppression.optOut) { suppressed.push({ id: product.id, reason: "opt_out" }); continue; }
      if (rule && rule.avoid_signals.some((id) => signalIds.has(id))) { suppressed.push({ id: product.id, reason: "contraindicated" }); continue; }
      if (suppression.recentlyPurchased.has(product.slug)) { suppressed.push({ id: product.id, reason: "recent_purchase" }); continue; }
      if (withinRepeatWindow(suppression.lastSuggested[product.slug], now)) { suppressed.push({ id: product.id, reason: "repeat_window" }); continue; }
    }
    const priced = pricing?.get(product.slug) ?? null;
    // A real account whose office does not list the product gets no offer at
    // all: there is nothing to price and nothing to open.
    if (live && !priced) continue;
    const providerNudge =
      bySignal && !byConversation && reasons.every((r) => isBloodworkSignal(r.id)) && !(rule?.bloodwork_covered ?? false);
    offers.push({
      product,
      source: byConversation ? "conversation" : "signal",
      reasons: bySignal ? reasons : [],
      providerNudge,
      rule,
      pricing: priced,
    });
  }
  return { offers, suppressed };
}

/* ------------------------------ opt-out intent ----------------------------- */

const PRODUCT_WORDS = "(?:products?|supplements?|stuff|things|items|pitch(?:es|ing)?|upsell(?:s|ing)?)";
const STOP_RE = new RegExp(
  `\\b(?:stop|quit|no more|don'?t|do not|please don'?t|never|not)\\b[^.!?]{0,40}\\b(?:suggest|recommend|push|sell|pitch|offer|advertis|promot|upsell)\\w*\\b[^.!?]{0,30}\\b${PRODUCT_WORDS}\\b`,
  "i",
);
const STOP_ALT_RE = new RegExp(`\\b(?:no|no more|stop|enough|skip)(?: with)?(?: the)? ${PRODUCT_WORDS} (?:suggestions?|recommendations?|pitch(?:es)?|ads?|talk)\\b`, "i");
const RESUME_RE = new RegExp(
  `\\b(?:start|resume|go ahead and|you can|feel free to|ok(?:ay)? to|it'?s fine to|i'?d like|i would like|please)\\b[^.!?]{0,30}\\b(?:suggest|recommend|offer)\\w*\\b[^.!?]{0,30}\\b${PRODUCT_WORDS}\\b(?: again)?`,
  "i",
);
const RESUME_ALT_RE = new RegExp(`\\b(?:turn|switch) ${PRODUCT_WORDS} (?:suggestions?|recommendations?) (?:back )?on\\b`, "i");

/** What the latest message says about product suggestions, if anything. */
export function detectSuggestionPreference(message: string): "stop" | "resume" | null {
  const text = message.replace(/\s+/g, " ").trim();
  if (STOP_RE.test(text) || STOP_ALT_RE.test(text)) return "stop";
  if (RESUME_RE.test(text) || RESUME_ALT_RE.test(text)) return "resume";
  return null;
}

/* ------------------------------- live loading ------------------------------ */

const enc = encodeURIComponent;

export interface LiveSuggestionContext {
  offers: ProductOffer[];
  suppressed: SelectedOffers["suppressed"];
  signals: SuggestionSignal[];
  /** The patient's standing preference AFTER this message was applied. */
  optOut: boolean;
  /** Whether this message itself changed the preference. */
  preferenceChange: "stop" | "resume" | null;
  /**
   * The office's live offering and whether it can take orders. The route
   * swaps this in for the bundled product-catalog compartment so a real
   * account's prompt never carries demo copy or demo prices.
   */
  storefront: { offering: PublicLinkProduct[]; available: boolean };
}

/**
 * The office's live offering as offer products: identity, copy, and image
 * come from the HQ-edited storefront row, conversation topics from the HQ
 * rule. Nothing here reads the bundled demo catalog, so HQ-created products
 * are offerable and HQ edits reach the model and the card.
 */
export function offerProductsFromOffering(offering: PublicLinkProduct[], rules: Map<string, CoachSuggestionRule>): OfferProduct[] {
  return offering.map((item) => ({
    id: item.product_id,
    slug: item.slug,
    name: item.name,
    category: item.category,
    tagline: item.tagline,
    cardLine: item.tagline,
    description: item.description,
    format: item.format,
    price: item.unit_price_cents / 100,
    topics: rules.get(item.slug)?.topics ?? [],
    imageUrl: item.image_url,
  }));
}

function pricingFromOffering(offering: PublicLinkProduct[], available: boolean): Map<string, ProductOfferPricing> {
  return new Map(offering.map((item) => [item.slug, {
    productId: item.product_id,
    priceCents: item.unit_price_cents,
    available,
    subscriptionAvailable: available && item.subscription_available,
    subscriptionPriceCents: item.subscription_unit_price_cents,
  }]));
}

async function loadSuppression(patientId: string, providerId: string, now: Date): Promise<SuppressionState & { flagsRow: boolean }> {
  const since = new Date(now.getTime() - RECENT_PURCHASE_WINDOW_DAYS * DAY_MS).toISOString();
  const [flags, orders, subscriptions, products] = await Promise.all([
    supabaseAdmin("GET", `/rest/v1/patient_flags?patient_id=eq.${enc(patientId)}&select=coach_product_opt_out,coach_product_suggestions&limit=1`),
    selectMany("billing_orders", `patient_id=eq.${enc(patientId)}&status=eq.paid&paid_at=gte.${enc(since)}&select=id`),
    selectMany("billing_subscriptions", `patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(providerId)}&status=in.(active,past_due,trialing)&select=product_id`),
    selectMany("billing_products", "select=id,slug"),
  ]);
  if (flags.status >= 300 || !Array.isArray(flags.json)) throw new Error(`patient flags lookup failed (${flags.status})`);
  const slugById = new Map(products.map((p) => [p.id, p.slug]));
  const purchased = new Set<string>();
  for (const sub of subscriptions) {
    const slug = slugById.get(sub.product_id);
    if (slug) purchased.add(slug);
  }
  if (orders.length) {
    const items = await selectMany("billing_order_items", `order_id=in.(${orders.map((o) => enc(o.id)).join(",")})&select=product_id`);
    for (const item of items) {
      const slug = slugById.get(item.product_id);
      if (slug) purchased.add(slug);
    }
  }
  const row = (flags.json[0] ?? null) as { coach_product_opt_out?: unknown; coach_product_suggestions?: unknown } | null;
  const last = row?.coach_product_suggestions;
  return {
    flagsRow: row !== null,
    optOut: row?.coach_product_opt_out === true,
    lastSuggested: last && typeof last === "object" && !Array.isArray(last)
      ? Object.fromEntries(Object.entries(last as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
      : {},
    recentlyPurchased: purchased,
  };
}

/** Persist the patient's product-suggestion preference (opt out / back in). */
export async function saveSuggestionPreference(patientId: string, optOut: boolean): Promise<void> {
  const response = await supabaseAdmin(
    "POST",
    "/rest/v1/patient_flags?on_conflict=patient_id",
    [{ patient_id: patientId, coach_product_opt_out: optOut, updated_at: new Date().toISOString() }],
    "resolution=merge-duplicates,return=minimal",
  );
  if (response.status >= 300) throw new Error(`patient flags save failed (${response.status})`);
}

/** Stamp the product just carded so the repeat window starts now. */
export async function recordProductSuggested(patientId: string, slug: string, now: Date = new Date()): Promise<void> {
  const current = await supabaseAdmin("GET", `/rest/v1/patient_flags?patient_id=eq.${enc(patientId)}&select=coach_product_suggestions&limit=1`);
  const row = Array.isArray(current.json) ? (current.json[0] as { coach_product_suggestions?: unknown } | undefined) : undefined;
  const existing = row?.coach_product_suggestions && typeof row.coach_product_suggestions === "object" && !Array.isArray(row.coach_product_suggestions)
    ? (row.coach_product_suggestions as Record<string, unknown>)
    : {};
  const response = await supabaseAdmin(
    "POST",
    "/rest/v1/patient_flags?on_conflict=patient_id",
    [{ patient_id: patientId, coach_product_suggestions: { ...existing, [slug]: now.toISOString() }, updated_at: now.toISOString() }],
    "resolution=merge-duplicates,return=minimal",
  );
  if (response.status >= 300) throw new Error(`patient flags save failed (${response.status})`);
}

async function patientProviderId(patientId: string): Promise<string | null> {
  const response = await supabaseAdmin("GET", `/rest/v1/patients?id=eq.${enc(patientId)}&select=provider_id&limit=1`);
  if (response.status >= 300 || !Array.isArray(response.json)) throw new Error(`patient office lookup failed (${response.status})`);
  const value = (response.json[0] as { provider_id?: unknown } | undefined)?.provider_id;
  return typeof value === "string" && value ? value : null;
}

/**
 * Everything the coach route needs for a real patient's turn. Throws on any
 * upstream failure; the route logs and offers NOTHING for that turn — never
 * the demo prices.
 */
export async function loadLiveSuggestionContext(input: {
  patientId: string;
  /** The patient's office; looked up from the patients row when omitted. */
  providerId?: string | null;
  patient: PatientContext;
  latestMessage: string;
  now?: Date;
}): Promise<LiveSuggestionContext> {
  const now = input.now ?? new Date();
  const { patientId, patient, latestMessage } = input;
  const preferenceChange = detectSuggestionPreference(latestMessage);
  // A "stop suggesting products" request is the patient's standing choice:
  // persist it FIRST, on its own, before the office lookup and every other
  // health/billing/storefront read, so none of them failing this turn can
  // lose it.
  if (preferenceChange) await saveSuggestionPreference(patientId, preferenceChange === "stop");
  const providerId = input.providerId !== undefined ? input.providerId : await patientProviderId(patientId);
  let identity = currentBillingIdentity();
  try {
    identity ??= await getBillingModeStatus();
  } catch (error) {
    if (!(error instanceof BillingModeError || error instanceof BillingConfigError)) throw error;
    // Billing is optional to coaching. Never invent prices or offer a product
    // when this deployment cannot determine its payment identity.
    return { offers: [], suppressed: [], signals: [], optOut: preferenceChange === "stop", preferenceChange, storefront: { offering: [], available: false } };
  }
  return runWithBillingIdentity(identity, async () => {
  const [facts, suppression, rows, offering, account] = await Promise.all([
    loadSuggestionFacts(patientId, patient.today?.dateKey ?? now.toISOString().slice(0, 10), patient.programDay, {
      protein: patient.today?.targets.protein ?? 120,
      waterOz: patient.today?.targets.waterOz ?? 64,
    }, now),
    loadSuppression(patientId, providerId ?? "", now),
    selectMany("billing_products", "select=id,slug,coach_suggestion"),
    providerId ? officeOffering(providerId) : Promise.resolve([] as PublicLinkProduct[]),
    providerId ? selectOne("billing_connected_accounts", `provider_id=eq.${enc(providerId)}&disconnected_at=is.null`) : Promise.resolve(null),
  ]);
  // The persisted value above is authoritative for this turn even if the
  // flags read raced ahead of the write.
  const optOut = preferenceChange ? preferenceChange === "stop" : suppression.optOut;

  const signals = deriveSuggestionSignals(facts);
  const rules = new Map(rows.map((row) => [row.slug, coachSuggestionRule({ coach_suggestion: row.coach_suggestion })]));
  const available = Boolean(account && (account as { charges_enabled?: boolean }).charges_enabled) && offering.length > 0;
  const selected = selectProductOffers({
    catalog: offerProductsFromOffering(offering, rules),
    rules,
    signals,
    latestMessage,
    suppression: { ...suppression, optOut },
    pricing: pricingFromOffering(offering, available),
    now,
  });
  return { ...selected, signals, optOut, preferenceChange, storefront: { offering, available } };
  });
}
