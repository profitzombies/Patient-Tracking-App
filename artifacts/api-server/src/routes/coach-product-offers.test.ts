/**
 * Route-level contract for data-driven product suggestions on REAL accounts:
 *
 *   - offers from the live suggestion context reach the model prompt with
 *     their reasons, and a card for an offered id carries the office price;
 *   - the model can only emit offered ids (unsolicited ids never card), and
 *     never more than one card per reply;
 *   - a stop request pauses suggestions for that turn (no product block);
 *   - a failing suggestion loader offers nothing but the chat still answers,
 *     never with demo prices;
 *   - a live card stamps the repeat window; the demo persona never does.
 *
 * The live loader itself (signals, rules, suppression) is unit-tested in
 * coach/product-suggestions.test.ts; here it is mocked so the route contract
 * can be exercised without a full billing schema behind the fake Supabase.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CONSENT_POLICY_VERSION } from "../privacy/consent";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

vi.hoisted(() => {
  process.env.SUPABASE_URL = "http://fake.supabase.local";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  process.env.COACH_CHAT_BURST = "100";
});

const modelState = vi.hoisted(() => ({
  chunks: ["Hello ", "there."],
  calls: [] as Array<{ stream: boolean; system: string }>,
}));

const liveState = vi.hoisted(() => ({
  /** When set, the route runs the REAL loader against the fake Supabase for one call. */
  useRealLoader: false,
  /** Supabase calls seen while the real loader ran, in order. */
  calls: [] as string[],
}));

const offerState = vi.hoisted(() => ({
  /** Slugs the live context offers this turn (with a low_protein reason). */
  offerSlugs: [] as string[],
  available: true,
  preferenceChange: null as "stop" | "resume" | null,
  fail: false,
  loadCalls: [] as Array<{ patientId: string; latestMessage: string }>,
  stamps: [] as Array<{ patientId: string; slug: string }>,
  /** Slugs in the office's live offering (grounding text); empty = office sells nothing. */
  offeringSlugs: [] as string[],
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(async (params: { stream?: boolean; messages: Array<{ role: string; content: unknown }> }) => {
          const system = params.messages
            .filter((m) => m.role === "system" && typeof m.content === "string")
            .map((m) => m.content as string)
            .join("\n\n");
          // The background safety screen is not part of the turn under test.
          if (system.includes("safety screen inside the THINNR")) return { choices: [{ message: { content: '{"concern":"none"}' } }] };
          modelState.calls.push({ stream: params.stream === true, system });
          if (params.stream === true) {
            return {
              async *[Symbol.asyncIterator]() {
                for (const content of modelState.chunks) yield { choices: [{ delta: { content } }] };
              },
            };
          }
          return { choices: [{ message: { content: "" } }] };
        }),
      },
    },
  },
}));

vi.mock("../coach/product-suggestions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../coach/product-suggestions")>();
  return {
    ...actual,
    loadLiveSuggestionContext: vi.fn(async (input: Parameters<typeof actual.loadLiveSuggestionContext>[0]) => {
      offerState.loadCalls.push({ patientId: input.patientId, latestMessage: input.latestMessage });
      if (liveState.useRealLoader) return actual.loadLiveSuggestionContext(input);
      if (offerState.fail) throw new Error("suggestion facts unavailable");
      const offers = offerState.offerSlugs.map((slug, i) => {
        // Live offers carry the office's storefront identity (uuid id, HQ
        // copy, HQ image), never the bundled demo catalog's.
        const product = {
          id: LIVE_IDS[slug], slug, name: `${slug} (office listing)`, category: "supplement", tagline: `HQ line for ${slug}.`,
          cardLine: `HQ line for ${slug}.`, description: `HQ description for ${slug}.`, format: "Capsules.", price: (4550 + i * 100) / 100,
          topics: [], imageUrl: `https://cdn.example/${slug}.png`,
        };
        return {
          product,
          source: "signal" as const,
          reasons: [{ id: "low_protein" as const, detail: `Protein averaged ${50 + i} g on logged days this week against a 120 g target.` }],
          providerNudge: false,
          rule: { signals: ["low_protein" as const], avoid_signals: [], phrasing: "Frame it as protecting lean mass.", bloodwork_covered: false },
          pricing: {
            productId: `prod-${slug}`,
            priceCents: 4550 + i * 100,
            available: offerState.available,
            subscriptionAvailable: offerState.available,
            subscriptionPriceCents: 4095,
          },
        };
      });
      return {
        offers,
        suppressed: [],
        signals: offers.flatMap((o) => o.reasons),
        optOut: offerState.preferenceChange === "stop",
        preferenceChange: offerState.preferenceChange,
        storefront: {
          available: offerState.available,
          offering: offerState.offeringSlugs.map((slug, i) => ({
            product_id: LIVE_IDS[slug], slug, name: `${slug} (office listing)`, tagline: `HQ line for ${slug}.`, format: "Capsules.",
            description: `HQ description for ${slug}.`, benefits: [`HQ benefit for ${slug}.`], how_to_take: "One daily.",
            facts_title: "Key Ingredients", facts: [{ name: "HQ ingredient", detail: "500 mg" }], disclaimer: "HQ disclaimer.",
            unit_price_cents: 4550 + i * 100, subscription_unit_price_cents: 4095,
          })),
        },
      };
    }),
    recordProductSuggested: vi.fn(async (patientId: string, slug: string) => {
      offerState.stamps.push({ patientId, slug });
    }),
  };
});

