/**
 * Route tests for smart meal-slot defaults in POST /api/coach/chat.
 *
 * A card's "Add to Diary" preview preselects its diary slot; these tests pin
 * the resolution order end to end. Recipe turns: an explicit `mealSlot` pin
 * wins outright, then a meal the patient NAMES (the prompt instructs the
 * model to honor it), then the default derived from the client's
 * `localTime`. Meal-photo turns are image-only calls — the patient cannot
 * name a meal there — so the ladder is pin, then clock (deterministically
 * enforced over the model's visual guess), then the model's guess only for
 * old clients. Cravings keep their snacks default whatever the clock says,
 * and clients that send nothing keep the legacy fallbacks.
 *
 * The OpenAI client is mocked (no credits spent) with per-call programmed
 * answers, and every request uses a fresh client IP so per-IP rate buckets
 * never interfere (this file sends more image turns than one IP's vision
 * burst allows). Times are fixed strings in the request body — the real
 * clock is never read.
 */
import { beforeEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: vi.fn() } },
    images: { generate: vi.fn() },
  },
}));

import { openai } from "@workspace/integrations-openai-ai-server";
import { APPROVED_CATALOG } from "../coach/approved-catalog";
import app from "../app";

const createMock = vi.mocked(openai.chat.completions.create);

function completionOf(payload: unknown) {
  return {
    choices: [{ message: { content: JSON.stringify(payload) } }],
  } as never;
}

let server: Server;
let baseUrl: string;
let ipCounter = 0;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  createMock.mockReset();
});

/** Distinct client IP per call so per-IP buckets never interfere. */
function nextIp(): string {
  ipCounter += 1;
  return `10.77.${Math.floor(ipCounter / 200)}.${(ipCounter % 200) + 1}`;
}

