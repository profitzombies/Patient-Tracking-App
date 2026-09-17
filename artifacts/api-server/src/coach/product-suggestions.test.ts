import { describe, expect, it } from "vitest";
import type { CoachSuggestionRule, PublicLinkProduct } from "../billing/types";
import { buildSystemPrompt, offeredProductId } from "./prompt";
import { loadProductCatalog, productCardPayload } from "./products";
import type { SuggestionSignal } from "./product-signals";
import {
  EMPTY_SUPPRESSION,
  SUGGESTION_REPEAT_WINDOW_DAYS,
  demoConversationOffers,
  detectSuggestionPreference,
  offerProductsFromOffering,
  selectProductOffers,
  withinRepeatWindow,
  type ProductOfferPricing,
  type SelectOffersInput,
} from "./product-suggestions";

const NOW = new Date("2026-09-17T15:00:00Z");
const catalog = loadProductCatalog();
const bySlug = (slug: string) => catalog.find((p) => p.slug === slug)!;

function rule(partial: Partial<CoachSuggestionRule>): CoachSuggestionRule {
  return { signals: [], avoid_signals: [], phrasing: "", bloodwork_covered: false, topics: [], ...partial };
}

const RULES = new Map<string, CoachSuggestionRule>([
  ["creatine-plus", rule({ signals: ["low_protein"], avoid_signals: ["bloodwork_kidney_flag"], phrasing: "Frame it as protecting lean mass." })],
  ["regulate", rule({ signals: ["bloodwork_glucose_high"], avoid_signals: ["diabetes_medication"] })],
  ["detox", rule({ signals: ["bloodwork_liver_high"], bloodwork_covered: true })],
  ["maintenance-stack", rule({ signals: ["program_complete", "weight_regain"] })],
]);

function livePricing(slugs: string[] = catalog.map((p) => p.slug), available = true): Map<string, ProductOfferPricing> {
  return new Map(slugs.map((slug, i) => [slug, {
    productId: `prod-${slug}`,
    priceCents: 4000 + i * 100,
    available,
    subscriptionAvailable: available,
    subscriptionPriceCents: 3600 + i * 100,
  }]));
}

const signal = (id: SuggestionSignal["id"], detail = `${id} detail.`): SuggestionSignal => ({ id, detail });

function select(overrides: Partial<SelectOffersInput>) {
  return selectProductOffers({
    catalog,
    rules: RULES,
    signals: [],
    latestMessage: "How is my week looking?",
    suppression: { ...EMPTY_SUPPRESSION, lastSuggested: {}, recentlyPurchased: new Set() },
    pricing: livePricing(),
    now: NOW,
    ...overrides,
  });
}