import app from "../app";
import { findProduct } from "../coach/products";

const PATIENT_ID = crypto.randomUUID();
const PATIENT_USER = crypto.randomUUID();
/** Storefront product ids for the live offers (uuids, like billing_products.id). */
const LIVE_IDS: Record<string, string> = {
  "creatine-plus": "0f6b8a1e-5c3d-4a2b-9e8f-000000000007",
  regulate: "0f6b8a1e-5c3d-4a2b-9e8f-000000000002",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function handleSupabase(url: URL, init?: RequestInit): Response {
  const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
  if (url.pathname === "/auth/v1/user") {
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /i, "");
    if (token !== "tok-patient") return json(401, { message: "invalid token" });
    return json(200, { id: PATIENT_USER, email: null, phone: null });
  }
  if (url.pathname === "/rest/v1/patient_flags") {
    liveState.calls.push(`${init?.method ?? "GET"} patient_flags`);
    return init?.method === "POST" ? json(201, null) : json(200, []);
  }
  if (url.pathname === "/rest/v1/patients") {
    if (url.searchParams.get("select") === "provider_id") {
      // The real loader's office lookup: the production path the route
      // takes (no providerId supplied). Fails to prove the preference write
      // landed before it.
      liveState.calls.push("GET patients.provider_id");
      return json(500, { message: "db down" });
    }
    if (url.searchParams.get("auth_user_id") === `eq.${PATIENT_USER}`) return json(200, [{ id: PATIENT_ID }]);
    if (url.searchParams.get("id") === `eq.${PATIENT_ID}`) {
      return json(200, [{ name: "Riley Chen", program_start_date: "2026-08-10", created_at: "2026-08-10T09:00:00Z" }]);
    }
    return json(200, []);
  }
  if (url.pathname === "/rest/v1/patient_consents") {
    return json(200, [{
      id: "consent-1", patient_id: PATIENT_ID, policy_version: CONSENT_POLICY_VERSION,
      terms_accepted: true, privacy_accepted: true, health_data_accepted: true, photo_analysis_accepted: true,
      app_version: null, platform: null, recorded_at: "2026-09-01T00:00:00Z",
    }]);
  }
  if (url.pathname === "/rest/v1/patient_diary_entries") return json(200, [{ calories: 300, protein: 30, carbs: 20, fat: 10 }]);
  if (url.pathname === "/rest/v1/patient_water_days") return json(200, [{ oz: 40 }]);
  if (url.pathname === "/rest/v1/patient_target_overrides") return json(200, []);
  return json(404, { message: `fake: no route ${url.pathname}` });
}

let server: Server;
let baseUrl: string;
const realFetch = globalThis.fetch.bind(globalThis);