async function postChat(body: unknown) {
  return fetch(`${baseUrl}/api/coach/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": nextIp(),
    },
    body: JSON.stringify(body),
  });
}

/** Parses every SSE data event in the raw stream body. */
function sseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

/** The system prompt the mocked model saw on call `index`. */
function systemPromptOfCall(index: number): string {
  const call = createMock.mock.calls[index]?.[0] as
    | { messages: Array<{ role: string; content: unknown }> }
    | undefined;
  const content = call?.messages[0]?.content;
  return typeof content === "string" ? content : "";
}

function cardPayloadOf(events: Array<Record<string, unknown>>): { meal?: string } {
  const card = events.find((e) => e.card)?.card as { payload?: { meal?: string } } | undefined;
  expect(card).toBeDefined();
  return card?.payload ?? {};
}

// ── Meal-photo fixtures ──────────────────────────────────────────────────────

const VALID_IMAGE = "data:image/jpeg;base64,dGVzdA==";
const MEAL_TEXT = "I sent a photo of my meal.";

/** photoKind "meal" skips triage — exactly one vision call per turn. */
function mealBody(extra: Record<string, unknown> = {}) {
  return {
    messages: [{ role: "user", content: MEAL_TEXT, image: VALID_IMAGE, photoKind: "meal" }],
    ...extra,
  };
}

/** Scan answer that names no slot — the resolution ladder decides. */
const MEAL_NULL_MEAL = {
  result: "ok",
  message: "Nice light plate, real food and plenty of color.",
  mealName: "Turkey wrap with carrots",
  description: "A turkey wrap with a side of baby carrots.",
  meal: null,
  items: [
    { name: "turkey wrap", amount: 6, unit: "oz", nutrition: { calories: 320, protein: 28, carbs: 30, fat: 9 } },
    { name: "baby carrots", amount: 1, unit: "cup", nutrition: { calories: 50, protein: 1, carbs: 12, fat: 0 } },
  ],
};

// ── Recipe fixtures ──────────────────────────────────────────────────────────

const dinnerRecipe = {
  name: "Seared Steak Plate",
  description: "Seared sirloin with roasted vegetables and herbs.",
  meal: "dinner",
  minutes: 25,
  servings: 1,
  calories: 420,
  protein: 38,
  carbs: 18,
  fat: 22,
  ingredients: [
    // Contribution to ONE serving; sums match the per-serving totals exactly.
    { amount: 6, unit: "oz", name: "sirloin steak", nutrition: { calories: 230, protein: 25, carbs: 0, fat: 14 } },
    { amount: 2, unit: "cups", name: "roasted vegetables", nutrition: { calories: 190, protein: 13, carbs: 18, fat: 8 } },
  ],
  steps: ["Sear the steak.", "Roast the vegetables and plate."],
};

describe("meal-photo slot defaults", () => {
  it("preselects lunch for a 14:05 photo when the scan names no slot", async () => {
    createMock.mockResolvedValueOnce(completionOf(MEAL_NULL_MEAL));

    const res = await postChat(mealBody({ localTime: "14:05" }));
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    expect(createMock).toHaveBeenCalledTimes(1);
    const prompt = systemPromptOfCall(0);
    expect(prompt).toContain('answer exactly "lunch"');
    expect(prompt).toContain("14:05");

    expect(cardPayloadOf(events).meal).toBe("lunch");
    expect(events.at(-1)).toEqual({ done: true });
  });

  it("maps morning, evening, and late-night clocks onto their bands", async () => {
    const table: Array<[string, string]> = [
      ["08:10", "breakfast"],
      ["19:30", "dinner"],
      ["23:15", "snacks"],
    ];
    for (const [localTime, expected] of table) {
      createMock.mockReset();
      createMock.mockResolvedValueOnce(completionOf(MEAL_NULL_MEAL));

      const res = await postChat(mealBody({ localTime }));
      expect(res.status).toBe(200);
      const events = sseEvents(await res.text());

      expect(systemPromptOfCall(0)).toContain(`answer exactly "${expected}"`);
      expect(cardPayloadOf(events).meal, localTime).toBe(expected);
    }
  });

  it("lets the clock beat a conflicting model guess — photos carry no words", async () => {
    createMock.mockResolvedValueOnce(completionOf({ ...MEAL_NULL_MEAL, meal: "dinner" }));

    const res = await postChat(mealBody({ localTime: "14:05" }));
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    // A dinner-looking plate photographed at 14:05 still files under lunch:
    // the patient had no way to name a meal on this turn, so the model's
    // "dinner" is only a guess about the food and must not win.
    expect(cardPayloadOf(events).meal).toBe("lunch");
  });

  it("still trusts the model's guess when no local time is sent (old clients)", async () => {
    createMock.mockResolvedValueOnce(completionOf({ ...MEAL_NULL_MEAL, meal: "dinner" }));

    const res = await postChat(mealBody());
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    expect(cardPayloadOf(events).meal).toBe("dinner");
  });

  it("lets an explicit pin beat both the model's answer and the clock", async () => {
    createMock.mockResolvedValueOnce(completionOf({ ...MEAL_NULL_MEAL, meal: "lunch" }));

    const res = await postChat(mealBody({ localTime: "14:05", mealSlot: "dinner" }));
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    expect(systemPromptOfCall(0)).toContain('answer exactly "dinner"');
    expect(cardPayloadOf(events).meal).toBe("dinner");
  });

  it("keeps the legacy lunch fallback when no local time is sent (old clients)", async () => {
    createMock.mockResolvedValueOnce(completionOf(MEAL_NULL_MEAL));

    const res = await postChat(mealBody());
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    expect(systemPromptOfCall(0)).toContain("the diary slot this most looks like");
    expect(cardPayloadOf(events).meal).toBe("lunch");
  });

  it("treats an in-length but unparseable local time exactly like an old client", async () => {
    createMock.mockResolvedValueOnce(completionOf(MEAL_NULL_MEAL));

    const res = await postChat(mealBody({ localTime: "99:99" }));
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    expect(systemPromptOfCall(0)).toContain("the diary slot this most looks like");
    expect(cardPayloadOf(events).meal).toBe("lunch");
  });
});

describe("recipe slot defaults", () => {
  it("honors a named meal over the clock: a steak idea for dinner at 14:05 stays dinner", async () => {
    createMock.mockResolvedValueOnce(
      completionOf({ reply: "Steak tonight sounds great.", recipe: dinnerRecipe }),
    );

    const res = await postChat({
      messages: [{ role: "user", content: "Give me a steak idea for dinner tonight" }],
      localTime: "14:05",
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    const prompt = systemPromptOfCall(0);
    // The prompt both offers the time default and tells the model a named
    // meal wins; the fixture plays a model that honored "for dinner".
    expect(prompt).toContain("when the patient names a meal for this dish");
    expect(prompt).toContain("the patient's clock reads 14:05");
    expect(prompt).toContain('set "meal" to "lunch"');

    expect(cardPayloadOf(events).meal).toBe("dinner");
    expect(events.at(-1)).toEqual({ done: true });
  });

  it("lets an explicit pin override even a model that chose another slot", async () => {
    createMock.mockResolvedValueOnce(
      completionOf({ reply: "Here is a hearty plate.", recipe: dinnerRecipe }),
    );

    const res = await postChat({
      messages: [{ role: "user", content: "Give me a dinner idea for tonight" }],
      localTime: "14:05",
      mealSlot: "breakfast",
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    expect(systemPromptOfCall(0)).toContain('set "meal" to "breakfast"');
    expect(cardPayloadOf(events).meal).toBe("breakfast");
  });

  it("keeps recipe-mode prompts free of time rules for old clients", async () => {
    createMock.mockResolvedValueOnce(
      completionOf({ reply: "Try this one.", recipe: dinnerRecipe }),
    );

    const res = await postChat({
      messages: [{ role: "user", content: "Give me a dinner idea for tonight" }],
    });
    expect(res.status).toBe(200);
    sseEvents(await res.text());

    const prompt = systemPromptOfCall(0);
    expect(prompt).toContain("pick the slot the dish naturally fits");
    expect(prompt).not.toContain("the patient's clock reads");
  });

  it("keeps cravings on snacks at 14:05 — the clock never applies there", async () => {
    const approvedA = APPROVED_CATALOG[0];
    const approvedB = APPROVED_CATALOG[1];
    const cravingsRecipe = {
      ...dinnerRecipe,
      name: "Approved Sweet Fix",
      meal: "snacks",
      ingredients: [
        { amount: 1, unit: "cup", name: approvedA.name.toLowerCase(), approvedItemId: approvedA.id, nutrition: { calories: 300, protein: 20, carbs: 10, fat: 12 } },
        { amount: 0.5, unit: "cup", name: approvedB.name.toLowerCase(), approvedItemId: approvedB.id, nutrition: { calories: 120, protein: 18, carbs: 8, fat: 10 } },
      ],
    };
    createMock.mockResolvedValueOnce(
      completionOf({ reply: "Let's fix that craving the right way.", recipe: cravingsRecipe }),
    );

    const res = await postChat({
      messages: [{ role: "user", content: "I'm craving chocolate cake" }],
      localTime: "14:05",
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    const prompt = systemPromptOfCall(0);
    expect(prompt).toContain("a craving is a snack whatever the clock says");
    expect(prompt).not.toContain("the patient's clock reads");

    expect(cardPayloadOf(events).meal).toBe("snacks");
  });

  it("pins an explicit slot on a cravings card too", async () => {
    const approvedA = APPROVED_CATALOG[0];
    const cravingsRecipe = {
      ...dinnerRecipe,
      name: "Approved Evening Fix",
      meal: "snacks",
      ingredients: [
        { amount: 1, unit: "cup", name: approvedA.name.toLowerCase(), approvedItemId: approvedA.id, nutrition: { calories: 420, protein: 38, carbs: 18, fat: 22 } },
      ],
    };
    createMock.mockResolvedValueOnce(
      completionOf({ reply: "Here is a fix that fits.", recipe: cravingsRecipe }),
    );

    const res = await postChat({
      messages: [{ role: "user", content: "I'm craving chocolate cake" }],
      mealSlot: "dinner",
    });
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());

    expect(systemPromptOfCall(0)).toContain('"meal" must be "dinner"');
    expect(cardPayloadOf(events).meal).toBe("dinner");
  });
});

describe("request validation", () => {
  it("rejects an unknown meal slot with 400", async () => {
    const res = await postChat({
      messages: [{ role: "user", content: "Hello" }],
      mealSlot: "brunch",
    });
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects an over-long localTime with 400 (schema bound)", async () => {
    const res = await postChat({
      messages: [{ role: "user", content: "Hello" }],
      localTime: "9:05 pm",
    });
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });
});