describe("selectProductOffers", () => {
  it("offers a product whose HQ rule matches a live signal, with the reason attached", () => {
    const { offers } = select({ signals: [signal("low_protein")] });
    expect(offers.map((o) => o.product.slug)).toEqual(["creatine-plus"]);
    expect(offers[0]).toMatchObject({ source: "signal", providerNudge: false, reasons: [{ id: "low_protein" }] });
    expect(offers[0].pricing?.priceCents).toBeGreaterThan(0);
    expect(offers[0].rule?.phrasing).toBe("Frame it as protecting lean mass.");
  });

  it("keeps conversation matches as offers and merges them with signal reasons", () => {
    const { offers } = select({ latestMessage: "Should I take creatine+ daily?", signals: [signal("low_protein")] });
    const creatine = offers.find((o) => o.product.slug === "creatine-plus");
    expect(creatine).toMatchObject({ source: "conversation", reasons: [{ id: "low_protein" }] });
  });

  it("never offers on signals for the demo persona (no pricing) but keeps topic matches", () => {
    const { offers } = select({ pricing: null, signals: [signal("low_protein"), signal("program_complete")] });
    expect(offers).toEqual([]);
    const demoTopic = select({ pricing: null, latestMessage: "I want to build muscle" });
    expect(demoTopic.offers.map((o) => o.product.slug)).toContain("creatine-plus");
    expect(demoTopic.offers.every((o) => o.pricing === null)).toBe(true);
  });

  it("turns uncovered bloodwork signals into provider nudges and covered ones into plain offers", () => {
    const { offers } = select({ signals: [signal("bloodwork_glucose_high"), signal("bloodwork_liver_high")] });
    const regulate = offers.find((o) => o.product.slug === "regulate");
    const detox = offers.find((o) => o.product.slug === "detox");
    expect(regulate?.providerNudge).toBe(true);
    expect(detox?.providerNudge).toBe(false);
    // A conversation match on the same product drops the nudge framing too.
    const asked = select({ latestMessage: "my blood sugar spikes after meals", signals: [signal("bloodwork_glucose_high")] });
    expect(asked.offers.find((o) => o.product.slug === "regulate")?.providerNudge).toBe(false);
  });

  it("suppresses everything when the patient opted out", () => {
    const result = select({
      signals: [signal("low_protein")],
      latestMessage: "I want to build muscle",
      suppression: { ...EMPTY_SUPPRESSION, optOut: true, lastSuggested: {}, recentlyPurchased: new Set() },
    });
    expect(result.offers).toEqual([]);
    expect(result.suppressed.map((s) => s.reason)).toEqual(expect.arrayContaining(["opt_out"]));
  });

  it("blocks contraindicated products even when the patient asks about them", () => {
    const result = select({
      latestMessage: "Should I take creatine+ daily?",
      signals: [signal("low_protein"), signal("bloodwork_kidney_flag")],
    });
    expect(result.offers.map((o) => o.product.slug)).not.toContain("creatine-plus");
    expect(result.suppressed).toContainEqual({ id: bySlug("creatine-plus").id, reason: "contraindicated" });
  });

  it("holds back products suggested within the repeat window and re-offers after it", () => {
    const recent = new Date(NOW.getTime() - 2 * 86_400_000).toISOString();
    const held = select({ signals: [signal("low_protein")], suppression: { optOut: false, lastSuggested: { "creatine-plus": recent }, recentlyPurchased: new Set() } });
    expect(held.offers).toEqual([]);
    expect(held.suppressed).toContainEqual({ id: bySlug("creatine-plus").id, reason: "repeat_window" });

    const old = new Date(NOW.getTime() - (SUGGESTION_REPEAT_WINDOW_DAYS + 1) * 86_400_000).toISOString();
    const again = select({ signals: [signal("low_protein")], suppression: { optOut: false, lastSuggested: { "creatine-plus": old }, recentlyPurchased: new Set() } });
    expect(again.offers.map((o) => o.product.slug)).toEqual(["creatine-plus"]);
    expect(withinRepeatWindow("not a date", NOW)).toBe(false);
    expect(withinRepeatWindow(undefined, NOW)).toBe(false);
  });

  it("holds back products the patient just bought or subscribes to", () => {
    const result = select({
      signals: [signal("low_protein"), signal("program_complete")],
      suppression: { optOut: false, lastSuggested: {}, recentlyPurchased: new Set(["creatine-plus"]) },
    });
    expect(result.offers.map((o) => o.product.slug)).toEqual(["maintenance-stack"]);
    expect(result.suppressed).toContainEqual({ id: bySlug("creatine-plus").id, reason: "recent_purchase" });
  });

  it("offers nothing for a real account whose office does not list the product", () => {
    const result = select({ signals: [signal("low_protein")], pricing: livePricing(["regulate"]) });
    expect(result.offers).toEqual([]);
    expect(result.suppressed).toEqual([]);
  });

  it("keeps offering when ordering is closed, marking the pricing unavailable", () => {
    const { offers } = select({ signals: [signal("low_protein")], pricing: livePricing(undefined, false) });
    expect(offers[0].pricing).toMatchObject({ available: false, subscriptionAvailable: false });
  });
});

describe("detectSuggestionPreference", () => {
  it("recognises asks to stop and to resume product suggestions", () => {
    expect(detectSuggestionPreference("Please stop suggesting products to me")).toBe("stop");
    expect(detectSuggestionPreference("don't recommend any more supplements, thanks")).toBe("stop");
    expect(detectSuggestionPreference("No more product pitches.")).toBe("stop");
    expect(detectSuggestionPreference("you can suggest products again")).toBe("resume");
    expect(detectSuggestionPreference("turn product suggestions back on")).toBe("resume");
  });

  it("ignores ordinary messages that mention products", () => {
    expect(detectSuggestionPreference("Which product helps with cravings?")).toBeNull();
    expect(detectSuggestionPreference("I stopped taking the drops last week")).toBeNull();
    expect(detectSuggestionPreference("What should I eat today?")).toBeNull();
  });
});