beforeAll(async () => {
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.hostname === "fake.supabase.local") return Promise.resolve(handleSupabase(url, init));
    return realFetch(input as string, init);
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

afterEach(() => {
  modelState.chunks = ["Hello ", "there."];
  modelState.calls = [];
  offerState.offerSlugs = [];
  offerState.available = true;
  offerState.preferenceChange = null;
  offerState.fail = false;
  offerState.loadCalls = [];
  offerState.stamps = [];
  offerState.offeringSlugs = [];
  liveState.useRealLoader = false;
  liveState.calls = [];
});

function postChat(body: unknown, token?: string) {
  return realFetch(`${baseUrl}/api/coach/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

function sseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

const ask = (content: string) => ({ messages: [{ role: "user", content }], localDate: "2026-08-22" });
const creatine = findProduct("prod7")!;

describe("coach chat product offers for real accounts", () => {
  it("puts live offers with their reasons in the prompt and cards the offered id with the office price", async () => {
    offerState.offerSlugs = ["creatine-plus"];
    modelState.chunks = ["Your protein has been running low this week, Creatine+ can help you hold on to muscle.", `\n[[product:${LIVE_IDS["creatine-plus"]}]]`];
    const res = await postChat(ask("How am I doing this week?"), "tok-patient");
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    expect(offerState.loadCalls).toEqual([{ patientId: PATIENT_ID, latestMessage: "How am I doing this week?" }]);
    const system = modelState.calls[0].system;
    expect(system).toContain("Protein averaged 50 g on logged days this week");
    expect(system).toContain("Frame it as protecting lean mass.");
    expect(system).toContain("Price at their office: $45.50");
    // HQ's storefront copy reaches the model; the bundled demo copy does not.
    expect(system).toContain("creatine-plus (office listing)");
    expect(system).toContain("HQ description for creatine-plus.");
    expect(system).not.toContain(creatine.description);
    const cards = events.filter((e) => e.card);
    expect(cards).toHaveLength(1);
    expect(cards[0].card).toEqual({
      kind: "product",
      payload: {
        id: LIVE_IDS["creatine-plus"], slug: "creatine-plus", name: "creatine-plus (office listing)", line: "HQ line for creatine-plus.",
        price: 45.5, priceCents: 4550, productId: "prod-creatine-plus",
        available: true, subscriptionAvailable: true, imageUrl: "https://cdn.example/creatine-plus.png", reason: "low_protein", cta: "Tap to open",
      },
    });
    const text = events.filter((e) => typeof e.content === "string").map((e) => e.content).join("");
    expect(text).not.toContain("[[product");
    expect(events.at(-1)).toEqual({ done: true });
    expect(offerState.stamps).toEqual([{ patientId: PATIENT_ID, slug: "creatine-plus" }]);
  });

  it("drops unsolicited ids and never sends more than one card", async () => {
    offerState.offerSlugs = ["creatine-plus", "regulate"];
    // A bundled demo id (prod7) is NOT an offered id for a real account; the
    // model can only card the office's storefront ids it was shown.
    modelState.chunks = ["Two things.", "\n[[product:prod2]]", "\n[[product:prod7]]", `\n[[product:${LIVE_IDS.regulate}]]`, `\n[[product:${LIVE_IDS["creatine-plus"]}]]`];
    const events = sseEvents(await (await postChat(ask("What should I add?"), "tok-patient")).text());
    const cards = events.filter((e) => e.card);
    expect(cards).toHaveLength(1);
    // prod2 (Boost) was not offered and prod7 is only a demo id; the first OFFERED id wins.
    expect((cards[0].card as { payload: { id: string } }).payload.id).toBe(LIVE_IDS.regulate);
    expect(offerState.stamps.map((s) => s.slug)).toEqual(["regulate"]);
  });

  it("marks the card unavailable when the office cannot take orders, so the page opens informationally", async () => {
    offerState.offerSlugs = ["creatine-plus"];
    offerState.available = false;
    modelState.chunks = ["Worth a look.", `\n[[product:${LIVE_IDS["creatine-plus"]}]]`];
    const events = sseEvents(await (await postChat(ask("Anything for muscle?"), "tok-patient")).text());
    const payload = (events.find((e) => e.card)!.card as { payload: Record<string, unknown> }).payload;
    expect(payload).toMatchObject({ available: false, subscriptionAvailable: false, priceCents: 4550 });
    expect(modelState.calls[0].system).toContain("Ordering is not open at their office right now");
  });

  it("pauses suggestions on the turn the patient asks to stop", async () => {
    offerState.preferenceChange = "stop";
    modelState.chunks = ["Of course, no more product talk from me."];
    const events = sseEvents(await (await postChat(ask("Please stop suggesting products"), "tok-patient")).text());
    expect(modelState.calls[0].system).toContain("Product suggestions are paused");
    expect(modelState.calls[0].system).not.toContain("<product id=");
    expect(events.some((e) => e.card)).toBe(false);
  });

  it("keeps the stop request honored in the prompt when the live context fails after it", async () => {
    offerState.fail = true;
    offerState.preferenceChange = "stop";
    modelState.chunks = ["Understood, no more product talk from me."];
    const res = await postChat(ask("Please stop suggesting products"), "tok-patient");
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    expect(events.at(-1)).toEqual({ done: true });
    expect(modelState.calls[0].system).toContain("Product suggestions are paused");
    expect(modelState.calls[0].system).not.toContain("<product id=");
    expect(events.some((e) => e.card)).toBe(false);
  });

  it("writes the stop preference before the office lookup on the production loader path, and keeps the prompt paused when that lookup fails", async () => {
    liveState.useRealLoader = true;
    modelState.chunks = ["Understood, no more product talk from me."];
    const res = await postChat(ask("Please stop suggesting products to me"), "tok-patient");
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    expect(events.at(-1)).toEqual({ done: true });
    // The route supplied no providerId; the real loader persisted the choice
    // FIRST, then the office lookup failed and the loader rejected.
    expect(liveState.calls).toEqual(["POST patient_flags", "GET patients.provider_id"]);
    expect(modelState.calls[0].system).toContain("Product suggestions are paused");
    expect(modelState.calls[0].system).not.toContain("<product id=");
    expect(events.some((e) => e.card)).toBe(false);
    expect(offerState.stamps).toEqual([]);
  });

  it("answers without any offer when the suggestion context fails, never with demo prices", async () => {
    offerState.fail = true;
    modelState.chunks = ["Steady week.", `\n[[product:${creatine.id}]]`];
    const res = await postChat(ask("I want to build muscle"), "tok-patient");
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    expect(events.at(-1)).toEqual({ done: true });
    expect(modelState.calls[0].system).not.toContain("<product id=");
    expect(events.some((e) => e.card)).toBe(false);
    expect(offerState.stamps).toEqual([]);
  });

  // Product-keyword messages select the bundled `product-catalog` compartment
  // (demo copy, demo prices). A real account's prompt must never carry it.
  describe("product-keyword messages ground in the office storefront, never the bundled catalog", () => {
    const demoOnly = [creatine.description, "(demo pricing)", `Price: $${creatine.price}`];

    it("swaps in the office's own listing with office prices when it sells products", async () => {
      offerState.offerSlugs = ["creatine-plus"];
      offerState.offeringSlugs = ["creatine-plus", "regulate"];
      modelState.chunks = ["Creatine+ is one your office carries."];
      const res = await postChat(ask("Tell me about creatine and which supplement to buy"), "tok-patient");
      expect(res.status).toBe(200);
      const system = modelState.calls[0].system;
      expect(system).toContain('<source id="office-storefront" title="Products this office sells (office prices)">');
      expect(system).toContain("HQ description for creatine-plus.");
      expect(system).toContain("HQ description for regulate.");
      expect(system).toContain("Price at this office: $45.50 (subscribe: $40.95 per delivery)");
      expect(system).not.toContain('<source id="product-catalog"');
      for (const marker of demoOnly) expect(system).not.toContain(marker);
    });

    it("grounds copy without quoting a price when the office cannot take orders", async () => {
      offerState.offeringSlugs = ["creatine-plus"];
      offerState.available = false;
      modelState.chunks = ["Ask about it at your next visit."];
      await postChat(ask("Should I take creatine?"), "tok-patient");
      const system = modelState.calls[0].system;
      expect(system).toContain('title="Products this office carries (ordering not open yet)"');
      expect(system).toContain("HQ description for creatine-plus.");
      expect(system).toContain("Ordering is not open at this office yet");
      expect(system).not.toContain("Price at this office");
      expect(system).not.toContain('<source id="product-catalog"');
      for (const marker of demoOnly) expect(system).not.toContain(marker);
    });

    it("sends no product source at all when the office sells nothing", async () => {
      offerState.offeringSlugs = [];
      modelState.chunks = ["Your program covers this without a supplement."];
      await postChat(ask("Which supplement should I buy?"), "tok-patient");
      const system = modelState.calls[0].system;
      expect(system).not.toContain('<source id="office-storefront"');
      expect(system).not.toContain('<source id="product-catalog"');
      for (const marker of demoOnly) expect(system).not.toContain(marker);
      // Broad program context still grounds the turn.
      expect(system).toContain("<source id=");
    });

    it("drops the bundled catalog when the live lookup fails, and still answers", async () => {
      offerState.fail = true;
      modelState.chunks = ["Steady week.", `\n[[product:${creatine.id}]]`];
      const res = await postChat(ask("Is the THINNR creatine worth it?"), "tok-patient");
      expect(res.status).toBe(200);
      const events = sseEvents(await res.text());
      expect(events.at(-1)).toEqual({ done: true });
      const system = modelState.calls[0].system;
      expect(system).not.toContain('<source id="product-catalog"');
      expect(system).not.toContain('<source id="office-storefront"');
      expect(system).not.toContain("<product id=");
      for (const marker of demoOnly) expect(system).not.toContain(marker);
      expect(events.some((e) => e.card)).toBe(false);
    });

    it("keeps the bundled catalog for the demo persona", async () => {
      modelState.chunks = ["Creatine+ fits."];
      await postChat({ messages: [{ role: "user", content: "Tell me about creatine" }] });
      const system = modelState.calls[0].system;
      expect(system).toContain('<source id="product-catalog"');
      expect(system).toContain(creatine.description);
    });
  });

  it("keeps the demo persona on topic matches with bundled prices and no stamping", async () => {
    modelState.chunks = ["Creatine+ fits.", `\n[[product:${creatine.id}]]`];
    const events = sseEvents(await (await postChat({ messages: [{ role: "user", content: "I want to build muscle" }] })).text());
    expect(offerState.loadCalls).toEqual([]);
    const payload = (events.find((e) => e.card)!.card as { payload: Record<string, unknown> }).payload;
    expect(payload).toMatchObject({ id: creatine.id, price: creatine.price, priceCents: null, productId: null, available: true, reason: "conversation" });
    expect(offerState.stamps).toEqual([]);
  });
});
