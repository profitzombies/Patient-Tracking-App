/**
 * Live model check for data-driven coach product suggestions (rerunnable).
 *
 * Runs the REAL coach system prompt against the real model for three staged
 * turns and checks the reply shape the route relies on:
 *
 *   1. signal offer (low protein → Creatine+ at the office price): the model
 *      emits exactly one [[product:ID]] marker, for the OFFERED id, names the
 *      product, explains why in plain text, uses no dashes, spells THINNR;
 *   2. bloodwork provider nudge (glucose flagged high → Regulate, content not
 *      marked as covering it): if a marker appears it is the offered id and
 *      the text defers to the provider; it never claims to treat the result;
 *   3. plain program question with no offers: no marker at all.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx scripts/coach-product-suggestion-live-check.ts
 */
import { openai } from "@workspace/integrations-openai-ai-server";
import { MarkerFilter } from "../src/coach/markers";
import { buildSystemPrompt } from "../src/coach/prompt";
import type { PublicLinkProduct } from "../src/billing/types";
import { loadProductCatalog } from "../src/coach/products";
import { offerProductsFromOffering, type ProductOffer } from "../src/coach/product-suggestions";
import { selectCompartments } from "../src/coach/select";
import { DEMO_PRODUCT_COMPARTMENT_ID } from "../src/coach/compartments";
import { liveStorefrontCompartment } from "../src/coach/products";

const patient = { firstName: "Riley", programDay: 24, phaseName: "Fat Burning" };

// Live offers ride the office's storefront identity: uuid product ids (the
// marker ids the model must echo back) and HQ copy. The bundled catalog only
// lends its curated copy to this staged offering.
const LIVE_IDS: Record<string, string> = {
  "creatine-plus": "3f9c2b1a-7d4e-4c6b-8a1f-0000000000c7",
  regulate: "3f9c2b1a-7d4e-4c6b-8a1f-0000000000c2",
};
function offeringRow(slug: string): PublicLinkProduct {
  const bundled = loadProductCatalog().find((p) => p.slug === slug)!;
  return {
    product_id: LIVE_IDS[slug], slug, name: bundled.name, description: bundled.description,
    category: bundled.category, tagline: bundled.tagline, format: bundled.format, benefits: [], how_to_take: "", facts_title: "", facts: [], faqs: [], disclaimer: "",
    image_url: null, image_urls: [], unit_price_cents: 4550, office_priced: true, subscription_available: true,
    subscription_cadences_weeks: [4], default_cadence_weeks: 4, subscribe_save_percent: 10, subscription_unit_price_cents: 4095,
  };
}
const bySlug = (slug: string) => offerProductsFromOffering([offeringRow(slug)], new Map())[0];

function offer(slug: string, reason: ProductOffer["reasons"][number], extra: Partial<ProductOffer> = {}): ProductOffer {
  return {
    product: bySlug(slug),
    source: "signal",
    reasons: [reason],
    providerNudge: false,
    rule: { signals: [reason.id], avoid_signals: [], phrasing: "", bloodwork_covered: false, topics: [] },
    pricing: { productId: LIVE_IDS[slug], priceCents: 4550, available: true, subscriptionAvailable: true, subscriptionPriceCents: 4095 },
    ...extra,
  };
}

/** Mirrors the route for a REAL account: the bundled demo catalog compartment is swapped for the office's live storefront. */
function realAccountCompartments(question: string, storefront: PublicLinkProduct[], available: boolean) {
  const selection = selectCompartments(question, []);
  let compartments = selection.compartments.filter((c) => c.id !== DEMO_PRODUCT_COMPARTMENT_ID);
  if (compartments.length === 0) compartments = selectCompartments("", []).compartments;
  if (!selection.ids.includes(DEMO_PRODUCT_COMPARTMENT_ID)) return compartments;
  const live = liveStorefrontCompartment(storefront, available);
  return live ? [live, ...compartments].slice(0, 3) : compartments;
}