describe("offerProductsFromOffering (live catalog)", () => {
  const offering = (over: Partial<PublicLinkProduct>): PublicLinkProduct => ({
    product_id: "6d1f0c0e-1111-4a5b-9c2d-000000000001", slug: "creatine-plus", name: "Creatine+ (HQ edited)", description: "HQ description.",
    category: "supplement", tagline: "HQ tagline.", format: "Powder, 30 servings.", benefits: [], how_to_take: "", facts_title: "", facts: [], faqs: [], disclaimer: "",
    image_url: "https://cdn.example/creatine.png", image_urls: [], unit_price_cents: 8999, office_priced: true, subscription_available: true,
    subscription_cadences_weeks: [4], default_cadence_weeks: 4, subscribe_save_percent: 10, subscription_unit_price_cents: 8099,
    ...over,
  });

  it("takes identity, copy, and image from the storefront row and topics from the HQ rule, never the bundled catalog", () => {
    const rules = new Map([["creatine-plus", rule({ topics: ["lifting", "gym"] })]]);
    const [product] = offerProductsFromOffering([offering({})], rules);
    expect(product).toMatchObject({
      id: "6d1f0c0e-1111-4a5b-9c2d-000000000001", slug: "creatine-plus", name: "Creatine+ (HQ edited)", cardLine: "HQ tagline.",
      description: "HQ description.", format: "Powder, 30 servings.", price: 89.99, topics: ["lifting", "gym"], imageUrl: "https://cdn.example/creatine.png",
    });
    expect(product.name).not.toBe(bySlug("creatine-plus").name);
  });

  it("lets an HQ-created product unknown to the bundled catalog be offered by signal and by conversation", () => {
    const row = offering({ product_id: "6d1f0c0e-2222-4a5b-9c2d-000000000002", slug: "sleep-support", name: "Sleep Support", tagline: "Wind down." });
    const rules = new Map([["sleep-support", rule({ signals: ["low_water"], topics: ["can't sleep", "sleep"] })]]);
    const live = offerProductsFromOffering([row], rules);
    const pricing = new Map([["sleep-support", { productId: row.product_id, priceCents: 8999, available: true, subscriptionAvailable: true, subscriptionPriceCents: 8099 }]]);
    const bySignal = selectProductOffers({ catalog: live, rules, signals: [signal("low_water")], latestMessage: "hi", suppression: EMPTY_SUPPRESSION, pricing, now: NOW });
    expect(bySignal.offers.map((o) => o.product.id)).toEqual([row.product_id]);
    const byTopic = selectProductOffers({ catalog: live, rules, signals: [], latestMessage: "I can't sleep lately", suppression: EMPTY_SUPPRESSION, pricing, now: NOW });
    expect(byTopic.offers[0]).toMatchObject({ source: "conversation", product: { name: "Sleep Support" } });
    const payload = productCardPayload(byTopic.offers[0].product, byTopic.offers[0].pricing, "conversation");
    expect(payload).toMatchObject({ id: row.product_id, slug: "sleep-support", name: "Sleep Support", line: "Wind down.", imageUrl: "https://cdn.example/creatine.png", productId: row.product_id });
    expect(loadProductCatalog().some((p) => p.slug === "sleep-support")).toBe(false);
  });

  it("gives a live product with no HQ topics no conversation match at all", () => {
    const live = offerProductsFromOffering([offering({})], new Map());
    expect(live[0].topics).toEqual([]);
    const result = selectProductOffers({ catalog: live, rules: new Map(), signals: [], latestMessage: "Should I take creatine?", suppression: EMPTY_SUPPRESSION, pricing: livePricing(), now: NOW });
    expect(result.offers).toEqual([]);
  });

  it("keeps the demo persona on the bundled catalog with bundled ids and no pricing", () => {
    const offers = demoConversationOffers("Should I take creatine+ daily?");
    expect(offers.map((o) => o.product.id)).toEqual([bySlug("creatine-plus").id]);
    expect(offers[0]).toMatchObject({ source: "conversation", pricing: null, rule: null });
  });
});

describe("productCardPayload", () => {
  it("carries the office price, availability, and reason for a live offer", () => {
    const product = bySlug("creatine-plus");
    const payload = productCardPayload(product, { productId: "prod-x", priceCents: 4550, available: true, subscriptionAvailable: true }, "low_protein");
    expect(payload).toMatchObject({
      id: product.id,
      slug: "creatine-plus",
      name: product.name,
      price: 45.5,
      priceCents: 4550,
      productId: "prod-x",
      available: true,
      subscriptionAvailable: true,
      imageUrl: null,
      reason: "low_protein",
      cta: "Tap to open",
    });
  });

  it("keeps the bundled demo price with no live fields for the demo persona", () => {
    const product = bySlug("creatine-plus");
    expect(productCardPayload(product)).toMatchObject({ price: product.price, priceCents: null, productId: null, available: true, reason: "conversation" });
  });
});

describe("prompt product block", () => {
  const patient = { firstName: "Riley", programDay: 20, phaseName: "Fat Burning" };

  it("tells the model why each product is offered and how to phrase bloodwork nudges", () => {
    const { offers } = select({ signals: [signal("low_protein", "Protein averaged 60 g this week."), signal("bloodwork_glucose_high", "Uploaded bloodwork shows Glucose flagged high.")] });
    const prompt = buildSystemPrompt([], patient, offers, { suggestionsPaused: false });
    expect(prompt).toContain("Protein averaged 60 g this week.");
    expect(prompt).toContain("Frame it as protecting lean mass.");
    expect(prompt).toMatch(/worth asking their provider about/i);
    for (const offer of offers) expect(prompt).toContain(offeredProductId(offer));
    expect(prompt).toContain("at most one");
  });

  it("acknowledges a stop request and offers nothing on that turn", () => {
    const prompt = buildSystemPrompt([], patient, [], { suggestionsPaused: true });
    expect(prompt).toMatch(/paused|stop suggesting|no longer suggest/i);
    expect(prompt).not.toContain("[[product:");
  });
});