async function ask(question: string, offers: ProductOffer[], storefront: PublicLinkProduct[] = []): Promise<{ text: string; ids: string[] }> {
  const compartments = realAccountCompartments(question, storefront, true);
  const completion = await openai.chat.completions.create({
    model: "gpt-5.6-terra",
    max_completion_tokens: 8192,
    messages: [
      { role: "system", content: buildSystemPrompt(compartments, patient, offers) },
      { role: "user", content: question },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "";
  const filter = new MarkerFilter(["product", "replies"]);
  const text = filter.push(raw) + filter.flush();
  return { text, ids: filter.idsFor("product") };
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`✓ ${label}`);
  else { failures += 1; console.error(`✗ ${label}${detail ? `: ${detail}` : ""}`); }
}
const DASH = /[—–]|\s-\s|--/;

async function main() {
  const creatine = bySlug("creatine-plus");
  const regulate = bySlug("regulate");

  console.log("\n1. signal offer (low protein → Creatine+)");
  const one = await ask(
    "I keep coming in way under my protein target and I can feel it in my workouts. What can I do?",
    [offer("creatine-plus", { id: "low_protein", detail: "Protein averaged 58 g on logged days this week against a 120 g target." }, {
      rule: { signals: ["low_protein"], avoid_signals: [], phrasing: "Frame it as protecting lean mass while the weight comes off.", bloodwork_covered: false },
    })],
  );
  console.log(one.text, "\n", one.ids);
  check("exactly one product marker, for the offered id", one.ids.length === 1 && one.ids[0] === creatine.id, JSON.stringify(one.ids));
  check("names the product in the reply text", one.text.includes(creatine.name));
  check("gives a reason tied to the patient's data (protein or muscle)", /protein|muscle|lean|strength/i.test(one.text));
  check("no dashes", !DASH.test(one.text));
  check("brand spelled THINNR", !/THINNER|Thinner\b/.test(one.text));
  check("marker stripped from visible text", !one.text.includes("[[product"));

  console.log("\n2. bloodwork provider nudge (glucose high → Regulate)");
  const two = await ask(
    "Just uploaded my labs from last week. Anything I should be thinking about?",
    [offer("regulate", { id: "bloodwork_glucose_high", detail: "Bloodwork your care team reviewed shows Glucose flagged high on the lab report." }, { providerNudge: true })],
  );
  console.log(two.text, "\n", two.ids);
  check("any marker is the offered id only", two.ids.every((id) => id === regulate.id) && two.ids.length <= 1, JSON.stringify(two.ids));
  check("defers to the provider or care team", /provider|care team|clinician|doctor/i.test(two.text));
  check("never claims to treat, fix, or lower the lab result", !/\b(treats?|fix(es)?|cures?|lowers?|normali[sz]es?)\b[^.]{0,40}\b(glucose|sugar|a1c|lab|result)/i.test(two.text));
  check("no dashes", !DASH.test(two.text));

  console.log("\n3. plain program question, nothing offered");
  const three = await ask("Can I have grapefruit during the fat burning phase?", []);
  console.log(three.text, "\n", three.ids);
  check("no marker without an offer", three.ids.length === 0);
  check("no product ids leak into text", !/\[\[|prod\d/.test(three.text));

  console.log("\n4. product keyword question grounded in the office storefront (no demo copy)");
  const four = await ask(
    "What is in the THINNR creatine and how much does it cost?",
    [{ ...offer("creatine-plus", { id: "low_protein", detail: "" }), source: "conversation", reasons: [], rule: null }],
    [offeringRow("creatine-plus")],
  );
  console.log(four.text, "\n", four.ids);
  check("quotes the office price, not a demo price", four.text.includes("45.50") || four.text.includes("$45") , four.text.slice(0, 200));
  check("does not mention demo pricing", !/demo/i.test(four.text));
  check("any marker is the offered id only", four.ids.every((id) => id === creatine.id) && four.ids.length <= 1, JSON.stringify(four.ids));
  check("no dashes", !DASH.test(four.text));

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
